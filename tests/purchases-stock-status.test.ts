import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  calculateInStockAwaitingArrivalValue, calculateInStockValue, countInStock, countInStockAwaitingArrival,
  inStockAwaitingArrivalItemsLabel, inStockItemsLabel, isInStock, isInStockAwaitingArrival, isInStockPhysicallyHere,
  isNoLongerInStock, matchesStockFilter, nextStockStatus, parseStockFilter, stockFilters,
} from "@/lib/purchases";
import type { Purchase } from "@/lib/types";

function purchase(overrides: Partial<Purchase>): Purchase {
  return {
    id: "p1", order_date: "2026-01-01", purchased_from: "Vinted", seller_name: "", sku: "SKU1",
    item_description: "Item", item_size: "M", quantity: 1, item_condition: "Brand new", category: "Other",
    price_purchased: 10, arrived: null, stock_status: "in_stock", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ============================================================================
// supabase-add-stock-status.sql — asserted structurally, the same
// convention tests/purchase-import-migration.test.ts uses for
// supabase-purchase-import-v2.sql, since vitest can't execute SQL against
// a real database. Normalized to LF for the same CRLF-safety reason that
// file documents.
// ============================================================================
describe("supabase-add-stock-status.sql — the one-time migration", () => {
  const migration = readFileSync("supabase-add-stock-status.sql", "utf8").replace(/\r\n/g, "\n");

  it("never touches public.expenses — only public.purchases", () => {
    expect(migration).not.toMatch(/alter table public\.expenses/);
    expect(migration).not.toMatch(/update public\.expenses/);
  });

  it("adds the column with a CHECK constraint restricting it to exactly the two required values, and no default yet", () => {
    const addColumnLine = migration.split("\n").find(line => line.includes("add column if not exists stock_status"));
    expect(addColumnLine).toBeTruthy();
    expect(addColumnLine).toContain("check (stock_status in ('in_stock', 'no_longer_in_stock'))");
    expect(addColumnLine).not.toContain("default");
  });

  it("REGRESSION: backfills every existing (null) purchase to no_longer_in_stock BEFORE the default is ever set — this exact ordering is what makes old purchases become no_longer_in_stock while new ones default to in_stock", () => {
    const backfillIndex = migration.indexOf("set stock_status = 'no_longer_in_stock'");
    const defaultIndex = migration.indexOf("set default 'in_stock'");
    expect(backfillIndex).toBeGreaterThan(-1);
    expect(defaultIndex).toBeGreaterThan(-1);
    expect(backfillIndex).toBeLessThan(defaultIndex);
  });

  it("the backfill only ever targets rows with no value yet — never overwrites a value that already exists", () => {
    expect(migration).toContain("where stock_status is null");
  });

  it("sets the default to in_stock only after the backfill, and enforces not null only after that", () => {
    const defaultIndex = migration.indexOf("set default 'in_stock'");
    const notNullIndex = migration.indexOf("set not null");
    expect(notNullIndex).toBeGreaterThan(defaultIndex);
  });

  it("is wrapped in one explicit transaction, so a failure at any step leaves nothing partially applied", () => {
    const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
    const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");
    const lines = codeOnly.split("\n");
    expect(lines[0]).toBe("begin;");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("every statement is safe to run more than once (add column / update-where-null / set default / set not null are all naturally idempotent)", () => {
    const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
    expect(executable).not.toMatch(/\badd column(?! if not exists)/i);
  });

  it("does not include a spreadsheet importer, SKU matcher, or automatic restoration tool — this is a one-time historical reset only, just column DDL and one backfill UPDATE", () => {
    expect(migration).not.toMatch(/create (or replace )?function/i);
    expect(migration).not.toMatch(/\bcopy\b/i);
    expect(migration).not.toContain("sku");
    // Exactly one UPDATE statement in the whole migration — the backfill —
    // never a second one that could restore/re-derive stock status from
    // anything else.
    expect(migration.match(/^update /gim)?.length).toBe(1);
  });
});

// ============================================================================
// New-purchase behaviour — the create route never sets stock_status
// itself, relying entirely on the database column default, INCLUDING for
// every row a quantity > 1 purchase is split into.
// ============================================================================
describe("app/api/purchases/route.ts — new purchases default to in_stock via the database column default", () => {
  const source = readFileSync("app/api/purchases/route.ts", "utf8");

  it("REGRESSION: the POST handler never sets stock_status explicitly — every created row (including every quantity-split unit row) gets it purely from the column default", () => {
    const postFn = source.slice(source.indexOf("export async function POST"), source.indexOf("export async function PATCH"));
    expect(postFn).not.toContain("stock_status");
  });

  it("still splits quantity into one row per unit — unrelated to stock status, must remain untouched", () => {
    expect(source).toContain("const purchases = Array.from({ length: quantity }, () => ({ ...purchase, quantity: 1 }));");
  });

  it("the PATCH route accepts stock_status via the existing purchaseInputSchema-derived validator, for the row-level toggle", () => {
    const patchFn = source.slice(source.indexOf("export async function PATCH"), source.indexOf("export async function DELETE"));
    expect(patchFn).toContain("purchaseInputSchema.omit({ quantity: true }).partial().strict()");
  });

  it("GET ordering is unchanged — most recent first, the same order every other feature in this app relies on", () => {
    expect(source).toContain('order=order_date.desc,created_at.desc');
  });
});

describe("lib/validation/purchase.ts — stock_status is optional on create, never required", () => {
  const source = readFileSync("lib/validation/purchase.ts", "utf8");

  it("declares stock_status as an optional enum of exactly the two allowed values", () => {
    expect(source).toContain('stock_status: z.enum(["in_stock", "no_longer_in_stock"]).optional(),');
  });
});

// ============================================================================
// Shared stock-status rules — lib/purchases.ts
// ============================================================================
describe("isInStock / isNoLongerInStock — no third state", () => {
  it("isInStock is true only for the explicit 'in_stock' value", () => {
    expect(isInStock(purchase({ stock_status: "in_stock" }))).toBe(true);
    expect(isInStock(purchase({ stock_status: "no_longer_in_stock" }))).toBe(false);
  });
  it("isNoLongerInStock is the exact inverse", () => {
    expect(isNoLongerInStock(purchase({ stock_status: "in_stock" }))).toBe(false);
    expect(isNoLongerInStock(purchase({ stock_status: "no_longer_in_stock" }))).toBe(true);
  });
});

describe("REQUIREMENT: In stock includes both arrived and unarrived inventory", () => {
  it("an in_stock purchase counts as in stock regardless of arrived (true, false, or null)", () => {
    expect(isInStock(purchase({ stock_status: "in_stock", arrived: true }))).toBe(true);
    expect(isInStock(purchase({ stock_status: "in_stock", arrived: false }))).toBe(true);
    expect(isInStock(purchase({ stock_status: "in_stock", arrived: null }))).toBe(true);
  });
});

describe("REQUIREMENT: Waiting on arrival requires BOTH in-stock status and not-arrived status", () => {
  it("in_stock + not arrived (false or null) = waiting on arrival", () => {
    expect(isInStockAwaitingArrival(purchase({ stock_status: "in_stock", arrived: false }))).toBe(true);
    expect(isInStockAwaitingArrival(purchase({ stock_status: "in_stock", arrived: null }))).toBe(true);
  });
  it("in_stock + arrived = NOT waiting on arrival", () => {
    expect(isInStockAwaitingArrival(purchase({ stock_status: "in_stock", arrived: true }))).toBe(false);
  });
  it("REGRESSION: no_longer_in_stock is NEVER waiting on arrival, even when arrived is false or null", () => {
    expect(isInStockAwaitingArrival(purchase({ stock_status: "no_longer_in_stock", arrived: false }))).toBe(false);
    expect(isInStockAwaitingArrival(purchase({ stock_status: "no_longer_in_stock", arrived: null }))).toBe(false);
  });
});

describe("REQUIREMENT: Physically here requires BOTH in-stock status and arrived status", () => {
  it("in_stock + arrived = physically here", () => {
    expect(isInStockPhysicallyHere(purchase({ stock_status: "in_stock", arrived: true }))).toBe(true);
  });
  it("in_stock + not arrived (false or null) = NOT physically here", () => {
    expect(isInStockPhysicallyHere(purchase({ stock_status: "in_stock", arrived: false }))).toBe(false);
    expect(isInStockPhysicallyHere(purchase({ stock_status: "in_stock", arrived: null }))).toBe(false);
  });
  it("REGRESSION: no_longer_in_stock is NEVER physically here, even when arrived is true", () => {
    expect(isInStockPhysicallyHere(purchase({ stock_status: "no_longer_in_stock", arrived: true }))).toBe(false);
  });
  it("every in_stock purchase is in exactly one of waiting-on-arrival / physically-here, never both, never neither", () => {
    for (const arrived of [true, false, null]) {
      const row = purchase({ stock_status: "in_stock", arrived });
      expect(isInStockAwaitingArrival(row) !== isInStockPhysicallyHere(row)).toBe(true);
    }
  });
});

describe("REQUIREMENT: No longer in stock filtering", () => {
  it("matches only no_longer_in_stock purchases, regardless of arrival", () => {
    const rows = [
      purchase({ id: "1", stock_status: "no_longer_in_stock", arrived: true }),
      purchase({ id: "2", stock_status: "no_longer_in_stock", arrived: false }),
      purchase({ id: "3", stock_status: "in_stock", arrived: true }),
    ];
    expect(rows.filter(isNoLongerInStock).map(r => r.id)).toEqual(["1", "2"]);
  });
});

describe("Arrival and stock status stay fully independent", () => {
  it("changing arrival alone never affects stock eligibility — isInStock ignores `arrived` entirely", () => {
    const arrivedTrue = purchase({ stock_status: "in_stock", arrived: true });
    const arrivedFalse = purchase({ stock_status: "in_stock", arrived: false });
    expect(isInStock(arrivedTrue)).toBe(isInStock(arrivedFalse));
  });
  it("changing stock status alone never affects the purchase's own `arrived` value (behavioural contract, not a mutation the helpers could break)", () => {
    const row = purchase({ stock_status: "in_stock", arrived: true });
    const changed: Purchase = { ...row, stock_status: "no_longer_in_stock" };
    expect(changed.arrived).toBe(true);
  });
});

// ============================================================================
// Stock value — purchase price only, one contribution per row, invalid
// prices ignored, never rounded per-item.
// ============================================================================
describe("REQUIREMENT: calculateInStockValue — the same in-stock collection countInStock counts", () => {
  it("counts and values agree on which rows are eligible", () => {
    const rows = [
      purchase({ id: "1", stock_status: "in_stock", arrived: false, price_purchased: 25.5 }),
      purchase({ id: "2", stock_status: "in_stock", arrived: true, price_purchased: 40 }),
      purchase({ id: "3", stock_status: "no_longer_in_stock", arrived: true, price_purchased: 100 }),
    ];
    const eligibleByPredicate = rows.filter(isInStock).length;
    expect(countInStock(rows)).toBe(eligibleByPredicate);
    expect(eligibleByPredicate).toBe(2);
    expect(calculateInStockValue(rows)).toBe(65.5);
  });

  it("uses purchase price only — never postage, fees, or an estimated resale value (no such fields exist on Purchase, so this is guaranteed structurally)", () => {
    const rows = [purchase({ stock_status: "in_stock", price_purchased: 30 })];
    expect(calculateInStockValue(rows)).toBe(30);
  });

  it("includes in-stock items whether arrived or not", () => {
    const rows = [
      purchase({ id: "1", stock_status: "in_stock", arrived: true, price_purchased: 10 }),
      purchase({ id: "2", stock_status: "in_stock", arrived: false, price_purchased: 20 }),
      purchase({ id: "3", stock_status: "in_stock", arrived: null, price_purchased: 5 }),
    ];
    expect(calculateInStockValue(rows)).toBe(35);
  });

  it("excludes no_longer_in_stock purchases entirely, even with a valid price", () => {
    const rows = [purchase({ stock_status: "no_longer_in_stock", price_purchased: 500 })];
    expect(calculateInStockValue(rows)).toBe(0);
    expect(countInStock(rows)).toBe(0);
  });

  it("REQUIREMENT: invalid/missing prices do not corrupt the total — null, blank, whitespace, NaN, non-numeric all contribute 0", () => {
    const rows = [
      purchase({ id: "1", stock_status: "in_stock", price_purchased: null as unknown as number }),
      purchase({ id: "2", stock_status: "in_stock", price_purchased: "" as unknown as number }),
      purchase({ id: "3", stock_status: "in_stock", price_purchased: "   " as unknown as number }),
      purchase({ id: "4", stock_status: "in_stock", price_purchased: NaN }),
      purchase({ id: "5", stock_status: "in_stock", price_purchased: "abc" as unknown as number }),
      purchase({ id: "6", stock_status: "in_stock", price_purchased: 12.5 }),
    ];
    expect(calculateInStockValue(rows)).toBe(12.5);
  });

  it("handles numeric-string prices safely (defensive against a non-numeric API response), never string-concatenated", () => {
    const rows = [
      purchase({ id: "1", stock_status: "in_stock", price_purchased: "25.50" as unknown as number }),
      purchase({ id: "2", stock_status: "in_stock", price_purchased: "10" as unknown as number }),
    ];
    const total = calculateInStockValue(rows);
    expect(total).toBe(35.5);
    expect(typeof total).toBe("number");
  });

  it("each purchase row contributes once — a quantity field on the row itself never multiplies its contribution", () => {
    const rows = [purchase({ stock_status: "in_stock", price_purchased: 10, quantity: 5 })];
    expect(calculateInStockValue(rows)).toBe(10);
    expect(countInStock(rows)).toBe(1);
  });

  it("sums decimal prices without individually rounding first", () => {
    const rows = [
      purchase({ id: "1", stock_status: "in_stock", price_purchased: 10.1 }),
      purchase({ id: "2", stock_status: "in_stock", price_purchased: 10.2 }),
      purchase({ id: "3", stock_status: "in_stock", price_purchased: 10.3 }),
    ];
    expect(calculateInStockValue(rows)).toBeCloseTo(30.6, 10);
  });

  it("zero-price purchases are valid and included", () => {
    const rows = [purchase({ stock_status: "in_stock", price_purchased: 0 }), purchase({ stock_status: "in_stock", price_purchased: 10 })];
    expect(calculateInStockValue(rows)).toBe(10);
    expect(countInStock(rows)).toBe(2);
  });

  it("an empty purchase array returns 0 for both count and value", () => {
    expect(calculateInStockValue([])).toBe(0);
    expect(countInStock([])).toBe(0);
  });

  it("REQUIREMENT: formats as GBP using the existing currency formatter convention", () => {
    const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
    const rows = [purchase({ stock_status: "in_stock", price_purchased: 25.5 }), purchase({ stock_status: "in_stock", price_purchased: 40 })];
    expect(money.format(calculateInStockValue(rows))).toBe("£65.50");
  });
});

describe("calculateInStockAwaitingArrivalValue / countInStockAwaitingArrival — the Home 'In stock awaiting arrival' card's own pair", () => {
  it("counts and values agree, and exclude no_longer_in_stock even when arrived is false or null", () => {
    const rows = [
      purchase({ id: "1", stock_status: "in_stock", arrived: false, price_purchased: 20 }),
      purchase({ id: "2", stock_status: "in_stock", arrived: null, price_purchased: 30 }),
      purchase({ id: "3", stock_status: "in_stock", arrived: true, price_purchased: 999 }),
      purchase({ id: "4", stock_status: "no_longer_in_stock", arrived: false, price_purchased: 500 }),
      purchase({ id: "5", stock_status: "no_longer_in_stock", arrived: null, price_purchased: 500 }),
    ];
    expect(countInStockAwaitingArrival(rows)).toBe(2);
    expect(calculateInStockAwaitingArrivalValue(rows)).toBe(50);
  });
});

describe("inStockItemsLabel / inStockAwaitingArrivalItemsLabel — singular/plural wording", () => {
  it("inStockItemsLabel: singular for 1, plural otherwise, includes 'in stock'", () => {
    expect(inStockItemsLabel(1)).toBe("1 item in stock");
    expect(inStockItemsLabel(0)).toBe("0 items in stock");
    expect(inStockItemsLabel(427)).toBe("427 items in stock");
  });
  it("inStockAwaitingArrivalItemsLabel: singular for 1, plural otherwise", () => {
    expect(inStockAwaitingArrivalItemsLabel(1)).toBe("1 item");
    expect(inStockAwaitingArrivalItemsLabel(12)).toBe("12 items");
  });
  it("large counts are locale-formatted", () => {
    expect(inStockItemsLabel(1234)).toBe("1,234 items in stock");
  });
});

// ============================================================================
// Purchases page stock filter — URL query parameters, ordering, defaults
// ============================================================================
describe("stockFilters — the five options the Purchases page filter renders", () => {
  it("exposes exactly the approved reordered stock filters", () => {
    expect(stockFilters).toEqual([
      { value: "all", label: "All" },
      { value: "in-stock", label: "In stock" },
      { value: "no-longer-in-stock", label: "No longer in stock" },
      { value: "waiting-on-arrival", label: "Waiting on arrival" },
      { value: "physically-here", label: "Physically here" },
    ]);
  });
});

describe("REQUIREMENT: parseStockFilter — direct URL query parameters restore the selected filter", () => {
  it("recognises every real value", () => {
    expect(parseStockFilter("in-stock")).toBe("in-stock");
    expect(parseStockFilter("waiting-on-arrival")).toBe("waiting-on-arrival");
    expect(parseStockFilter("physically-here")).toBe("physically-here");
    expect(parseStockFilter("no-longer-in-stock")).toBe("no-longer-in-stock");
  });
  it("falls back to 'all' for missing, empty, or unrecognised values — never throws", () => {
    expect(parseStockFilter(null)).toBe("all");
    expect(parseStockFilter(undefined)).toBe("all");
    expect(parseStockFilter("")).toBe("all");
    expect(parseStockFilter("bogus")).toBe("all");
    expect(parseStockFilter("all")).toBe("all");
  });
});

describe("matchesStockFilter — the four inventory views plus All", () => {
  const inStockUnarrived = purchase({ id: "a", stock_status: "in_stock", arrived: false });
  const inStockArrived = purchase({ id: "b", stock_status: "in_stock", arrived: true });
  const noLongerInStock = purchase({ id: "c", stock_status: "no_longer_in_stock", arrived: null });

  it("'all' matches every purchase regardless of stock/arrival state", () => {
    expect(matchesStockFilter(inStockUnarrived, "all")).toBe(true);
    expect(matchesStockFilter(inStockArrived, "all")).toBe(true);
    expect(matchesStockFilter(noLongerInStock, "all")).toBe(true);
  });
  it("'in-stock' matches both arrived and unarrived in-stock rows, never no_longer_in_stock", () => {
    expect(matchesStockFilter(inStockUnarrived, "in-stock")).toBe(true);
    expect(matchesStockFilter(inStockArrived, "in-stock")).toBe(true);
    expect(matchesStockFilter(noLongerInStock, "in-stock")).toBe(false);
  });
  it("'waiting-on-arrival' matches only in-stock + unarrived", () => {
    expect(matchesStockFilter(inStockUnarrived, "waiting-on-arrival")).toBe(true);
    expect(matchesStockFilter(inStockArrived, "waiting-on-arrival")).toBe(false);
    expect(matchesStockFilter(noLongerInStock, "waiting-on-arrival")).toBe(false);
  });
  it("'physically-here' matches only in-stock + arrived", () => {
    expect(matchesStockFilter(inStockArrived, "physically-here")).toBe(true);
    expect(matchesStockFilter(inStockUnarrived, "physically-here")).toBe(false);
    expect(matchesStockFilter(noLongerInStock, "physically-here")).toBe(false);
  });
  it("'no-longer-in-stock' matches only no_longer_in_stock rows", () => {
    expect(matchesStockFilter(noLongerInStock, "no-longer-in-stock")).toBe(true);
    expect(matchesStockFilter(inStockUnarrived, "no-longer-in-stock")).toBe(false);
    expect(matchesStockFilter(inStockArrived, "no-longer-in-stock")).toBe(false);
  });
});

describe("nextStockStatus — the row toggle's own PATCH target", () => {
  it("toggles in_stock to no_longer_in_stock and back", () => {
    expect(nextStockStatus("in_stock")).toBe("no_longer_in_stock");
    expect(nextStockStatus("no_longer_in_stock")).toBe("in_stock");
  });
});

// ============================================================================
// app/page.tsx — Home stock figures ignore the date-period filter
// ============================================================================
describe("REQUIREMENT: Home Stock Value KPI ignores the Compare period filter", () => {
  const source = readFileSync("app/page.tsx", "utf8");

  it("both stock value and supporting item count use the raw purchases array, never the period-scoped report", () => {
    expect(source).toContain("const stockValue = useMemo(() => calculateInStockValue(purchases), [purchases]);");
    expect(source).toContain('purchases.filter(row => row.stock_status === "in_stock").length');
    expect(source).not.toContain("calculateInStockValue(report.periodPurchases)");
  });
});

// ============================================================================
// Purchases page — ordering/default view unchanged, stock column present,
// toast wired, expenses unaffected.
// ============================================================================
describe("app/purchases/page.tsx — default view and ordering are unchanged", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("still defaults to showing all purchases (parseStockFilter('all') behaviour) — stock filter is never forced to 'in-stock' on load", () => {
    expect(source).toContain('parseStockFilter(searchParams.get("stock"))');
  });

  it("renders a Stock column with the sortable header pattern every other column already uses", () => {
    expect(source).toContain('{ label: "Stock", key: "stock_status" }');
  });

  it("renders StockStatusToggle in the new Stock column", () => {
    expect(source).toContain("<StockStatusToggle id={row.id} stockStatus={row.stock_status} description={row.item_description} onToggle={toggleStockStatus} />");
  });

  it("shows the bottom-right confirmation only after toggleStockStatus's own PATCH succeeds", () => {
    const fn = source.slice(source.indexOf("async function toggleStockStatus"), source.indexOf("const filteredRows"));
    expect(fn).toContain("if (!response.ok) return false;");
    const afterOkCheck = fn.slice(fn.indexOf("if (!response.ok) return false;"));
    expect(afterOkCheck).toContain("setStockToast(stockStatusChangedMessage(changed?.item_description, next));");
  });

  it("renders the bottom-right toast using TaskToast's position variant, never a new one-off component", () => {
    expect(source).toContain('{stockToast && <TaskToast message={stockToast} onDismiss={() => setStockToast(null)} position="bottom-right" />}');
  });

  it("REGRESSION: does not show a fabricated success toast when the PATCH fails — the failure path returns before setStockToast is ever reached", () => {
    const fn = source.slice(source.indexOf("async function toggleStockStatus"), source.indexOf("const filteredRows"));
    const failureBranch = fn.slice(fn.indexOf("if (!response.ok)"), fn.indexOf("if (!response.ok)") + 40);
    expect(failureBranch).toContain("return false;");
  });
});

describe("components/StockStatusToggle.tsx — mirrors ArrivalToggle's own self-contained pattern", () => {
  const source = readFileSync("components/StockStatusToggle.tsx", "utf8");

  it("stops the click from bubbling to the containing row (never opens the edit form / navigates)", () => {
    expect(source).toContain("event.stopPropagation()");
  });

  it("prevents double submission by disabling itself while a save is pending", () => {
    expect(source).toContain("if (pending) return");
    expect(source).toContain("disabled={pending}");
  });

  it("REQUIREMENT: restores the previous visible state and surfaces an error message on failure", () => {
    expect(source).toContain('setError("Could not save — try again.")');
    expect(source).toContain("setOptimistic(null)");
  });

  it("updates immediately on click — no confirmation dialog import or usage", () => {
    expect(source).not.toContain("ConfirmDialog");
    expect(source).not.toContain("window.confirm");
  });

  it("never renders an Undo action", () => {
    expect(source.toLowerCase()).not.toContain("undo");
  });

  it("clearly shows both possible states as visible text, not colour alone", () => {
    expect(source).toContain('{inStock ? "In stock" : "No longer in stock"}');
  });
});

describe("REGRESSION: expenses never show a stock-status control or gain inventory behaviour", () => {
  it("app/expenses/page.tsx never imports or renders StockStatusToggle", () => {
    const source = readFileSync("app/expenses/page.tsx", "utf8");
    expect(source).not.toContain("StockStatusToggle");
    expect(source).not.toContain("stock_status");
  });

  it("lib/types.ts's Expense type has no stock_status field", () => {
    const source = readFileSync("lib/types.ts", "utf8");
    const expenseType = source.slice(source.indexOf("export type Expense"), source.indexOf("export type Task"));
    expect(expenseType).not.toContain("stock_status");
  });

  it("lib/validation/purchase.ts's expenseInputSchema has no stock_status field", () => {
    const source = readFileSync("lib/validation/purchase.ts", "utf8");
    const expenseSchema = source.slice(source.indexOf("export const expenseInputSchema"), source.indexOf("export const expenseInputSchema") + 300);
    expect(expenseSchema).not.toContain("stock_status");
  });
});
