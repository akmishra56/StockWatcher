/**
 * Re-evaluates every saved filter against a fresh snapshot, scoped to the
 * active super filter, and diffs membership to produce log rows. A log row
 * is written only on transition (docs/state_diagrams.md §3) -- never on
 * every cycle a symbol continues to match.
 */
import { evaluateFilter, withDerivedFields } from './conditions.js';
import { appendMembershipLogFile } from '../logging/membershipLogFile.js';

export class FilterEngine {
  /**
   * @param {import('../db/client.js').DbClient} db
   * @param {() => object} getColorRules
   * @param {() => Map<string, boolean>} getClassification  symbol -> { is_nifty50, ... }
   * @param {string} [logsDir]  where filter_membership_log rows are also mirrored as plain text
   */
  constructor(db, getColorRules, getClassification, logsDir) {
    this.db = db;
    this.getColorRules = getColorRules ?? (() => ({}));
    this.getClassification = getClassification ?? (() => new Map());
    this.logsDir = logsDir ?? null;
    /** @type {Map<string, Set<string>>} filterId -> matching symbols */
    this.lastKnownMatches = new Map();
  }

  /** Called once at boot to rebuild lastKnownMatches without emitting log rows. */
  async hydrate(initialSnapshot) {
    const filters = await this.db.readActiveFilters();
    const superFilter = 'all';
    const previousMap = await this.db.readPreviousSnapshotMap();
    for (const filter of filters) {
      const tree = JSON.parse(filter.condition_json);
      const matches = new Set(
        this.applySuperFilter(initialSnapshot, superFilter)
          .filter((row) => evaluateFilter(withDerivedFields(row, this.getColorRules()), tree, previousMap.get(row.symbol)))
          .map((row) => row.symbol)
      );
      this.lastKnownMatches.set(filter.id, matches);
    }
  }

  applySuperFilter(snapshot, superFilter) {
    if (superFilter === 'all') return snapshot;
    const classification = this.getClassification();
    const key = { nifty50: 'is_nifty50', banknifty: 'is_banknifty', fno: 'is_fno_eligible', emerge: 'is_emerge', nifty500: 'is_nifty500' }[superFilter];
    if (!key) return snapshot;
    return snapshot.filter((row) => classification.get(row.symbol)?.[key]);
  }

  /**
   * @param {object[]} snapshot  rows from this cycle (already includes indicator outputs)
   * @param {string} superFilter
   * @returns {Promise<{ logRows: object[] }>}
   */
  async reevaluateAll(snapshot, superFilter) {
    const filters = await this.db.readActiveFilters();
    const scoped = this.applySuperFilter(snapshot, superFilter);
    const colorRules = this.getColorRules();
    const augmented = scoped.map((row) => withDerivedFields(row, colorRules));
    // The pipeline has already written this cycle's row into snapshot_window
    // by the time this runs (ingestPipeline.js), so each symbol's *previous*
    // tick is exactly rank 2 there -- what crosses_above/crosses_below needs.
    const previousMap = await this.db.readPreviousSnapshotMap();
    const logRows = [];
    const nowIst = snapshot[0]?.actual_ts_ist ?? new Date().toISOString();

    for (const filter of filters) {
      const tree = JSON.parse(filter.condition_json);
      const newMatches = new Set(
        augmented.filter((row) => evaluateFilter(row, tree, previousMap.get(row.symbol))).map((row) => row.symbol)
      );
      const previous = this.lastKnownMatches.get(filter.id) ?? new Set();

      for (const symbol of newMatches) {
        if (!previous.has(symbol)) logRows.push({ filterId: filter.id, filterName: filter.name, symbol, action: 'added', ts_ist: nowIst });
      }
      for (const symbol of previous) {
        if (!newMatches.has(symbol)) logRows.push({ filterId: filter.id, filterName: filter.name, symbol, action: 'removed', ts_ist: nowIst });
      }

      this.lastKnownMatches.set(filter.id, newMatches);
    }

    appendMembershipLogFile(this.logsDir, logRows);
    return { logRows };
  }
}
