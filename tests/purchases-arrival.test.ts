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
    item_description: "Item", item_size: "M", quantity: 1, item_condition: "Brand new",
    price_purchased: 10, arrived: null, created_at: "2026-01-01T00:00:00Z",
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

describe("app/purchases/page.tsx — arrival filter + toggle wiring (structural, no React test harness in this project)", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("filters rows by arrival status before sorting, so pagination/sort never operate on the unfiltered set", () => {
    expect(source).toContain('const filteredRows = useMemo(() => rows.filter(row => matchesArrivalFilter(row, arrivalFilter)), [rows, arrivalFilter]);');
    expect(source).toContain("const sortedRows = useMemo(() => [...filteredRows].sort((a, b) => {");
  });

  it("changing the arrival filter resets to page 1", () => {
    const fn = source.slice(source.indexOf("function changeArrivalFilter"), source.indexOf("// Restored after mount"));
    expect(fn).toContain("setPage(1)");
  });

  it("toggling arrival updates the one row in place via PATCH, never a full reload()", () => {
    const fn = source.slice(source.indexOf("async function toggleArrived"), source.indexOf("const filteredRows"));
    expect(fn).toContain('method: "PATCH"');
    expect(fn).toContain("setRows(current => current.map(row => row.id === id ? { ...row, arrived: next } : row))");
    expect(fn).not.toContain("load()");
  });

  it("reads the initial filter from the ?arrived= query param (Home page card deep-link)", () => {
    expect(source).toContain('parseArrivalFilter(searchParams.get("arrived"))');
  });

  it("is wrapped in Suspense (useSearchParams requirement)", () => {
    expect(source).toContain('<Suspense fallback={null}><PurchasesPageInner /></Suspense>');
  });

  it("renders the ArrivalToggle control in the Arrived column, not a plain status label", () => {
    expect(source).toContain("<ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} />");
    expect(source).not.toContain('status-cell status-yes" : "status-cell status-no');
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

describe("app/page.tsx — Home page Awaiting arrival card", () => {
  const source = readFileSync("app/page.tsx", "utf8");

  it("computes the count from the full fetched purchases array, independent of the selected period", () => {
    expect(source).toContain("const awaitingArrival = useMemo(() => countAwaitingArrival(purchases), [purchases]);");
  });

  it("computes the £ value from the same purchases array — no separate fetch, no period dependency", () => {
    expect(source).toContain("const awaitingArrivalValue = useMemo(() => calculateAwaitingArrivalValue(purchases), [purchases]);");
    // Guards against a second useEffect/fetch being added solely for this value.
    expect(source.match(/fetch\(/g) || []).toHaveLength(2); // /api/purchases + /api/expenses only
  });

  it("displays both the item count and the £ stock value on the card, per the suggested structure", () => {
    const start = source.indexOf('className={loading ? "summary-arrival"');
    const article = source.slice(start, source.indexOf("</article>", start));
    expect(article).toContain("<span>Awaiting arrival</span>");
    expect(article).toContain("awaitingArrivalItemsLabel(awaitingArrival)");
    expect(article).toContain('`${money.format(awaitingArrivalValue)} stock value`');
  });

  it("reuses the existing `money` currency formatter rather than manually concatenating £", () => {
    expect(source).toContain('const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });');
    expect(source).not.toMatch(/£\$\{awaitingArrivalValue/);
  });

  it("clicking the card navigates to the Purchases page pre-filtered to Not arrived", () => {
    expect(source).toContain('router.push("/purchases?arrived=not-arrived")');
  });

  it("the card is keyboard-activatable (Enter) as well as clickable", () => {
    const start = source.indexOf('className={loading ? "summary-arrival"');
    const article = source.slice(start, source.indexOf("</article>", start));
    expect(article).toContain("onKeyDown");
    expect(article).toContain('event.key === "Enter"');
  });
});
