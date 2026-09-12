/**
 * Fyers-specific BrokerClient implementation -- the FIRST concrete broker,
 * plugged into the generic BrokerBridge.js. All Fyers-specific knowledge
 * (auth flow, symbol format, endpoint shapes, batching limit) is isolated
 * here; nothing outside this file/fyersAuth.js knows Fyers exists.
 *
 * IMPORTANT -- unlike playwrightScraper.js (confirmed against the real NSE
 * site, see docs/researchOutput.md), this was built from Fyers' public
 * docs/community sample code via web research, with NO live account to
 * test against in this session. The endpoint paths, request/response
 * shapes, and the exact `/api/v3/...` vs `/api/v2/...` split below are
 * corroborated from multiple independent sources but NOT independently
 * confirmed live -- see docs/researchOutput.md's 2026-09-09 "Fyers API v3
 * endpoint/auth research" entry for exactly what is and isn't verified.
 * Expect to adjust field names/paths once a real Fyers App ID + Secret Key
 * exist and the first real call is made -- centralized here specifically
 * so that's a small, local fix, not a rewrite.
 *
 * Credentials + tokens are persisted via the standard settings table
 * (key 'fyers_credentials') -- already isolated per data-source connection
 * since each connection has its own DuckDB file (docs/architecture.md §2b),
 * so a Fyers connection's credentials never leak into another connection.
 */
import { createHash, randomUUID } from 'node:crypto';
import { BrokerClient } from '../BrokerClient.js';

const AUTH_BASE_URL = 'https://api.fyers.in/api/v3';
const DATA_BASE_URL = 'https://api.fyers.in/data-rest/v2';
const SETTINGS_KEY = 'fyers_credentials';

// Documented (support article, not independently re-verified): quotes
// accepts at most 50 symbols per call.
const MAX_SYMBOLS_PER_QUOTES_CALL = 50;

export class FyersClient extends BrokerClient {
  /** @param {{ db: import('../../../db/client.js').DbClient, nowIst: () => string }} deps */
  constructor({ db, nowIst }) {
    super();
    this.db = db;
    this.nowIst = nowIst;
  }

  get label() {
    return 'Fyers';
  }

  get maxSymbolsPerRequest() {
    return MAX_SYMBOLS_PER_QUOTES_CALL;
  }

  async _readCredentials() {
    return (await this.db.readSetting(SETTINGS_KEY)) ?? null;
  }

  async _writeCredentials(patch) {
    const current = (await this._readCredentials()) ?? {};
    const next = { ...current, ...patch };
    await this.db.writeSetting(SETTINGS_KEY, next, this.nowIst());
    return next;
  }

  async isAuthenticated() {
    const creds = await this._readCredentials();
    return Boolean(creds?.accessToken);
  }

  // ---- auth (app-registration + OAuth-style login, called from routes/broker.js) --

  /** Persists the App ID / Secret Key / Redirect URI the user creates at myapi.fyers.in. */
  async saveAppCredentials({ appId, secretKey, redirectUri }) {
    await this._writeCredentials({ appId, secretKey, redirectUri, accessToken: null, refreshToken: null });
  }

  /**
   * The URL to send the USER's own browser to -- they log in there
   * themselves (2FA/TOTP as configured on their own Fyers account); this
   * app never sees their Fyers password. Fyers redirects back to
   * `redirectUri` with an `auth_code` query param once they approve.
   */
  async getLoginUrl() {
    const creds = await this._readCredentials();
    if (!creds?.appId || !creds?.redirectUri) {
      throw new Error('Fyers App ID / Redirect URI not configured yet -- call saveAppCredentials first');
    }
    const state = randomUUID();
    await this._writeCredentials({ lastLoginState: state });
    const params = new URLSearchParams({
      client_id: creds.appId,
      redirect_uri: creds.redirectUri,
      response_type: 'code',
      state,
      scope: 'openid',
      nonce: randomUUID(),
    });
    return `${AUTH_BASE_URL}/generate-authcode?${params.toString()}`;
  }

  /** Exchanges the auth_code the user's browser was redirected back with for a real access token. */
  async exchangeAuthCode(authCode) {
    const creds = await this._readCredentials();
    if (!creds?.appId || !creds?.secretKey) {
      throw new Error('Fyers App ID / Secret Key not configured yet -- call saveAppCredentials first');
    }
    const appIdHash = createHash('sha256').update(`${creds.appId}:${creds.secretKey}`).digest('hex');

    const res = await fetch(`${AUTH_BASE_URL}/validate-authcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Fyers token exchange failed: ${res.status} ${JSON.stringify(body)}`);
    }

    await this._writeCredentials({
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      tokenObtainedAtIst: this.nowIst(),
    });
    return { ok: true };
  }

  // ---- market data --------------------------------------------------------

  /** @param {string[]} symbols plain NSE symbols, e.g. 'RELIANCE' (not 'NSE:RELIANCE-EQ') */
  async getQuotes(symbols) {
    const creds = await this._readCredentials();
    if (!creds?.accessToken) throw new Error('Fyers: not authenticated');

    const fyersSymbols = symbols.map(toFyersSymbol);
    const url = `${DATA_BASE_URL}/quotes/?symbols=${encodeURIComponent(fyersSymbols.join(','))}`;
    const res = await fetch(url, {
      headers: { Authorization: `${creds.appId}:${creds.accessToken}` },
    });
    const body = await res.json().catch(() => ({}));

    if (res.status === 401) {
      // Access token expired/invalid -- clear it so isAuthenticated() goes
      // false and the Settings UI can prompt a re-login, rather than
      // BrokerBridge silently retrying a call that will never succeed.
      await this._writeCredentials({ accessToken: null });
      throw new Error('Fyers: access token rejected (401) -- re-authentication required');
    }
    if (!res.ok || body.s !== 'ok') {
      throw new Error(`Fyers quotes request failed: ${res.status} ${JSON.stringify(body)}`);
    }

    const rows = Array.isArray(body.d) ? body.d : [];
    return rows
      .filter((row) => row.s === 'ok' && row.v)
      .map((row) => ({
        symbol: fromFyersSymbol(row.n),
        open: row.v.open_price,
        high: row.v.high_price,
        low: row.v.low_price,
        close: row.v.lp,
        volume: row.v.volume,
      }))
      .filter((bar) => [bar.open, bar.high, bar.low, bar.close, bar.volume].every((n) => typeof n === 'number' && Number.isFinite(n)));
  }
}

function toFyersSymbol(symbol) {
  return `NSE:${symbol}-EQ`;
}

function fromFyersSymbol(fyersSymbol) {
  return fyersSymbol.replace(/^NSE:/, '').replace(/-EQ$/, '');
}
