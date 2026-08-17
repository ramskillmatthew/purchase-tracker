import { describe, expect, it } from "vitest";
import {
  computeShiftRange, pruneMissingIds, resolveRowClick, selectionSummary, toggleId, toggleVisiblePage,
} from "@/lib/purchases-selection";

describe("toggleId", () => {
  it("selects an unselected id", () => {
    const result = toggleId(new Set(), "a");
    expect([...result]).toEqual(["a"]);
  });

  it("deselects an already-selected id", () => {
    const result = toggleId(new Set(["a", "b"]), "a");
    expect([...result]).toEqual(["b"]);
  });

  it("never mutates the input Set", () => {
    const input = new Set(["a"]);
    toggleId(input, "a");
    expect([...input]).toEqual(["a"]);
  });
});

describe("toggleVisiblePage — header select-all for the current page", () => {
  it("selects every visible row when none of the page is selected", () => {
    const result = toggleVisiblePage(new Set(), ["a", "b", "c"]);
    expect([...result].sort()).toEqual(["a", "b", "c"]);
  });

  it("selects every visible row when only some of the page is selected", () => {
    const result = toggleVisiblePage(new Set(["a"]), ["a", "b", "c"]);
    expect([...result].sort()).toEqual(["a", "b", "c"]);
  });

  it("deselects the whole page once every visible row is already selected", () => {
    const result = toggleVisiblePage(new Set(["a", "b", "c"]), ["a", "b", "c"]);
    expect([...result]).toEqual([]);
  });

  it("REQUIREMENT: never touches a selection on another page — only ids in pageIds are added/removed", () => {
    const result = toggleVisiblePage(new Set(["other-page-1"]), ["a", "b"]);
    expect([...result].sort()).toEqual(["a", "b", "other-page-1"]);
  });

  it("deselecting the current page preserves selections belonging to other pages", () => {
    const result = toggleVisiblePage(new Set(["a", "b", "other-page-1"]), ["a", "b"]);
    expect([...result]).toEqual(["other-page-1"]);
  });

  it("an empty page selects nothing (never silently selects everything)", () => {
    const result = toggleVisiblePage(new Set(), []);
    expect([...result]).toEqual([]);
  });
});

describe("selectionSummary — header checkbox checked/indeterminate state", () => {
  it("REQUIREMENT: fully checked only when every visible row is selected", () => {
    expect(selectionSummary(new Set(["a", "b"]), ["a", "b"])).toEqual({ selectedCount: 2, allSelected: true, someSelected: false });
  });

  it("REQUIREMENT: indeterminate when some but not all visible rows are selected", () => {
    expect(selectionSummary(new Set(["a"]), ["a", "b"])).toEqual({ selectedCount: 1, allSelected: false, someSelected: true });
  });

  it("neither checked nor indeterminate when nothing on the page is selected", () => {
    expect(selectionSummary(new Set(), ["a", "b"])).toEqual({ selectedCount: 0, allSelected: false, someSelected: false });
  });

  it("an empty page is never reported as fully selected", () => {
    expect(selectionSummary(new Set(), [])).toEqual({ selectedCount: 0, allSelected: false, someSelected: false });
  });

  it("selections outside the current page do not count toward this page's summary", () => {
    expect(selectionSummary(new Set(["other-page-1", "a"]), ["a", "b"])).toEqual({ selectedCount: 1, allSelected: false, someSelected: true });
  });
});

describe("pruneMissingIds — dropping stale ids after a data refresh", () => {
  it("removes a selected id no longer present in the fresh data", () => {
    const result = pruneMissingIds(new Set(["a", "b"]), new Set(["a"]));
    expect([...result]).toEqual(["a"]);
  });

  it("keeps every id that's still present", () => {
    const result = pruneMissingIds(new Set(["a", "b"]), new Set(["a", "b", "c"]));
    expect([...result].sort()).toEqual(["a", "b"]);
  });

  it("returns the exact same Set instance when nothing needed pruning (avoids an unnecessary re-render)", () => {
    const input = new Set(["a"]);
    expect(pruneMissingIds(input, new Set(["a"]))).toBe(input);
  });

  it("an empty selection stays the same instance and is a cheap no-op", () => {
    const input = new Set<string>();
    expect(pruneMissingIds(input, new Set(["a"]))).toBe(input);
  });
});

describe("computeShiftRange — Shift-click range resolution", () => {
  const pageIds = ["r1", "r2", "r3", "r4", "r5"];

  it("REQUIREMENT: selects downward from the anchor to a later row", () => {
    expect(computeShiftRange(pageIds, "r2", "r4")).toEqual(["r2", "r3", "r4"]);
  });

  it("REQUIREMENT: selects upward from the anchor to an earlier row", () => {
    expect(computeShiftRange(pageIds, "r4", "r2")).toEqual(["r2", "r3", "r4"]);
  });

  it("shift-clicking the anchor itself selects just that one row", () => {
    expect(computeShiftRange(pageIds, "r3", "r3")).toEqual(["r3"]);
  });

  it("REQUIREMENT: never includes a row outside the current page's visible ids", () => {
    const range = computeShiftRange(pageIds, "r1", "r5");
    expect(range).not.toBeNull();
    for (const id of range!) expect(pageIds).toContain(id);
  });

  it("REQUIREMENT: returns null (no range) when there is no anchor yet", () => {
    expect(computeShiftRange(pageIds, null, "r3")).toBeNull();
  });

  it("REQUIREMENT: returns null (does not reuse a stale range) when the anchor is no longer in the visible page — e.g. after changing page, sort, or filters", () => {
    expect(computeShiftRange(pageIds, "not-visible-anymore", "r3")).toBeNull();
  });

  it("returns null when the shift-clicked target itself isn't in the visible page (defensive — should not normally happen)", () => {
    expect(computeShiftRange(pageIds, "r1", "not-visible")).toBeNull();
  });
});

describe("resolveRowClick — interaction priority for a click on the non-interactive part of a row", () => {
  const pageIds = ["r1", "r2", "r3"];

  it("REQUIREMENT: a normal click with no active selection opens the purchase", () => {
    expect(resolveRowClick({ shiftKey: false, hasSelection: false, pageIds, anchorId: null, targetId: "r1" })).toEqual({ type: "navigate" });
  });

  it("REQUIREMENT: a normal click while a selection is active clears the whole selection instead of navigating", () => {
    expect(resolveRowClick({ shiftKey: false, hasSelection: true, pageIds, anchorId: "r1", targetId: "r2" })).toEqual({ type: "clear" });
  });

  it("REQUIREMENT: Shift+click with a valid anchor performs a range select, and takes priority over the clear-on-click rule even though a selection is active", () => {
    expect(resolveRowClick({ shiftKey: true, hasSelection: true, pageIds, anchorId: "r1", targetId: "r3" })).toEqual({ type: "range", ids: ["r1", "r2", "r3"] });
  });

  it("REQUIREMENT: a subsequent Shift-click without a valid anchor does not reuse the old range — it starts a fresh single selection instead", () => {
    expect(resolveRowClick({ shiftKey: true, hasSelection: false, pageIds, anchorId: "stale-anchor", targetId: "r2" })).toEqual({ type: "select-single", id: "r2" });
  });

  it("Shift+click with no anchor at all (first-ever selection action) also starts a fresh single selection", () => {
    expect(resolveRowClick({ shiftKey: true, hasSelection: false, pageIds, anchorId: null, targetId: "r1" })).toEqual({ type: "select-single", id: "r1" });
  });
});
