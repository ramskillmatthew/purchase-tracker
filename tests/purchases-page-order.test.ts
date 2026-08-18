import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// app/purchases/page.tsx is a "use client" page with no React test harness
// in this project — asserted structurally, matching the established
// convention (see tests/purchases-selection-ui.test.ts's own comment).
const source = readFileSync("app/purchases/page.tsx", "utf8");

describe("app/purchases/page.tsx — default and SKU-column ordering", () => {
  it("imports the shared authoritative comparator, rather than reimplementing date/SKU ordering inline", () => {
    expect(source).toContain('import { comparePurchasesForDisplay, compareSkuDescending } from "@/lib/purchase-order";');
  });

  it("REQUIREMENT: the default view (order_date, desc) uses the full authoritative multi-key comparator, not a single-key date-only comparison", () => {
    const sortedRowsFn = source.slice(source.indexOf("const sortedRows = useMemo("), source.indexOf("const totalPages ="));
    expect(sortedRowsFn).toContain('if (sort.key === "order_date") {');
    expect(sortedRowsFn).toContain("[...filteredRows].sort(comparePurchasesForDisplay)");
  });

  it("REQUIREMENT: the SKU column uses the same numeric-safe comparator as the default view — one definition of SKU order on this page, not two", () => {
    const sortedRowsFn = source.slice(source.indexOf("const sortedRows = useMemo("), source.indexOf("const totalPages ="));
    expect(sortedRowsFn).toContain('if (sort.key === "sku") {');
    expect(sortedRowsFn).toContain("compareSkuDescending(a.sku, b.sku)");
  });

  it("the initial sort state is order_date descending — the default, authoritative view — unchanged from before", () => {
    expect(source).toContain('const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "order_date", direction: "desc" });');
  });

  it("REQUIREMENT: sorting happens over the complete filtered dataset before pagination slices it — never a single page sorted in isolation", () => {
    const sortIdx = source.indexOf("const sortedRows = useMemo(");
    const sliceIdx = source.indexOf("const pageRows = sortedRows.slice(");
    expect(sortIdx).toBeGreaterThan(-1);
    expect(sliceIdx).toBeGreaterThan(sortIdx);
  });

  it("every other column keeps its own existing generic comparator, untouched", () => {
    const sortedRowsFn = source.slice(source.indexOf("const sortedRows = useMemo("), source.indexOf("const totalPages ="));
    expect(sortedRowsFn).toContain("typeof left === \"number\" && typeof right === \"number\"");
    expect(sortedRowsFn).toContain("localeCompare(String(right), undefined, { numeric: true, sensitivity: \"base\" })");
  });
});
