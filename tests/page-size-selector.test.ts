import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, isValidPageSize, parseStoredPageSize, totalPagesFor } from "@/lib/pagination";

describe("lib/pagination.ts — shared constants and validation", () => {
  it("the default page size is 25", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });

  it("the available options are exactly 25, 50 and 100 — no 'All' option", () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([25, 50, 100]);
  });

  it("isValidPageSize accepts only the three allowed sizes", () => {
    expect(isValidPageSize(25)).toBe(true);
    expect(isValidPageSize(50)).toBe(true);
    expect(isValidPageSize(100)).toBe(true);
    expect(isValidPageSize(20)).toBe(false);
    expect(isValidPageSize(1000)).toBe(false);
    expect(isValidPageSize("25")).toBe(false);
    expect(isValidPageSize(NaN)).toBe(false);
    expect(isValidPageSize(undefined)).toBe(false);
  });

  describe("parseStoredPageSize — safe restore from localStorage", () => {
    it("restores a valid stored value", () => {
      expect(parseStoredPageSize("50")).toBe(50);
      expect(parseStoredPageSize("100")).toBe(100);
      expect(parseStoredPageSize("25")).toBe(25);
    });

    it("falls back to 25 when the value is missing", () => {
      expect(parseStoredPageSize(null)).toBe(25);
    });

    it("falls back to 25 when the value is malformed (non-numeric)", () => {
      expect(parseStoredPageSize("abc")).toBe(25);
      expect(parseStoredPageSize("")).toBe(25);
    });

    it("falls back to 25 when the value is a number but not an allowed size", () => {
      expect(parseStoredPageSize("20")).toBe(25);
      expect(parseStoredPageSize("1000")).toBe(25);
      expect(parseStoredPageSize("-1")).toBe(25);
      expect(parseStoredPageSize("0")).toBe(25);
    });

    it("never produces an invalid page size from arbitrary/adversarial localStorage content", () => {
      for (const raw of ["<script>", "NaN", "Infinity", "25.5", "  25  ", "025"]) {
        expect(PAGE_SIZE_OPTIONS as readonly number[]).not.toContain(NaN);
        expect(isValidPageSize(parseStoredPageSize(raw))).toBe(true);
      }
    });
  });

  describe("totalPagesFor — correct ceiling-based page count", () => {
    it("zero records still reports 1 page (never 0)", () => {
      expect(totalPagesFor(0, 25)).toBe(1);
    });

    it("fewer than the page size reports 1 page", () => {
      expect(totalPagesFor(24, 25)).toBe(1);
    });

    it("exactly one page size reports exactly 1 page", () => {
      expect(totalPagesFor(25, 25)).toBe(1);
      expect(totalPagesFor(50, 50)).toBe(1);
      expect(totalPagesFor(100, 100)).toBe(1);
    });

    it("one record more than the page size reports 2 pages", () => {
      expect(totalPagesFor(26, 25)).toBe(2);
      expect(totalPagesFor(51, 50)).toBe(2);
      expect(totalPagesFor(101, 100)).toBe(2);
    });

    it("REQUIREMENT: 2,924 records at 25/50/100 per page gives 117/59/30 pages", () => {
      expect(totalPagesFor(2924, 25)).toBe(117);
      expect(totalPagesFor(2924, 50)).toBe(59);
      expect(totalPagesFor(2924, 100)).toBe(30);
    });

    it("totals above 1,000 and above 2,000 compute correctly (no reintroduced 1,000-row cap)", () => {
      expect(totalPagesFor(1798, 25)).toBe(72);
      expect(totalPagesFor(2500, 100)).toBe(25);
    });
  });
});

describe("Client-side pagination pipeline — sort/filter before slice (pure simulation)", () => {
  type Row = { id: number; name: string };
  function sortByName(rows: Row[]) { return [...rows].sort((a, b) => a.name.localeCompare(b.name)); }
  function paginate(rows: Row[], page: number, pageSize: number) { return rows.slice((page - 1) * pageSize, page * pageSize); }

  it("selecting 50 displays up to 50 records", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const sorted = sortByName(rows);
    expect(paginate(sorted, 1, 50)).toHaveLength(50);
  });

  it("selecting 100 displays up to 100 records", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const sorted = sortByName(rows);
    expect(paginate(sorted, 1, 100)).toHaveLength(100);
    expect(paginate(sorted, 2, 100)).toHaveLength(20);
  });

  it("the final partially-filled page shows the correct remainder, e.g. 2,901–2,924 of 2,924", () => {
    const rows = Array.from({ length: 2924 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const lastPage = totalPagesFor(rows.length, 25);
    expect(lastPage).toBe(117);
    const pageRows = paginate(rows, lastPage, 25);
    expect(pageRows).toHaveLength(24); // 2924 - 116*25 = 24
    const start = (lastPage - 1) * 25 + 1;
    const end = Math.min(lastPage * 25, rows.length);
    expect(start).toBe(2901);
    expect(end).toBe(2924);
  });

  it("pagination is applied after sorting — sorting first then slicing produces a different page than slicing the raw array", () => {
    const rows = [{ id: 1, name: "Zebra" }, { id: 2, name: "Apple" }, { id: 3, name: "Mango" }];
    const sortedFirst = paginate(sortByName(rows), 1, 2).map(r => r.name);
    const rawFirst = paginate(rows, 1, 2).map(r => r.name);
    expect(sortedFirst).toEqual(["Apple", "Mango"]);
    expect(rawFirst).toEqual(["Zebra", "Apple"]);
    expect(sortedFirst).not.toEqual(rawFirst);
  });

  it("deleting the final record on the final page leaves a valid last page, not an empty one", () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const beforeDelete = totalPagesFor(rows.length, 25); // 2
    expect(beforeDelete).toBe(2);
    const afterDelete = rows.slice(0, -1); // 25 rows
    const afterTotalPages = totalPagesFor(afterDelete.length, 25); // 1
    expect(afterTotalPages).toBe(1);
    // the page-clamp effect in both pages does Math.min(currentPage, totalPages)
    expect(Math.min(beforeDelete, afterTotalPages)).toBe(1);
  });

  it("zero records: range is empty and total pages is 1, never negative or NaN", () => {
    const rows: Row[] = [];
    expect(totalPagesFor(rows.length, 25)).toBe(1);
    expect(paginate(rows, 1, 25)).toEqual([]);
  });
});

describe("components/PageSizeSelect.tsx — structural checks (no React test harness in this project)", () => {
  const source = readFileSync("components/PageSizeSelect.tsx", "utf8");

  it("uses a native <select>, not a custom div menu", () => {
    expect(source).toContain("<select");
    expect(source).not.toContain("role=\"menu\"");
  });

  it("the visible label 'Items per page' is present and wraps the select for implicit association", () => {
    const labelStart = source.indexOf("<label");
    const labelEnd = source.indexOf("</label>");
    const labelBlock = source.slice(labelStart, labelEnd);
    expect(labelBlock).toContain("Items per page");
    expect(labelBlock).toContain("<select");
  });

  it("renders exactly the three allowed options, sourced from the shared constant (not a hardcoded list)", () => {
    expect(source).toContain("PAGE_SIZE_OPTIONS.map");
    expect(source).not.toContain('value="All"');
    expect(source).not.toMatch(/>All</);
  });

  it("reuses the app's existing .input styling rather than inventing new control styling", () => {
    expect(source).toContain('className="input"');
  });

  it("changing the value does not call focus/blur or navigate — it only reports the new size upward", () => {
    expect(source).not.toContain(".focus(");
    expect(source).not.toContain(".blur(");
    expect(source).not.toContain("window.location");
  });
});

describe("app/purchases/page.tsx — page-size selector integration", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("uses the shared PAGE_SIZE_OPTIONS/DEFAULT_PAGE_SIZE contract, not a local hardcoded page size", () => {
    expect(source).toContain('import { DEFAULT_PAGE_SIZE, parseStoredPageSize, totalPagesFor, type PageSize } from "@/lib/pagination"');
    expect(source).not.toContain("const pageSize = 20;");
  });

  it("restores the stored preference after mount (hydration-safe), not inside the initial useState", () => {
    expect(source).toContain("const [pageSize, setPageSizeState] = useState<PageSize>(DEFAULT_PAGE_SIZE);");
    expect(source).toContain("parseStoredPageSize(window.localStorage.getItem(PURCHASES_PAGE_SIZE_KEY))");
  });

  it("uses its own dedicated localStorage key", () => {
    expect(source).toContain('const PURCHASES_PAGE_SIZE_KEY = "trotters:purchases-page-size";');
  });

  it("changing page size resets to page 1 and persists the new value", () => {
    const fn = source.slice(source.indexOf("function changePageSize"), source.indexOf("async function load"));
    expect(fn).toContain("setPage(1)");
    expect(fn).toContain("window.localStorage.setItem(PURCHASES_PAGE_SIZE_KEY, String(next))");
  });

  it("pagination is computed from sortedRows (post-sort), never the raw fetched rows", () => {
    expect(source).toContain("const totalPages = totalPagesFor(sortedRows.length, pageSize);");
    expect(source).toContain("const pageRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);");
  });

  it("an invalid current page (e.g. after a delete) is clamped back to the last valid page", () => {
    expect(source).toContain("useEffect(() => { setPage(current => Math.min(current, totalPages)); }, [totalPages]);");
  });

  it("the heading record count reflects the complete dataset, never the selected page size", () => {
    expect(source).toContain("<h1>Purchases</h1><span className=\"record-count\">{rows.length.toLocaleString(\"en-GB\")}</span>");
  });

  it("the footer range uses locale-formatted counts (e.g. 2,924, not 2924)", () => {
    expect(source).toContain('.toLocaleString("en-GB")} of ${sortedRows.length.toLocaleString("en-GB")}');
  });

  it("the PageSizeSelect is rendered in the pagination footer, not the page header actions", () => {
    const headerBlock = source.slice(source.indexOf('<header className="purchase-topbar">'), source.indexOf("</header>"));
    expect(headerBlock).not.toContain("PageSizeSelect");
    const paginationBarIndex = source.indexOf('<div className="pagination-bar">');
    const confirmationIndex = source.indexOf("{confirmation &&");
    expect(paginationBarIndex).toBeGreaterThan(-1);
    expect(confirmationIndex).toBeGreaterThan(paginationBarIndex);
    const footerBlock = source.slice(paginationBarIndex, confirmationIndex);
    expect(footerBlock).toContain("<PageSizeSelect value={pageSize} onChange={changePageSize} />");
  });
});

describe("app/expenses/page.tsx — page-size selector integration (identical behaviour to Purchases)", () => {
  const source = readFileSync("app/expenses/page.tsx", "utf8");

  it("uses the shared PAGE_SIZE_OPTIONS/DEFAULT_PAGE_SIZE contract", () => {
    expect(source).toContain('import { DEFAULT_PAGE_SIZE, parseStoredPageSize, totalPagesFor, type PageSize } from "@/lib/pagination"');
  });

  it("uses its own dedicated localStorage key, independent from Purchases", () => {
    expect(source).toContain('const EXPENSES_PAGE_SIZE_KEY = "trotters:expenses-page-size";');
    expect(source).not.toContain("trotters:purchases-page-size");
  });

  it("changing page size resets to page 1 and persists the new value", () => {
    const fn = source.slice(source.indexOf("function changePageSize"), source.indexOf("const load = useCallback"));
    expect(fn).toContain("setPage(1)");
    expect(fn).toContain("window.localStorage.setItem(EXPENSES_PAGE_SIZE_KEY, String(next))");
  });

  it("the table body now renders the sliced pageExpenses, not the full expenses array", () => {
    expect(source).toContain("const pageExpenses = expenses.slice((page - 1) * pageSize, page * pageSize);");
    expect(source).toContain("{pageExpenses.length ? pageExpenses.map(expense =>");
  });

  it("an invalid current page (e.g. after a delete) is clamped back to the last valid page", () => {
    expect(source).toContain("useEffect(() => { setPage(current => Math.min(current, totalPages)); }, [totalPages]);");
  });

  it("the heading record count still reflects the complete dataset, never the selected page size", () => {
    expect(source).toContain('<h1>Expenses</h1><span className="record-count">{expenses.length}</span>');
  });

  it("the footer range uses locale-formatted counts", () => {
    expect(source).toContain('.toLocaleString("en-GB")} of ${expenses.length.toLocaleString("en-GB")}');
  });

  it("does not change expense validation, editing, deletion or import wiring", () => {
    expect(source).toContain("ExpenseForm key={editing?.id ?? \"new\"}");
    expect(source).toContain("ExpenseImportDialog onClose={() => setImportOpen(false)} onImported={load}");
    expect(source).toContain('action-delete" onClick={() => setConfirmation({ type: "one", id: expense.id })}');
  });

  it("the PageSizeSelect is rendered in the table footer, not the page header actions", () => {
    const headerBlock = source.slice(source.indexOf('<header className="purchase-topbar">'), source.indexOf("</header>"));
    expect(headerBlock).not.toContain("PageSizeSelect");
    expect(source).toContain('<div className="pagination-bar">');
  });
});

describe("app/globals.css — page-size selector styling reuses existing tokens", () => {
  const source = readFileSync("app/globals.css", "utf8");

  it(".page-size-select reuses the existing .input control (border, radius, focus ring) rather than new styling", () => {
    expect(source).toContain(".page-size-select .input");
    expect(source).not.toMatch(/\.page-size-select[^}]*gradient/);
    expect(source).not.toMatch(/\.page-size-select[^}]*box-shadow:\s*0\s+\d+px\s+\d+px\s+\d+px/); // no new large/excessive shadow
  });

  it("the pagination footer wraps on narrow viewports instead of overlapping", () => {
    expect(source).toMatch(/@media \(max-width: 620px\) \{[\s\S]*\.pagination-bar \{ flex-direction: column/);
  });
});
