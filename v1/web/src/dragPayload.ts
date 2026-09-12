/**
 * Shared drag-and-drop payload shape for numeric table cells: the value
 * goes on 'text/plain' (unchanged, so the plain Calculator keeps working
 * with no changes), and the originating row's symbol rides alongside on a
 * second custom MIME type so a drop target that cares (Position
 * Calculator's Entry Price field) can pick up which stock a dragged price
 * came from.
 */
export const SYMBOL_MIME = 'application/x-stockwatcher-symbol';

export function setDragPayload(e: React.DragEvent, value: unknown, symbol: string) {
  e.dataTransfer.setData('text/plain', String(value ?? ''));
  e.dataTransfer.setData(SYMBOL_MIME, symbol);
}
