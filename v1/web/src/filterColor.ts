/**
 * A distinct, stable color per saved filter -- deterministic hash of the
 * filter's id (not creation order, which would shift colors around as
 * filters are added/removed) picked from a fixed palette. Shared between
 * FilterBar (tab accent, "matching now" chips, row-highlight color) and
 * MonitorLogPanel (the filter name in a membership-log line), so the same
 * filter always reads as the same color everywhere it appears.
 */
const FILTER_COLOR_PALETTE = [
  '#e0518f', '#4f9dde', '#57b894', '#e0a83e',
  '#9b7bd1', '#e0685a', '#4fb3bf', '#c98f4f',
];

export function colorForFilter(id: string | undefined | null): string {
  if (!id) return FILTER_COLOR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return FILTER_COLOR_PALETTE[hash % FILTER_COLOR_PALETTE.length];
}
