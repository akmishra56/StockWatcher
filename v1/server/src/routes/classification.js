/**
 * Index-membership uploads (Nifty 50 / BankNifty / F&O-eligible), which
 * drive the dashboard's super filter. docs/component_design.md §1
 * (classificationUpload.js) and §6 (REST contract).
 */
import { nowIst } from '../time.js';

const VALID_INDEX_TYPES = new Set(['nifty50', 'banknifty', 'fno', 'emerge', 'nifty500']);

/** GET /api/classification, POST /api/classification/:indexType/upload. */
export function registerClassificationRoutes(app, ctx) {
  app.get('/api/classification', async () => ctx.db.readClassificationStatus());

  app.post('/api/classification/:indexType/upload', async (req, reply) => {
    const { db, refreshClassification } = ctx;
    const { indexType } = req.params;
    if (!VALID_INDEX_TYPES.has(indexType)) {
      reply.code(400);
      return { error: `indexType must be one of: ${[...VALID_INDEX_TYPES].join(', ')}` };
    }

    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: 'A single CSV file field is required' };
    }
    const buffer = await file.toBuffer();
    const symbols = parseSymbolListCsv(buffer.toString('utf8'));
    if (symbols.length === 0) {
      reply.code(400);
      return { error: 'No symbols found in the uploaded file' };
    }

    await db.upsertSymbolClassification(indexType, symbols, file.filename, nowIst());
    await refreshClassification?.();

    return { ok: true, indexType, count: symbols.length };
  });
}

/**
 * A classification CSV is just a symbol list -- one column, header
 * optional. Also tolerates a full NSE market-watch export (many columns,
 * quoted fields e.g. "23,015.80") by only ever reading the first column and
 * stripping its quotes -- and drops any "symbol" containing a space (an
 * index summary row like "NIFTY 500", confirmed present in real NSE
 * exports, same generic signal used in scheduler.js), so a real multi-index
 * export can be uploaded here directly without hand-editing it first.
 */
function parseSymbolListCsv(raw) {
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstCell = stripQuotes(lines[0].split(',')[0]).toLowerCase();
  const dataLines = ['symbol', 'sym', 'ticker'].includes(firstCell) ? lines.slice(1) : lines;

  return dataLines
    .map((line) => stripQuotes(line.split(',')[0]).toUpperCase())
    .filter((symbol) => symbol && !symbol.includes(' '));
}

function stripQuotes(s) {
  return s.trim().replace(/^"|"$/g, '');
}
