/**
 * The contract every broker-specific client implements. BrokerBridge.js is
 * the ONE generic orchestrator (polling cadence, universe iteration,
 * NormalizedBar assembly, start/stop) shared by every broker; a new broker
 * (Zerodha, Upstox, ...) is added by writing a new BrokerClient only --
 * never a new bridge. See datasource/broker/fyers/FyersClient.js for the
 * first concrete implementation and datasource/MarketDataSource.js for the
 * NormalizedBar shape this ultimately feeds.
 *
 * A broker client owns three concerns a CSV-scrape adapter doesn't have to:
 * per-broker auth/token lifecycle, a per-broker symbol format, and a
 * per-broker request-batching limit. Everything else (scheduling, DB
 * writes, indicator computation) is identical to the NSE path and lives
 * outside this contract.
 */
export class BrokerClient {
  /** Human-readable name, e.g. 'Fyers'. */
  get label() {
    throw new Error('BrokerClient.label must be implemented');
  }

  /**
   * True once this client holds a usable access token. BrokerBridge
   * awaits this before every poll cycle and skips the cycle (logging, not
   * throwing) rather than hammering the API with calls that will 401. May
   * be sync or async (BrokerBridge always awaits the result) -- a client
   * backed by on-disk credentials will typically need to be async.
   */
  isAuthenticated() {
    throw new Error('BrokerClient.isAuthenticated must be implemented');
  }

  /**
   * Fetches current quotes for a batch of plain NSE symbols (e.g.
   * 'RELIANCE', not the broker's own wire format) and returns them already
   * normalized to `{ symbol, open, high, low, close, volume }[]` -- the
   * broker-specific symbol mapping and response shape are fully hidden
   * behind this method. May throw; BrokerBridge catches and logs per-cycle
   * rather than crashing the schedule.
   * @param {string[]} symbols
   * @returns {Promise<{symbol: string, open: number, high: number, low: number, close: number, volume: number}[]>}
   */
  async getQuotes(symbols) {
    throw new Error('BrokerClient.getQuotes must be implemented');
  }

  /**
   * Maximum symbols this broker accepts in one getQuotes() call --
   * BrokerBridge chunks the universe into batches of this size. A broker
   * with no real limit (or one just doing its own internal chunking) can
   * return Infinity.
   * @returns {number}
   */
  get maxSymbolsPerRequest() {
    return Infinity;
  }
}
