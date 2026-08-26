import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// app/vinted-import/page.tsx is a "use client" React component (hooks,
// JSX) — not imported directly into vitest's node environment, consistent
// with how the rest of this suite tests non-importable modules. Its
// extractable pure logic (draftFor) already has real behavioral coverage
// in tests/purchase-import-draft.test.ts; this file covers the remaining
// UI wiring structurally.
const pageSource = readFileSync("app/vinted-import/page.tsx", "utf8");

describe("review UI: REGRESSION — an order must be imported all-or-nothing, never a partial selection", () => {
  it("a checkbox toggle applies to the whole order group's still-pending, importable rows, not just the clicked row", () => {
    expect(pageSource).toContain("function selectGroup(ids: string[], checked: boolean)");
    expect(pageSource).toContain("onChange={e => toggleGroup(e.target.checked)}");
    expect(pageSource).not.toContain('onChange={e => update(row.id, "selected", e.target.checked)}');
  });

  it("the group's selectable set is exactly its still-pending, not-cancelled/refunded rows", () => {
    expect(pageSource).toContain('row.import_status === "pending" && !row.cancellation_refund_status');
  });
});

describe("review UI: REGRESSION — the total-allocation check uses the exact rows being imported, in integer pence", () => {
  it("uses poundsToPence rather than floating multiplication for the mismatch comparison", () => {
    expect(pageSource).toContain('import { poundsToPence } from "@/lib/purchase-import/allocate"');
    expect(pageSource).toContain("poundsToPence(Number(edits[row.id]?.price_purchased) || 0)");
    expect(pageSource).not.toMatch(/Math\.round\(allocated \* 100\)/);
  });

  it("sums only the selected (chosenInGroup) rows, never the whole group regardless of selection", () => {
    const mismatchBlock = pageSource.slice(pageSource.indexOf("const mismatchedGroups = groups.filter"), pageSource.indexOf("const total = chosen.reduce"));
    expect(mismatchBlock).toContain("chosenInGroup.reduce((sum, row) => sum + poundsToPence(");
  });
});

describe("review UI: REGRESSION — the download link is labelled as CSV, not as a native Excel workbook", () => {
  it("labels the batch download action accurately", () => {
    expect(pageSource).toContain("Download batch CSV for Excel");
    expect(pageSource).not.toContain("Download Excel for this batch");
  });
});

describe("review UI: surfaces blocked order groups distinctly from ordinary duplicates", () => {
  it("reads body.blocked / body.blockedReasons from the import response", () => {
    expect(pageSource).toContain("body.blocked");
    expect(pageSource).toContain("body.blockedReasons");
  });
});
