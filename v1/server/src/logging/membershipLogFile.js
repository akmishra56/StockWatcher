/**
 * Plain-text mirror of filter_membership_log (the DB table -- see
 * db/client.js's writeMembershipLog) on disk, so filter membership
 * transitions have a durable, human-readable, greppable audit trail
 * alongside the DB and the live WS stream to the Dashboard's Membership Log
 * panel. One line per entry, tab-separated: ts_ist, action, symbol, filter id.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'membership_log.log';

/**
 * @param {string} logsDir
 * @param {{ filterId: string, symbol: string, action: string, ts_ist: string }[]} entries
 */
export function appendMembershipLogFile(logsDir, entries) {
  if (!logsDir || entries.length === 0) return;
  mkdirSync(logsDir, { recursive: true });
  const lines = entries.map((e) => `${e.ts_ist}\t${e.action.toUpperCase()}\t${e.symbol}\tfilter=${e.filterId}\n`).join('');
  appendFileSync(path.join(logsDir, FILE_NAME), lines);
}
