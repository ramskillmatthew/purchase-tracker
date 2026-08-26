/**
 * Pure selection-state helpers for the Purchases page's checkbox
 * multi-select. Kept separate from app/purchases/page.tsx (which has no
 * React test harness in this project — see tests/purchases-search.test.ts's
 * own comment on that convention) so the actual selection/range decision
 * logic is directly unit-testable rather than only checkable structurally.
 */

export function toggleId(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Selects every id in `pageIds` unless all of them are already selected, in which case it deselects them. Ids outside `pageIds` are never touched. */
export function toggleVisiblePage(selected: Set<string>, pageIds: string[]): Set<string> {
  const next = new Set(selected);
  const allSelected = pageIds.length > 0 && pageIds.every(id => next.has(id));
  for (const id of pageIds) { if (allSelected) next.delete(id); else next.add(id); }
  return next;
}

export function selectionSummary(selected: Set<string>, pageIds: string[]): { selectedCount: number; allSelected: boolean; someSelected: boolean } {
  const selectedCount = pageIds.filter(id => selected.has(id)).length;
  const allSelected = pageIds.length > 0 && selectedCount === pageIds.length;
  const someSelected = selectedCount > 0 && !allSelected;
  return { selectedCount, allSelected, someSelected };
}

/**
 * Removes any selected id that no longer exists in `validIds` (e.g. the
 * purchase was deleted elsewhere and the list refreshed). Returns the same
 * Set instance when nothing needed pruning, so callers can skip a
 * re-render via the usual setState(prev => prev === next ? prev : next)
 * pattern.
 */
export function pruneMissingIds(selected: Set<string>, validIds: Set<string>): Set<string> {
  if (selected.size === 0) return selected;
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) { if (validIds.has(id)) next.add(id); else changed = true; }
  return changed ? next : selected;
}

/**
 * Resolves a Shift-click range against `pageIds` — the currently visible
 * page's row ids in display order, after search/filter/sort/pagination
 * have already been applied. Returns null when the anchor isn't currently
 * visible (wrong page, filtered out, or no anchor yet at all): callers
 * must not fall back to a stale remembered range in that case.
 */
export function computeShiftRange(pageIds: string[], anchorId: string | null, targetId: string): string[] | null {
  if (anchorId === null) return null;
  const anchorIndex = pageIds.indexOf(anchorId);
  if (anchorIndex === -1) return null;
  const targetIndex = pageIds.indexOf(targetId);
  if (targetIndex === -1) return null;
  const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return pageIds.slice(start, end + 1);
}

export type RowClickAction =
  | { type: "range"; ids: string[] }
  | { type: "select-single"; id: string }
  | { type: "clear" }
  | { type: "navigate" };

/**
 * Decides what a click on the non-interactive part of a purchase row
 * should do, per the priority order: Shift+click always ranges (or, absent
 * a valid anchor, selects just the clicked row and becomes the new
 * anchor) — it can never fall through to clearing the selection. A plain
 * click clears the whole selection if anything is selected; only with
 * nothing selected does a plain click open the purchase.
 */
export function resolveRowClick(params: { shiftKey: boolean; hasSelection: boolean; pageIds: string[]; anchorId: string | null; targetId: string }): RowClickAction {
  const { shiftKey, hasSelection, pageIds, anchorId, targetId } = params;
  if (shiftKey) {
    const range = computeShiftRange(pageIds, anchorId, targetId);
    if (range) return { type: "range", ids: range };
    return { type: "select-single", id: targetId };
  }
  if (hasSelection) return { type: "clear" };
  return { type: "navigate" };
}
