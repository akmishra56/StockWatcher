/**
 * POST /api/backfill/yahoo-history, GET /api/backfill/yahoo-history/:jobId
 * -- historical OHLCV backfill from Yahoo Finance for a date range this
 * app never itself ingested live. See jobs/backfillYahooHistory.js.
 */
import { randomUUID } from 'node:crypto';
import { startYahooBackfillJob, getBackfillJob } from '../jobs/backfillYahooHistory.js';

const CLASSIFICATION_COLUMN = {
  nifty50: 'is_nifty50', banknifty: 'is_banknifty', fno: 'is_fno_eligible',
  nifty500: 'is_nifty500', emerge: 'is_emerge',
};

export function registerBackfillRoutes(app, ctx) {
  app.post('/api/backfill/yahoo-history', async (req, reply) => {
    const { db } = ctx;
    const { universe = 'nifty500', fromDate = '2026-04-01', toDate } = req.body ?? {};

    let symbols;
    if (universe === 'all') {
      symbols = await db.readAllSymbols();
    } else {
      const column = CLASSIFICATION_COLUMN[universe];
      if (!column) {
        reply.code(400);
        return { error: `universe must be 'all' or one of: ${Object.keys(CLASSIFICATION_COLUMN).join(', ')}` };
      }
      symbols = await db.readSymbolsForClassification(column);
    }
    if (symbols.length === 0) {
      reply.code(400);
      return { error: `No symbols found for universe '${universe}' -- upload/derive that classification first` };
    }

    const jobId = randomUUID();
    startYahooBackfillJob(jobId, { db, symbols, fromDate, toDate });
    return { jobId, symbolCount: symbols.length, fromDate, toDate: toDate ?? null };
  });

  app.get('/api/backfill/yahoo-history/:jobId', async (req, reply) => {
    const job = getBackfillJob(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'unknown jobId' };
    }
    return job;
  });
}
