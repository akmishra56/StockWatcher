/**
 * End-to-end test of the broker bridge: create a broker (Fyers) connection
 * via POST /api/data-connections, activate it, save app credentials,
 * exchange an auth code for an access token, then run one BrokerBridge
 * cycle and confirm the resulting bars flow through the exact same
 * ingest pipeline the CSV path uses (GET /api/snapshot reflects them).
 * global.fetch is faked (matching the request URLs FyersClient.js makes)
 * the same way other tests fake the Playwright scraper -- no real Fyers
 * account or network call involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTestEnv } from './helpers/testEnv.js';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('broker bridge: create Fyers connection, authenticate, one poll cycle ingests into the snapshot', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-broker-test-'));
  setTestEnv(dir);

  const { buildServer } = await import('../src/server.js?t=' + Date.now());
  const { app, ctx } = await buildServer();

  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/validate-authcode')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.grant_type, 'authorization_code');
      assert.equal(body.code, 'fake-auth-code');
      // appIdHash = sha256('test-app-id:test-secret') -- not re-verified here,
      // just confirming the field is present and non-empty.
      assert.ok(body.appIdHash && body.appIdHash.length === 64);
      return jsonResponse({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token' });
    }
    if (u.includes('/quotes/')) {
      const symbolsParam = new URL(u).searchParams.get('symbols');
      assert.equal(symbolsParam, 'NSE:RELIANCE-EQ,NSE:TCS-EQ');
      return jsonResponse({
        s: 'ok',
        d: [
          { n: 'NSE:RELIANCE-EQ', s: 'ok', v: { open_price: 1280, high_price: 1300, low_price: 1275, lp: 1290.5, volume: 123456 } },
          { n: 'NSE:TCS-EQ', s: 'ok', v: { open_price: 3900, high_price: 3950, low_price: 3890, lp: 3925.25, volume: 54321 } },
        ],
      });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };

  try {
    await app.ready();

    // 1. Create the broker connection (registers it, does not activate).
    const createRes = await app.inject({
      method: 'POST', url: '/api/data-connections',
      payload: { id: 'fyers-test', label: 'Fyers (test)', kind: 'broker', brokerType: 'fyers' },
    });
    assert.equal(createRes.statusCode, 200);

    // 2. Activate it.
    const activateRes = await app.inject({ method: 'POST', url: '/api/data-connections/fyers-test/activate' });
    assert.equal(activateRes.statusCode, 200);
    assert.equal(ctx.connectionId, 'fyers-test');
    assert.ok(ctx.brokerClient, 'ctx.brokerClient should be set for a broker connection');
    assert.equal(ctx.scheduler, null, 'ctx.scheduler (NSE-specific) should be null for a broker connection');

    // 3. Broker status before credentials: not a broker error, just not authenticated.
    const statusBefore = JSON.parse((await app.inject({ method: 'GET', url: '/api/broker/status' })).body);
    assert.equal(statusBefore.authenticated, false);

    // 4. Save app credentials.
    const credsRes = await app.inject({
      method: 'POST', url: '/api/broker/credentials',
      payload: { appId: 'test-app-id', secretKey: 'test-secret', redirectUri: 'https://example.com/callback' },
    });
    assert.equal(credsRes.statusCode, 200);

    // 5. Get the login URL (sanity check on shape, not a real redirect).
    const loginUrlRes = JSON.parse((await app.inject({ method: 'GET', url: '/api/broker/login-url' })).body);
    assert.match(loginUrlRes.url, /^https:\/\/api\.fyers\.in\/api\/v3\/generate-authcode\?/);
    assert.match(loginUrlRes.url, /client_id=test-app-id/);

    // 6. Exchange the (fake) auth code for an access token.
    const exchangeRes = JSON.parse((await app.inject({ method: 'POST', url: '/api/broker/exchange-code', payload: { authCode: 'fake-auth-code' } })).body);
    assert.equal(exchangeRes.ok, true);
    assert.equal(exchangeRes.authenticated, true);

    const statusAfter = JSON.parse((await app.inject({ method: 'GET', url: '/api/broker/status' })).body);
    assert.equal(statusAfter.authenticated, true);

    // 7. Seed the universe (BrokerBridge polls whatever's in `symbols`) and run one cycle directly.
    await ctx.db.ensureSymbols(['RELIANCE', 'TCS']);
    await ctx.adapter.runCycle('2026-09-09 10:00:00');

    // 8. The resulting bars flowed through the real ingest pipeline -- same as the CSV path.
    const snapshotRes = JSON.parse((await app.inject({ method: 'GET', url: '/api/snapshot' })).body);
    const reliance = snapshotRes.rows.find((r) => r.symbol === 'RELIANCE');
    const tcs = snapshotRes.rows.find((r) => r.symbol === 'TCS');
    assert.ok(reliance, 'RELIANCE should be in the snapshot after a broker cycle');
    assert.equal(reliance.close, 1290.5);
    assert.ok(tcs, 'TCS should be in the snapshot after a broker cycle');
    assert.equal(tcs.close, 3925.25);
  } finally {
    global.fetch = realFetch;
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- see docs/issues.md re: DuckDB file-handle release timing on Windows
    }
  }
});
