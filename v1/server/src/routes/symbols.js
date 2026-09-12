/**
 * GET /api/symbols -- a plain symbol list, optionally narrowed by
 * classification. Backs the Position Calculator's ticker autocomplete
 * (Dashboard tab).
 */
const CLASSIFICATION_COLUMN = {
  nifty500: 'is_nifty500', nifty50: 'is_nifty50', banknifty: 'is_banknifty',
  fno: 'is_fno_eligible', emerge: 'is_emerge',
};

export function registerSymbolsRoutes(app, ctx) {
  app.get('/api/symbols', async (req) => {
    const { db } = ctx;
    const column = CLASSIFICATION_COLUMN[req.query?.superFilter];
    const symbols = column ? await db.readSymbolsForClassification(column) : await db.readAllSymbols();
    return { symbols };
  });
}
