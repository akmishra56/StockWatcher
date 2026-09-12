/**
 * The contract every market data source adapter implements. Nothing
 * downstream (ingestPipeline, the indicator engine, the filter engine, the
 * frontend) depends on chokidar, CSV parsing, or NSE specifics directly --
 * only on this shape. See docs/architecture.md §2a.
 *
 * Today's implementation (datasource/nse/) adapts Playwright-scraped
 * watch-folder CSVs into this shape. A future broker-API adapter
 * (datasource/broker/) would implement the same interface and be swapped in
 * with a one-line config change -- ingestPipeline.js takes a
 * MarketDataSource instance as a constructor argument, never importing an
 * adapter directly.
 *
 * @typedef {object} NormalizedBar
 * @property {string} symbol
 * @property {string} ts_ist          scheduled cycle slot, IST 'YYYY-MM-DD HH:MM:SS'
 * @property {string} actual_ts_ist   when this bar was actually ingested, IST
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 * @property {string} sourceName      e.g. 'nse-csv' | 'broker-api'
 *
 * @typedef {object} CycleMeta
 * @property {string} scheduledTsIst
 * @property {string} actualTsIst
 * @property {string[]} fileNames
 */

/**
 * Base class documenting the contract. Adapters may extend it or just
 * duck-type the same shape -- ingestPipeline only calls these three methods.
 */
export class MarketDataSource {
  /**
   * Registers the callback invoked once per ingest cycle with a full,
   * merged set of normalized bars for that scheduled slot.
   * @param {(bars: NormalizedBar[], meta: CycleMeta) => void} callback
   */
  onCycle(callback) {
    throw new Error('MarketDataSource.onCycle must be implemented by the adapter');
  }

  /** Starts watching/polling/scheduling. */
  start() {
    throw new Error('MarketDataSource.start must be implemented by the adapter');
  }

  /** Stops cleanly (used in tests and graceful shutdown). */
  stop() {
    throw new Error('MarketDataSource.stop must be implemented by the adapter');
  }
}
