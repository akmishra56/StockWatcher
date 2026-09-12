/**
 * Flat AND/OR condition evaluation (v1 -- no nesting, see docs/component_design.md §3).
 * `field` resolves to a raw snapshot column or a semantic indicator-state
 * boolean (rsi.isOversold, supertrend.direction) computed from colorRules.
 */

const OPERATORS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/**
 * @param {object} row  a snapshot row, already augmented with derived
 *   booleans (rsi_isOversold, rsi_isOverbought) by the caller
 * @param {{ field: string, operator: string, value?: any, valueField?: string }} cond
 *   The right-hand side is either a literal `value` (the original v1 shape)
 *   or, when `valueField` is set, another field on the same row -- e.g.
 *   { field: 'close', operator: '<', valueField: 'bb_lower' } for "price
 *   below the Bollinger lower band". A row missing either side (indicator
 *   not yet primed) fails the condition rather than throwing.
 * @param {object|null} [previous]  the same symbol's immediately-prior
 *   snapshot row (from snapshot_window), required only by crosses_above/
 *   crosses_below. Omitted/null makes those always fail closed rather than
 *   throw -- there's no "crossed" without a prior tick to compare against
 *   (a symbol's first-ever row, or a caller that never looked one up).
 */
export function evaluateCondition(row, cond, previous) {
  if (cond.operator === 'crosses_above' || cond.operator === 'crosses_below') {
    return evaluateCross(row, previous, cond, cond.operator === 'crosses_above' ? 'above' : 'below');
  }

  const actual = resolveField(row, cond.field);
  if (actual === undefined || actual === null) return false;

  const target = cond.valueField ? resolveField(row, cond.valueField) : cond.value;
  if (target === undefined || target === null) return false;

  if (cond.operator === 'is') return actual === true || actual === target;

  const op = OPERATORS[cond.operator];
  if (!op) throw new Error(`Unknown operator: ${cond.operator}`);
  return op(actual, target);
}

/**
 * Edge-triggered "field crossed above/below value-or-field" -- true only on
 * the tick where the relationship flips, e.g. { field: 'close', operator:
 * 'crosses_above', valueField: 'bb_lower' }: previous tick's close was <=
 * previous tick's bb_lower, and this tick's close is > this tick's bb_lower.
 * Generic over any field pair (unlike the pre-computed bb_cross/macd_cross
 * columns, which only ever compare close against its own bands/signal).
 */
function evaluateCross(row, previous, cond, direction) {
  if (!previous) return false;

  const currActual = resolveField(row, cond.field);
  const prevActual = resolveField(previous, cond.field);
  const currTarget = cond.valueField ? resolveField(row, cond.valueField) : cond.value;
  const prevTarget = cond.valueField ? resolveField(previous, cond.valueField) : cond.value;
  if ([currActual, prevActual, currTarget, prevTarget].some((v) => v === undefined || v === null)) return false;

  return direction === 'above'
    ? prevActual <= prevTarget && currActual > currTarget
    : prevActual >= prevTarget && currActual < currTarget;
}

function resolveField(row, field) {
  // dotted semantic fields, e.g. 'supertrend.direction' -> row.supertrend_direction
  if (field.includes('.')) {
    const [base, sub] = field.split('.');
    return row[`${base}_${sub}`] ?? row[`${base}${capitalize(sub)}`];
  }
  return row[field];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A node is either a leaf condition ({field, operator, value}) or a nested
 * group ({join, conditions: [...]}) -- distinguished by the presence of
 * `conditions`, so a flat v1 tree (every child a leaf) and a nested v1.x
 * tree (children that are themselves groups, e.g. `(A AND B) OR C`) are
 * evaluated by the same recursive function with no schema migration.
 * @param {object} row
 * @param {object} node
 */
export function evaluateNode(row, node, previous) {
  return node && Array.isArray(node.conditions) ? evaluateFilter(row, node, previous) : evaluateCondition(row, node, previous);
}

/**
 * @param {object} row
 * @param {{ join: 'AND'|'OR', conditions: Array }} tree
 * @param {object|null} [previous]  see evaluateCondition -- only consulted by crosses_above/crosses_below leaves
 */
export function evaluateFilter(row, tree, previous) {
  if (!tree.conditions || tree.conditions.length === 0) return false;
  const results = tree.conditions.map((c) => evaluateNode(row, c, previous));
  return tree.join === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Derives the semantic isOversold/isOverbought booleans from colorRules
 * thresholds, computed once per row rather than duplicated in every
 * condition check. See docs/component_design.md §3.
 */
export function withDerivedFields(row, colorRules) {
  const rsiOversold = colorRules?.rsiOversold?.threshold ?? 30;
  const rsiOverbought = colorRules?.rsiOverbought?.threshold ?? 70;
  return {
    ...row,
    rsi_isOversold: row.rsi != null && row.rsi < rsiOversold,
    rsi_isOverbought: row.rsi != null && row.rsi > rsiOverbought,
  };
}
