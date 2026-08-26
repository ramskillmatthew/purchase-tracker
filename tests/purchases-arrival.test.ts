import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  arrivalFilters,
  awaitingArrivalItemsLabel,
  awaitingArrivalMessage,
  calculateAwaitingArrivalValue,
  countAwaitingArrival,
  isArrived,
  isAwaitingArrival,
  matchesArrivalFilter,
  parseArrivalFilter,
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

describe("isArrived — null/blank old records are never a third state", () => {
  it("true only when arrived is exactly true", () => {
    expect(isArrived(purchase({ arrived: true }))).toBe(true);
  });
  it("false when arrived is false", () => {
    expect(isArrived(purchase({ arrived: false }))).toBe(false);
  });
  it("false when arrived is null (older records that predate the field, or were never set)", () => {
    expect(isArrived(purchase({ arrived: null }))).toBe(false);
  });
});

describe("parseArrivalFilter — safe restore from the ?arrived= query param", () => {
  it("recognises 'not-arrived' and 'arrived'", () => {
    expect(parseArrivalFilter("not-arrived")).toBe("not-arrived");
    expect(parseArrivalFilter("arrived")).toBe("arrived");
  });
  it("falls back to 'all' for missing, empty, or unrecognised values", () => {
    expect(parseArrivalFilter(null)).toBe("all");
    expect(parseArrivalFilter(undefined)).toBe("all");
    expect(parseArrivalFilter("")).toBe("all");
    expect(parseArrivalFilter("bogus")).toBe("all");
    expect(parseArrivalFilter("all")).toBe("all");
  });
});

describe("matchesArrivalFilter", () => {
  const arrived = purchase({ id: "a", arrived: true });
  const notArrived = purchase({ id: "b", arrived: false });
  const blank = purchase({ id: "c", arrived: null });

  it("'all' matches every purchase regardless of arrival state", () => {
    expect(matchesArrivalFilter(arrived, "all")).toBe(true);
    expect(matchesArrivalFilter(notArrived, "all")).toBe(true);
    expect(matchesArrivalFilter(blank, "all")).toBe(true);
  });
  it("'arrived' matches only arrived === true", () => {
    expect(matchesArrivalFilter(arrived, "arrived")).toBe(true);
    expect(matchesArrivalFilter(notArrived, "arrived")).toBe(false);
    expect(matchesArrivalFilter(blank, "arrived")).toBe(false);
  });
  it("'not-arrived' matches false AND null/blank (old records default to not arrived)", () => {
    expect(matchesArrivalFilter(arrived, "not-arrived")).toBe(false);
    expect(matchesArrivalFilter(notArrived, "not-arrived")).toBe(true);
    expect(matchesArrivalFilter(blank, "not-arrived")).toBe(true);
  });
});

describe("countAwaitingArrival — Home page card total", () => {
  it("counts false and null as outstanding, true as received", () => {
    const purchases = [
      purchase({ id: "1", arrived: true }),
      purchase({ id: "2", arrived: false }),
      purchase({ id: "3", arrived: null }),
      purchase({ id: "4", arrived: false }),
    ];
    expect(countAwaitingArrival(purchases)).toBe(3);
  });
  it("zero outstanding arrivals returns 0, not an error or NaN", () => {
    expect(countAwaitingArrival([purchase({ arrived: true })])).toBe(0);
  });
  it("an empty purchase list returns 0", () => {
    expect(countAwaitingArrival([])).toBe(0);
  });
});

describe("isAwaitingArrival — the single shared eligibility rule", () => {
  it("is the exact inverse of isArrived, for every arrival state", () => {
    for (const arrived of [true, false, null]) {
      const row = purchase({ arrived });
      expect(isAwaitingArrival(row)).toBe(!isArrived(row));
    }
  });

  it("countAwaitingArrival and calculateAwaitingArrivalValue agree on which rows are eligible", () => {
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: 25.5 }),
      purchase({ id: "2", arrived: null, price_purchased: 40 }),
      purchase({ id: "3", arrived: true, price_purchased: 100 }),
    ];
    // Re-derive the count from the same isAwaitingArrival predicate the value
    // helper uses, and confirm countAwaitingArrival matches it exactly — the
    // two helpers can never silently disagree about which rows are eligible.
    const eligibleByPredicate = purchases.filter(isAwaitingArrival).length;
    expect(countAwaitingArrival(purchases)).toBe(eligibleByPredicate);
    expect(eligibleByPredicate).toBe(2);
  });
});

describe("calculateAwaitingArrivalValue — combined £ value of the same backlog countAwaitingArrival counts", () => {
  // Mirrors the prompt's worked example set. Expenses are modelled as a
  // completely separate array/type in this app (Expense, not Purchase), so
  // "excluding expenses" means never passing the expenses array in here —
  // there is no `type` field on Purchase to filter, by design.
  it("REQUIREMENT: matches the exact worked example — several not-arrived purchases with valid prices sum to 65.5", () => {
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: 25.5 }),
      purchase({ id: "2", arrived: null, price_purchased: 40 }),
      purchase({ id: "3", arrived: true, price_purchased: 100 }),
    ];
    expect(calculateAwaitingArrivalValue(purchases)).toBe(65.5);
  });

  it("a mixture of arrived and not-arrived purchases only sums the not-arrived ones", () => {
    const purchases = [
      purchase({ id: "1", arrived: true, price_purchased: 999 }),
      purchase({ id: "2", arrived: false, price_purchased: 12.25 }),
      purchase({ id: "3", arrived: true, price_purchased: 500 }),
      purchase({ id: "4", arrived: false, price_purchased: 7.75 }),
    ];
    expect(calculateAwaitingArrivalValue(purchases)).toBe(20);
  });

  it("null arrival status is treated as not arrived and included", () => {
    expect(calculateAwaitingArrivalValue([purchase({ arrived: null, price_purchased: 30 })])).toBe(30);
  });

  it("a null price is ignored (contributes 0), never thrown or NaN", () => {
    const purchases = [purchase({ arrived: false, price_purchased: null as unknown as number })];
    expect(calculateAwaitingArrivalValue(purchases)).toBe(0);
  });

  it("a blank/whitespace string price is ignored — Number('') is 0, which must NOT be silently counted", () => {
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: "" as unknown as number }),
      purchase({ id: "2", arrived: false, price_purchased: "   " as unknown as number }),
      purchase({ id: "3", arrived: false, price_purchased: 15 }),
    ];
    expect(calculateAwaitingArrivalValue(purchases)).toBe(15);
  });

  it("an invalid/non-numeric price is ignored", () => {
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: "abc" as unknown as number }),
      purchase({ id: "2", arrived: false, price_purchased: NaN }),
      purchase({ id: "3", arrived: false, price_purchased: 5 }),
    ];
    expect(calculateAwaitingArrivalValue(purchases)).toBe(5);
  });

  it("numeric-string prices (defensive against a non-numeric API response) are parsed correctly, never string-concatenated", () => {
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: "25.50" as unknown as number }),
      purchase({ id: "2", arrived: false, price_purchased: "10" as unknown as number }),
    ];
    const total = calculateAwaitingArrivalValue(purchases);
    expect(total).toBe(35.5); // not "25.5010" — the string-concatenation bug this guards against
    expect(typeof total).toBe("number");
  });

  it("decimal prices are summed without individually rounding first", () => {
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: 10.1 }),
      purchase({ id: "2", arrived: false, price_purchased: 10.2 }),
      purchase({ id: "3", arrived: false, price_purchased: 10.3 }),
    ];
    expect(calculateAwaitingArrivalValue(purchases)).toBeCloseTo(30.6, 10);
  });

  it("zero-price purchases are valid and included (contribute 0, not excluded from eligibility)", () => {
    const purchases = [purchase({ arrived: false, price_purchased: 0 }), purchase({ arrived: false, price_purchased: 10 })];
    expect(calculateAwaitingArrivalValue(purchases)).toBe(10);
    expect(countAwaitingArrival(purchases)).toBe(2);
  });

  it("an empty purchase array returns 0", () => {
    expect(calculateAwaitingArrivalValue([])).toBe(0);
  });

  it("REQUIREMENT: UK currency formatting produces exactly '£65.50' for the worked example", () => {
    const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
    const purchases = [
      purchase({ id: "1", arrived: false, price_purchased: 25.5 }),
      purchase({ id: "2", arrived: null, price_purchased: 40 }),
      purchase({ id: "3", arrived: true, price_purchased: 100 }),
    ];
    expect(money.format(calculateAwaitingArrivalValue(purchases))).toBe("£65.50");
  });
});

describe("awaitingArrivalItemsLabel — correct singular/plural wording for the Home card's main line", () => {
  it("singular for exactly 1", () => {
    expect(awaitingArrivalItemsLabel(1)).toBe("1 item");
  });
  it("plural for 0 and for more than 1", () => {
    expect(awaitingArrivalItemsLabel(0)).toBe("0 items");
    expect(awaitingArrivalItemsLabel(2)).toBe("2 items");
    expect(awaitingArrivalItemsLabel(12)).toBe("12 items");
  });
  it("large counts are locale-formatted", () => {
    expect(awaitingArrivalItemsLabel(1234)).toBe("1,234 items");
  });
});

describe("awaitingArrivalMessage — correct singular/plural wording", () => {
  it("singular for exactly 1", () => {
    expect(awaitingArrivalMessage(1)).toBe("1 awaiting arrival");
  });
  it("plural for 0 and for more than 1", () => {
    expect(awaitingArrivalMessage(0)).toBe("0 awaiting arrival");
    expect(awaitingArrivalMessage(12)).toBe("12 awaiting arrival");
  });
  it("large counts are locale-formatted (e.g. 1,234)", () => {
    expect(awaitingArrivalMessage(1234)).toBe("1,234 awaiting arrival");
  });
});

describe("arrivalFilters — the three options the Purchases page filter renders", () => {
  it("exposes exactly All, Not arrived, Arrived in that order", () => {
    expect(arrivalFilters).toEqual([
      { value: "all", label: "All" },
      { value: "not-arrived", label: "Not arrived" },
      { value: "arrived", label: "Arrived" },
    ]);
  });
});

describe("app/purchases/page.tsx — arrival toggle wiring (structural, no React test harness in this project)", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("toggling arrival updates the one row in place via PATCH, never a full page reload", () => {
    const fn = source.slice(source.indexOf("async function toggleArrived"), source.indexOf("async function toggleStockStatus"));
    expect(fn).toContain('method: "PATCH"');
    expect(fn).toContain("setRows(current => current.map(row => row.id === id ? { ...row, arrived: next } : row))");
    expect(fn).not.toContain("load()");
  });

  it("is wrapped in Suspense (useSearchParams requirement)", () => {
    expect(source).toContain('<Suspense fallback={null}><PurchasesPageInner /></Suspense>');
  });

  it("renders the ArrivalToggle control in the Arrived column, not a plain status label", () => {
    expect(source).toContain("<ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} />");
    expect(source).not.toContain('status-cell status-yes" : "status-cell status-no');
  });

  // REGRESSION (Stock status feature) — the old 3-way arrival-only filter
  // switch (All/Not arrived/Arrived) was REPLACED by the new 5-way stock
  // filter switch, never rendered alongside it: keeping both would let a
  // user combine an independent arrival filter with an independent stock
  // filter into a contradictory/confusing state, which the feature's own
  // brief explicitly warns against.
  it("REGRESSION: the old arrival-only filter switch and its ?arrived= query param are gone from this page — replaced by the stock filter switch", () => {
    expect(source).not.toContain("arrivalFilters");
    expect(source).not.toContain("matchesArrivalFilter");
    expect(source).not.toContain('parseArrivalFilter(searchParams.get("arrived"))');
    expect(source).not.toContain("arrival-filter-switch");
  });
});

describe("components/ArrivalToggle.tsx — accessible, self-contained toggle control", () => {
  const source = readFileSync("components/ArrivalToggle.tsx", "utf8");

  it("stops the click from bubbling to the containing row (never opens the edit form / navigates)", () => {
    expect(source).toContain("event.stopPropagation()");
  });

  it("disables itself while a save is pending, preventing repeated clicks", () => {
    expect(source).toContain("if (pending) return");
    expect(source).toContain("disabled={pending}");
  });

  it("restores the previous state and surfaces an error message on failure", () => {
    expect(source).toContain('setError("Could not save — try again.")');
    expect(source).toContain("setOptimistic(null)");
  });

  it("has an accessible label following the 'Mark [item] as arrived' phrasing", () => {
    expect(source).toContain("`Mark ${label} as not arrived`");
    expect(source).toContain("`Mark ${label} as arrived`");
    expect(source).toContain("aria-label={actionLabel}");
  });

  it("falls back to a safe label when the purchase has no item description", () => {
    expect(source).toContain('const label = (description ?? "").trim() || "this purchase";');
  });
});

describe("components/GlobalPurchaseSearch.tsx — arrival toggle available directly from search results", () => {
  const source = readFileSync("components/GlobalPurchaseSearch.tsx", "utf8");

  it("renders ArrivalToggle inside each result, without nesting it inside the navigation button", () => {
    expect(source).toContain("<ArrivalToggle id={purchase.id}");
    // The result wrapper must be a plain element (div), not a <button> —
    // nesting a <button> (ArrivalToggle) inside another <button> is invalid
    // HTML and was the old structure before this feature.
    expect(source).toContain('<div key={purchase.id} className="global-search-result" role="option"');
    expect(source).not.toContain('<button key={purchase.id}');
  });

  it("updates its own local purchases list on a successful toggle, rather than refetching", () => {
    const fn = source.slice(source.indexOf("async function toggleArrived"), source.length);
    expect(fn).toContain("setPurchases(current => current.map(purchase => purchase.id === id ? { ...purchase, arrived: next } : purchase))");
  });
});

describe("app/page.tsx — Home page Stock value card", () => {
  const source = readFileSync("app/page.tsx", "utf8");

  it("computes the count and £ value from the full fetched purchases array, independent of the selected period", () => {
    expect(source).toContain("const stockValue = useMemo(() => calculateInStockValue(purchases), [purchases]);");
    expect(source).toContain('purchases.filter(row => row.stock_status === "in_stock").length');
  });

  it("shows the £ value as the main figure and the item count as supporting text, per the requested structure", () => {
    expect(source).toContain('{ name: "stock" as const, label: "Stock value", value: loading ? "—" : money.format(stockValue)');
    expect(source).toContain('caption: `${purchases.filter(row => row.stock_status === "in_stock").length} items in stock`');
  });

  it("reuses the existing `money` currency formatter rather than manually concatenating £", () => {
    expect(source).toContain('const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });');
    expect(source).not.toMatch(/£\$\{inStockValue/);
  });

  it("uses the approved integrated six-metric KPI strip", () => {
    expect(source).toContain("styles.kpis");
    expect(source).toContain('label: "Revenue"');
    expect(source).toContain('label: "Net profit"');
    expect(source).toContain('label: "Margin"');
  });
});

describe("app/page.tsx — approved Home KPI strip replaces the old awaiting-arrival card", () => {
  const source = readFileSync("app/page.tsx", "utf8");

  it("does not retain either obsolete awaiting-arrival summary card", () => {
    expect(source).not.toContain("In stock awaiting arrival");
    expect(source).not.toContain("summary-arrival");
    expect(source).not.toContain('router.push("/purchases?arrived=not-arrived")');
  });
});
