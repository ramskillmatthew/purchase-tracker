import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPurchaseSearchText, matchesPurchaseSearch, matchesPurchaseSearchText, normalizeSearchTerms,
} from "@/lib/purchase-search";
import { matchesStockFilter } from "@/lib/purchases";
import type { Purchase } from "@/lib/types";

function purchase(overrides: Partial<Purchase>): Purchase {
  return {
    id: "p1", order_date: "2026-01-01", purchased_from: "Vinted", seller_name: "Some Seller", sku: "SKU1",
    item_description: "Item", item_size: "M", quantity: 1, item_condition: "Brand new", category: "Other",
    price_purchased: 10, arrived: null, stock_status: "in_stock", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ============================================================================
// normalizeSearchTerms — whitespace handling, case-insensitivity
// ============================================================================
describe("normalizeSearchTerms", () => {
  it("splits on whitespace into lowercase terms", () => {
    expect(normalizeSearchTerms("Lidl Pool")).toEqual(["lidl", "pool"]);
  });

  it("REQUIREMENT: ignores leading, trailing, and repeated whitespace", () => {
    expect(normalizeSearchTerms("  lidl   10  foot   pool  ")).toEqual(["lidl", "10", "foot", "pool"]);
  });

  it("handles tabs and newlines as whitespace too", () => {
    expect(normalizeSearchTerms("lidl\t10\nfoot")).toEqual(["lidl", "10", "foot"]);
  });

  it("REQUIREMENT: an empty or whitespace-only query produces no terms (no active search)", () => {
    expect(normalizeSearchTerms("")).toEqual([]);
    expect(normalizeSearchTerms("   ")).toEqual([]);
    expect(normalizeSearchTerms("\t\n")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(normalizeSearchTerms("LiDL PoOL")).toEqual(["lidl", "pool"]);
  });
});

// ============================================================================
// buildPurchaseSearchText / matchesPurchaseSearch — field coverage
// ============================================================================
describe("REQUIREMENT: searchable fields — description/title", () => {
  it("matches a partial, case-insensitive substring of item_description", () => {
    const row = purchase({ item_description: "Lidl 10 foot pool" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("LIDL POOL"))).toBe(true);
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("pool"))).toBe(true);
  });
});

describe("REQUIREMENT: searchable fields — order date", () => {
  it("matches the stored order_date value", () => {
    const row = purchase({ order_date: "2026-03-15" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("2026-03-15"))).toBe(true);
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("03-15"))).toBe(true);
  });
});

describe("REQUIREMENT: searchable fields — seller", () => {
  it("matches seller_name", () => {
    const row = purchase({ seller_name: "Lidl Official" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("lidl"))).toBe(true);
  });
});

describe("REQUIREMENT: searchable fields — size", () => {
  it("matches item_size", () => {
    const row = purchase({ item_size: "UK 10.5" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("10.5"))).toBe(true);
  });
});

describe("REQUIREMENT: searchable fields — purchase price", () => {
  it("matches the raw stored numeric value as a string", () => {
    const row = purchase({ price_purchased: 99.99 });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("99.99"))).toBe(true);
  });

  it("matches the value as displayed by the app (two decimal places) even when stored with fewer/more", () => {
    expect(matchesPurchaseSearch(purchase({ price_purchased: 99 }), normalizeSearchTerms("99.00"))).toBe(true);
    expect(matchesPurchaseSearch(purchase({ price_purchased: 5 }), normalizeSearchTerms("5.00"))).toBe(true);
  });

  it("REQUIREMENT: a £-prefixed query also matches, per the app's currency display convention", () => {
    expect(matchesPurchaseSearch(purchase({ price_purchased: 99.99 }), normalizeSearchTerms("£99.99"))).toBe(true);
  });

  it("does not match an unrelated price", () => {
    expect(matchesPurchaseSearch(purchase({ price_purchased: 99.99 }), normalizeSearchTerms("50.00"))).toBe(false);
  });

  it("never mutates the purchase record", () => {
    const row = purchase({ price_purchased: 99.9 });
    const frozen = Object.freeze({ ...row });
    expect(() => buildPurchaseSearchText(frozen)).not.toThrow();
    expect(frozen.price_purchased).toBe(99.9);
  });
});

describe("REQUIREMENT: searchable fields — SKU", () => {
  it("matches a partial SKU, preserving the identifier as typed", () => {
    const row = purchase({ sku: "VNT-2024-00981" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("2024-00981"))).toBe(true);
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("vnt"))).toBe(true);
  });
});

describe("REQUIREMENT: searchable fields — platform", () => {
  it("matches purchased_from", () => {
    const row = purchase({ purchased_from: "eBay" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("ebay"))).toBe(true);
  });
});

describe("REQUIREMENT: case-insensitive and partial matching", () => {
  it("matches regardless of case in either the query or the stored value", () => {
    const row = purchase({ item_description: "LIDL 10 Foot Pool" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("lidl foot pool"))).toBe(true);
  });

  it("matches a substring, not just a whole-word or whole-field match", () => {
    const row = purchase({ item_description: "Trainers" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("train"))).toBe(true);
  });
});

describe("REQUIREMENT: multiple terms may match different fields in the same row", () => {
  it("'lidl 99.99' matches seller-or-platform containing Lidl AND price 99.99, even from different fields", () => {
    const row = purchase({ seller_name: "Lidl", purchased_from: "Vinted", price_purchased: 99.99, item_description: "Paddling pool" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("lidl 99.99"))).toBe(true);
  });

  it("'lidl pool' matches a description containing both words together", () => {
    const row = purchase({ item_description: "Lidl 10 foot pool" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("lidl pool"))).toBe(true);
  });

  it("the full worked example: 'lidl 10 foot pool' matches a description containing all four words", () => {
    const row = purchase({ item_description: "Lidl 10 foot pool" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("lidl 10 foot pool"))).toBe(true);
  });
});

describe("REQUIREMENT: every term must match — a row missing even one term does not qualify", () => {
  it("a row matching some but not all terms is excluded", () => {
    const row = purchase({ item_description: "Lidl 10 foot pool", price_purchased: 50 });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("lidl 99.99"))).toBe(false);
  });

  it("REGRESSION: does not require the whole query as one exact contiguous phrase", () => {
    // "pool lidl" (reversed word order) still matches "Lidl 10 foot pool" —
    // each term matches independently, never requiring the literal phrase.
    const row = purchase({ item_description: "Lidl 10 foot pool" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("pool lidl"))).toBe(true);
  });
});

describe("REQUIREMENT: a term does not spuriously match a different, unrelated purchase row", () => {
  it("filtering a list of rows with matchesPurchaseSearchText only keeps the genuinely matching row(s)", () => {
    const rows = [
      purchase({ id: "match", item_description: "Lidl 10 foot pool" }),
      purchase({ id: "no-match-1", item_description: "Nike trainers" }),
      purchase({ id: "no-match-2", item_description: "Garden hose", seller_name: "Argos" }),
    ];
    const terms = normalizeSearchTerms("lidl pool");
    const results = rows.filter(row => matchesPurchaseSearchText(buildPurchaseSearchText(row), terms));
    expect(results.map(r => r.id)).toEqual(["match"]);
  });
});

describe("REQUIREMENT: null/missing searchable fields never error and are treated as empty", () => {
  it("a null seller_name is searchable as empty, never 'null'", () => {
    const row = purchase({ seller_name: null as unknown as string });
    expect(() => buildPurchaseSearchText(row)).not.toThrow();
    expect(buildPurchaseSearchText(row)).not.toContain("null");
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("null"))).toBe(false);
  });

  it("an undefined item_size is searchable as empty, never 'undefined'", () => {
    const row = purchase({ item_size: undefined as unknown as string });
    expect(buildPurchaseSearchText(row)).not.toContain("undefined");
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("undefined"))).toBe(false);
  });

  it("an empty-string sku is searchable as empty and never crashes", () => {
    const row = purchase({ sku: "" });
    expect(() => matchesPurchaseSearch(row, normalizeSearchTerms("anything"))).not.toThrow();
  });

  it("a row with every optional field blank still matches on its remaining real fields", () => {
    const row = purchase({ seller_name: "", item_size: "", sku: "", item_description: "Unique Widget" });
    expect(matchesPurchaseSearch(row, normalizeSearchTerms("widget"))).toBe(true);
  });
});

describe("REQUIREMENT: an empty search term list matches everything (no active search state)", () => {
  it("matchesPurchaseSearchText with zero terms always returns true", () => {
    expect(matchesPurchaseSearchText("anything", [])).toBe(true);
    expect(matchesPurchaseSearchText("", [])).toBe(true);
  });
});

// ============================================================================
// Search combined with each stock-filter rule
// ============================================================================
describe("REQUIREMENT: search combines with each stock-filter rule (search narrows whichever stock view is selected)", () => {
  const rows: Purchase[] = [
    purchase({ id: "in-stock-unarrived", stock_status: "in_stock", arrived: false, item_description: "Lidl 10 foot pool", sku: "POOL-1" }),
    purchase({ id: "in-stock-arrived", stock_status: "in_stock", arrived: true, item_description: "Lidl 10 foot pool", sku: "POOL-2" }),
    purchase({ id: "no-longer-in-stock", stock_status: "no_longer_in_stock", arrived: true, item_description: "Lidl 10 foot pool", sku: "POOL-3" }),
    purchase({ id: "unrelated", stock_status: "in_stock", arrived: false, item_description: "Garden gnome", sku: "GNOME-1" }),
  ];
  const terms = normalizeSearchTerms("lidl pool");

  function pipeline(stockFilter: Parameters<typeof matchesStockFilter>[1]) {
    return rows
      .filter(row => matchesStockFilter(row, stockFilter))
      .filter(row => matchesPurchaseSearchText(buildPurchaseSearchText(row), terms))
      .map(row => row.id);
  }

  it("'All' + search searches all purchases regardless of stock status", () => {
    expect(pipeline("all")).toEqual(["in-stock-unarrived", "in-stock-arrived", "no-longer-in-stock"]);
  });

  it("'In stock' + search shows only matching in-stock purchases", () => {
    expect(pipeline("in-stock")).toEqual(["in-stock-unarrived", "in-stock-arrived"]);
  });

  it("'Physically here' + a matching SKU shows the purchase only if it is BOTH in stock and physically here", () => {
    const skuTerms = normalizeSearchTerms("POOL-1"); // belongs to the unarrived (not physically here) row
    const results = rows.filter(row => matchesStockFilter(row, "physically-here")).filter(row => matchesPurchaseSearchText(buildPurchaseSearchText(row), skuTerms));
    expect(results).toHaveLength(0);
    const skuTerms2 = normalizeSearchTerms("POOL-2"); // belongs to the arrived (physically here) row
    const results2 = rows.filter(row => matchesStockFilter(row, "physically-here")).filter(row => matchesPurchaseSearchText(buildPurchaseSearchText(row), skuTerms2));
    expect(results2.map(r => r.id)).toEqual(["in-stock-arrived"]);
  });

  it("'Waiting on arrival' + search shows only matching in-stock-and-unarrived purchases", () => {
    expect(pipeline("waiting-on-arrival")).toEqual(["in-stock-unarrived"]);
  });

  it("'No longer in stock' + search shows only matching no-longer-held purchases", () => {
    expect(pipeline("no-longer-in-stock")).toEqual(["no-longer-in-stock"]);
  });

  it("REGRESSION: does not duplicate or subtly change the stock-status rules — matchesStockFilter is reused verbatim, never reimplemented", () => {
    const source = readFileSync("app/purchases/page.tsx", "utf8");
    expect(source).toContain("matchesStockFilter(row, stockFilter)");
    expect(source).not.toMatch(/stock_status\s*===?\s*["']in_stock["']/);
  });
});

// ============================================================================
// app/purchases/page.tsx — structural wiring (no React test harness in this
// project — matches the established convention for this exact page).
// ============================================================================
describe("app/purchases/page.tsx — search pipeline order and wiring", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("REQUIREMENT: search is applied to the full stock-filtered collection, before sorting and pagination — never only the current page", () => {
    const stockIdx = source.indexOf("const stockFilteredRows");
    const searchIdx = source.indexOf("const filteredRows = useMemo");
    const sortIdx = source.indexOf("const sortedRows = useMemo");
    const pageIdx = source.indexOf("const pageRows =");
    expect(stockIdx).toBeGreaterThan(-1);
    expect(stockIdx).toBeLessThan(searchIdx);
    expect(searchIdx).toBeLessThan(sortIdx);
    expect(sortIdx).toBeLessThan(pageIdx);
    // The search step itself filters stockFilteredRows (the full array), never `pageRows`.
    expect(source).toContain("stockFilteredRows.map(row => ({ row, searchText: buildPurchaseSearchText(row) }))");
  });

  it("the search index (expensive per-row work) is memoised on the row list, not recomputed per keystroke", () => {
    const fn = source.slice(source.indexOf("const searchIndex = useMemo"), source.indexOf("const filteredRows = useMemo"));
    expect(fn).toContain("[stockFilteredRows]");
  });

  it("searchTerms are memoised on the raw query alone", () => {
    expect(source).toContain('const searchTerms = useMemo(() => normalizeSearchTerms(query), [query]);');
  });

  it("REQUIREMENT: changing the search query resets pagination to page 1", () => {
    const fn = source.slice(source.indexOf("function changeQuery"), source.indexOf("useEffect(() => {\n    const timer"));
    expect(fn).toContain("setQuery(next)");
    expect(fn).toContain("setPage(1)");
  });

  it("REQUIREMENT: the input's onChange calls changeQuery (never setQuery directly), so pagination always resets live as the user types", () => {
    expect(source).toContain("onChange={event => changeQuery(event.target.value)}");
  });

  it("REGRESSION: changing/clearing the search never touches the sort state", () => {
    const fn = source.slice(source.indexOf("function changeQuery"), source.indexOf("useEffect(() => {\n    const timer"));
    expect(fn).not.toContain("setSort");
  });

  it("REQUIREMENT: the existing row-count/pagination display uses the combined (stock+search) filteredRows count, not the unfiltered total", () => {
    expect(source).toContain('<strong>{filteredRows.length.toLocaleString("en-GB")} rows</strong>');
  });

  it("shows a distinct 'N matching row(s)' indicator only while a search is active, with correct singular/plural wording", () => {
    expect(source).toContain('const matchingRowsLabel = filteredRows.length === 1 ? "1 matching row" : `${filteredRows.length.toLocaleString("en-GB")} matching rows`;');
    expect(source).toContain("{hasActiveSearch && <span className=\"purchase-search-count\" role=\"status\">{matchingRowsLabel}</span>}");
  });

  it("REQUIREMENT: the no-results state is distinct from both the 'no purchases exist' and 'no purchases match this filter' states, and offers a way to clear the search", () => {
    expect(source).toContain("<strong>No matching purchases</strong>");
    expect(source).toContain('<button onClick={() => changeQuery("")}>Clear search</button>');
  });

  it("REQUIREMENT: clearing the search (empty query) restores normal stock-filtered results and preserves the selected stock filter", () => {
    const fn = source.slice(source.indexOf("function changeQuery"), source.indexOf("useEffect(() => {\n    const timer"));
    expect(fn).not.toContain("setStockFilter");
  });

  it("REQUIREMENT: the search input has an accessible label and helpful placeholder", () => {
    expect(source).toContain('aria-label="Search purchases"');
    expect(source).toContain('placeholder="Search purchases"');
  });

  it("REQUIREMENT: the magnifying-glass icon is hidden from assistive technology", () => {
    const searchRow = source.slice(source.indexOf('<div className="purchase-search-row">'), source.indexOf("</svg>"));
    expect(searchRow).toContain('aria-hidden="true"');
  });

  it("REQUIREMENT: the clear (×) control is keyboard-accessible (a real <button>) and has the exact requested accessible label", () => {
    expect(source).toContain('aria-label="Clear purchase search"');
    expect(source).toContain('{query && <button type="button" onClick={() => changeQuery("")} aria-label="Clear purchase search">×</button>}');
  });

  it("clearing via the × control returns to page 1 (via changeQuery, not a bare setQuery)", () => {
    const clearButtonLine = source.slice(source.indexOf('aria-label="Clear purchase search"') - 120, source.indexOf('aria-label="Clear purchase search"') + 40);
    expect(clearButtonLine).toContain("changeQuery(\"\")");
  });

  it("does not render a separate search button — results update live from the input's own onChange", () => {
    const searchRow = source.slice(source.indexOf('<div className="purchase-search-row">'), source.indexOf("</div>\n        {hasActiveSearch"));
    expect(searchRow).not.toMatch(/>Search<\/button>/);
  });

  it("REGRESSION: does not alter the meaning of the existing 'Clear all' control — it stays wired to the confirmation dialog, never to the search query", () => {
    expect(source).toContain('<button className="button-danger" onClick={() => setConfirmation({ type: "all" })}>Clear all</button>');
  });
});

describe("app/purchases/page.tsx — URL query-parameter behaviour", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("REQUIREMENT: restores the search query from the ?q= URL parameter on load", () => {
    expect(source).toContain('const [query, setQuery] = useState(() => searchParams.get("q") ?? "");');
  });

  it("REQUIREMENT: q and stock coexist — the debounced sync writes both from live state into the same params object", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    const timer"), source.indexOf("  // Restored after mount"));
    expect(fn).toContain('if (stockFilter === "all") params.delete("stock"); else params.set("stock", stockFilter);');
    expect(fn).toContain('if (trimmedQuery) params.set("q", trimmedQuery); else params.delete("q");');
  });

  it("REQUIREMENT: never writes an empty q= parameter — an empty/whitespace query deletes it instead", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    const timer"), source.indexOf("  // Restored after mount"));
    expect(fn).toContain("const trimmedQuery = query.trim();");
    expect(fn).not.toContain('params.set("q", query)');
  });

  it("REQUIREMENT: preserves other existing query parameters — built from a copy of the current searchParams, not a fresh object", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    const timer"), source.indexOf("  // Restored after mount"));
    expect(fn).toContain("new URLSearchParams(searchParams.toString())");
  });

  it("REQUIREMENT: uses replace-style navigation, not push — a keystroke never creates a new browser-history entry", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    const timer"), source.indexOf("  // Restored after mount"));
    expect(fn).toContain("router.replace(");
    expect(fn).not.toContain("router.push(next");
  });

  it("REQUIREMENT: debounces the URL write (does not fire a navigation on every raw keystroke)", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    const timer"), source.indexOf("  // Restored after mount"));
    expect(fn).toContain("window.setTimeout(");
    expect(fn).toContain("window.clearTimeout(timer)");
  });

  it("only writes to the URL when the computed params actually differ from the current ones", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    const timer"), source.indexOf("  // Restored after mount"));
    expect(fn).toContain("if (next !== searchParams.toString())");
  });
});

describe("app/purchases/page.tsx — surrounding behaviour remains intact", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("REQUIREMENT: default sort is chronological so purchases without SKUs remain in their dated position", () => {
    expect(source).toContain('useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "order_date", direction: "desc" })');
  });

  it("REGRESSION: the stock filter still defaults to reading ?stock= via the existing shared parseStockFilter helper", () => {
    expect(source).toContain('parseStockFilter(searchParams.get("stock"))');
  });

  it("REGRESSION: ArrivalToggle and StockStatusToggle are still rendered per row, unaffected by search", () => {
    expect(source).toContain("<ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} />");
    expect(source).toContain("<StockStatusToggle id={row.id} stockStatus={row.stock_status} description={row.item_description} onToggle={toggleStockStatus} />");
  });

  it("REGRESSION: the bottom-right stock-status confirmation toast is untouched", () => {
    expect(source).toContain('{stockToast && <TaskToast message={stockToast} onDismiss={() => setStockToast(null)} position="bottom-right" />}');
  });

  it("REGRESSION: a normal row click with no active selection still routes to /purchases/[id] (now via handleRowClick/resolveRowClick's \"navigate\" branch — see tests/purchases-selection.test.ts and tests/purchases-selection-ui.test.ts for the full selection-click behaviour)", () => {
    expect(source).toContain("onClick={event => handleRowClick(event, row)}");
    const fn = source.slice(source.indexOf("function handleRowClick"), source.indexOf("async function bulkDeleteSelected"));
    expect(fn).toContain("router.push(`/purchases/${row.id}`)");
  });

  it("REGRESSION: existing sort-column click behaviour is unchanged", () => {
    expect(source).toContain("onClick={() => changeSort(column.key)}");
  });

  it("GET /api/purchases ordering is unchanged (most recent first, fetches the complete table)", () => {
    const routeSource = readFileSync("app/api/purchases/route.ts", "utf8");
    expect(routeSource).toContain("order=order_date.desc,created_at.desc");
    expect(routeSource).toContain("supabaseRequestAll");
  });
});

describe("app/purchases/page.tsx — responsive search-row structure", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");

  it("the search row sits inside the same data-panel card, below the toolbar and above the table", () => {
    const toolbarIdx = source.indexOf('<div className="grid-toolbar">');
    const searchRowIdx = source.indexOf('<div className="purchase-search-row">');
    const tableIdx = source.indexOf('<div className="table-scroll purchase-grid-scroll">');
    expect(toolbarIdx).toBeLessThan(searchRowIdx);
    expect(searchRowIdx).toBeLessThan(tableIdx);
  });

  it("REGRESSION: on narrow viewports the search box and matching-count text can each wrap onto their own full-width row, and the row itself allows wrapping", () => {
    expect(css).toMatch(/\.purchase-search-row\s*\{[^}]*flex-wrap:\s*wrap/);
    // Anchored to the rule itself (via lastIndexOf back from it) rather
    // than the first "@media (max-width: 620px)" in the whole file — this
    // file interleaves many separate 620px blocks for different features
    // (see the project's own established convention), so the first one in
    // file order is not necessarily this feature's own block.
    const boxRuleIdx = css.indexOf(".purchase-search-box { max-width: none; flex-basis: 100%; }");
    expect(boxRuleIdx).toBeGreaterThan(-1);
    const narrowBlockStart = css.lastIndexOf("@media (max-width: 620px)", boxRuleIdx);
    const narrowBlock = css.slice(narrowBlockStart, boxRuleIdx + 200);
    expect(narrowBlockStart).toBeGreaterThan(-1);
    expect(narrowBlock).toContain(".purchase-search-box { max-width: none; flex-basis: 100%; }");
    expect(narrowBlock).toContain(".purchase-search-count { flex-basis: 100%; }");
  });

  it("reuses the existing table scroll container for the table itself — no new horizontal-scroll mechanism introduced", () => {
    expect(source).toContain('<div className="table-scroll purchase-grid-scroll">');
  });
});
