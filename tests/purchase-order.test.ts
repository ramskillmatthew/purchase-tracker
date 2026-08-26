import { describe, expect, it } from "vitest";
import { comparePurchasesBySkuSequence, comparePurchasesForDisplay, compareSkuDescending, sortPurchasesForDisplay } from "@/lib/purchase-order";
import type { Purchase } from "@/lib/types";

function purchase(overrides: Partial<Purchase> & { id: string }): Purchase {
  return {
    order_date: "2026-08-14",
    purchased_from: "Vinted",
    seller_name: "",
    sku: "1000",
    item_description: "Item",
    item_size: "N/A",
    quantity: 1,
    item_condition: "Brand new",
    category: "Other",
    price_purchased: 10,
    arrived: null,
    stock_status: "in_stock",
    created_at: "2026-08-14T10:00:00+00:00",
    ...overrides,
  };
}

describe("compareSkuDescending", () => {
  it("REQUIREMENT: numeric SKUs compare numerically, not textually — 1000 ranks above 999", () => {
    expect(compareSkuDescending("1000", "999")).toBeLessThan(0); // "1000" sorts first (descending)
  });

  it("plain text comparison would get this wrong — confirms the fix addresses a real bug", () => {
    expect("999" > "1000").toBe(true); // lexicographically "999" > "1000" — the bug this fixes
    expect(compareSkuDescending("1000", "999")).not.toBe(1);
  });

  it("REQUIREMENT: safe for arbitrarily large SKUs — no JS number precision loss", () => {
    const huge1 = "90071992547409915"; // well beyond Number.MAX_SAFE_INTEGER (2^53 - 1)
    const huge2 = "90071992547409914";
    expect(compareSkuDescending(huge1, huge2)).toBeLessThan(0);
    // A naive Number() conversion would round both to the same float and see them as equal.
    expect(Number(huge1)).toBe(Number(huge2)); // demonstrates the precision hazard this avoids
  });

  it("descending order: higher SKU sorts first", () => {
    expect(compareSkuDescending("1810", "1801")).toBeLessThan(0);
    expect(compareSkuDescending("1801", "1810")).toBeGreaterThan(0);
  });

  it("equal plain numeric SKUs compare equal", () => {
    expect(compareSkuDescending("1500", "1500")).toBe(0);
  });

  it("REQUIREMENT: a letter-prefixed SKU participates in the same numeric sequence", () => {
    expect(compareSkuDescending("AA1714", "1713")).toBeLessThan(0);
    expect(compareSkuDescending("1696", "AA1714")).toBeGreaterThan(0);
  });

  it("REQUIREMENT: when the numeric part matches, prefixed comes before plain", () => {
    expect(compareSkuDescending("AA1705", "1705")).toBeLessThan(0);
    expect(compareSkuDescending("1705", "AA1705")).toBeGreaterThan(0);
  });

  it("supports any letter-only prefix case-insensitively and preserves BigInt precision", () => {
    expect(compareSkuDescending("z90071992547409915", "90071992547409914")).toBeLessThan(0);
    expect(compareSkuDescending("aa1705", "AA1705")).toBe(0);
  });

  it("uses descending prefix text as a deterministic tie-break between prefixed variants", () => {
    expect(compareSkuDescending("BB1705", "AA1705")).toBeLessThan(0);
  });

  it("leading zeros don't distort numeric magnitude", () => {
    expect(compareSkuDescending("0100", "99")).toBeLessThan(0); // 100 > 99
  });

  it("REQUIREMENT: recognised numeric-sequence SKUs rank before unrecognised/blank ones", () => {
    expect(compareSkuDescending("1500", "ABC")).toBeLessThan(0);
    expect(compareSkuDescending("AA1500", "ABC")).toBeLessThan(0);
    expect(compareSkuDescending("ABC", "1500")).toBeGreaterThan(0);
    expect(compareSkuDescending("1500", "")).toBeLessThan(0);
    expect(compareSkuDescending("", "1500")).toBeGreaterThan(0);
  });

  it("REQUIREMENT: two non-numeric SKUs fall back to deterministic case-insensitive text descending", () => {
    expect(compareSkuDescending("VINTED-B", "VINTED-A")).toBeLessThan(0);
    expect(compareSkuDescending("vinted-a", "VINTED-B")).toBeGreaterThan(0); // case-insensitive
  });

  it("blank vs blank compares equal", () => {
    expect(compareSkuDescending("", "")).toBe(0);
    expect(compareSkuDescending("   ", "")).toBe(0); // whitespace-only trims to blank
  });

  it("never throws on null/undefined SKU — treated as blank", () => {
    expect(() => compareSkuDescending(null, undefined)).not.toThrow();
    expect(compareSkuDescending(null, "1500")).toBeGreaterThan(0);
  });

  it("a decimal-looking or negative-looking SKU is unrecognised rather than forced into the numeric sequence", () => {
    expect(compareSkuDescending("12.5", "1500")).toBeGreaterThan(0);
    expect(compareSkuDescending("-5", "1500")).toBeGreaterThan(0);
  });
});

describe("comparePurchasesForDisplay / sortPurchasesForDisplay", () => {
  it("REQUIREMENT: mixed input 1803, 1807, 1810, 1801 (same date) displays as 1810, 1807, 1803, 1801", () => {
    const rows = [
      purchase({ id: "a", sku: "1803" }),
      purchase({ id: "b", sku: "1807" }),
      purchase({ id: "c", sku: "1810" }),
      purchase({ id: "d", sku: "1801" }),
    ];
    expect(sortPurchasesForDisplay(rows).map(row => row.sku)).toEqual(["1810", "1807", "1803", "1801"]);
  });

  it("REQUIREMENT: mixed prefixed and plain SKUs use the extracted numeric sequence", () => {
    const rows = [
      purchase({ id: "plain-1715", sku: "1715" }),
      purchase({ id: "prefixed-1714", sku: "AA1714" }),
      purchase({ id: "plain-1705", sku: "1705" }),
      purchase({ id: "prefixed-1705", sku: "AA1705" }),
      purchase({ id: "plain-1696", sku: "1696" }),
    ];
    expect(sortPurchasesForDisplay(rows).map(row => row.sku)).toEqual(["1715", "AA1714", "AA1705", "1705", "1696"]);
  });

  it("EXACT APPROVED EXAMPLE: visible top-to-bottom order is newest/highest first with a prefix immediately above its matching plain number", () => {
    const bottomToTop = ["12", "AA12", "13", "A13", "14", "15", "AA15", "16", "17", "18", "AA18"];
    const rows = bottomToTop.map((sku, index) => purchase({ id: `approved-${index}`, sku }));
    expect(sortPurchasesForDisplay(rows).map(row => row.sku)).toEqual([
      "AA18", "18", "17", "16", "AA15", "15", "14", "A13", "13", "AA12", "12",
    ]);
  });

  it("EXACT APPROVED LARGE-SKU EXAMPLE follows the same top-to-bottom rule", () => {
    const rows = ["1704", "1705", "AA1705", "1706", "1707", "A1707", "1708", "1709", "AA1709"]
      .map((sku, index) => purchase({ id: `large-${index}`, sku }));
    expect(sortPurchasesForDisplay(rows).map(row => row.sku)).toEqual([
      "AA1709", "1709", "1708", "A1707", "1707", "1706", "AA1705", "1705", "1704",
    ]);
  });

  it("REQUIREMENT: a second example — 1808, 1809, 1810 displays as 1810, 1809, 1808", () => {
    const rows = [
      purchase({ id: "a", sku: "1808" }),
      purchase({ id: "b", sku: "1809" }),
      purchase({ id: "c", sku: "1810" }),
    ];
    expect(sortPurchasesForDisplay(rows).map(row => row.sku)).toEqual(["1810", "1809", "1808"]);
  });

  it("REQUIREMENT: input position never determines output order — reversing the input produces the identical result", () => {
    const rows = [
      purchase({ id: "a", sku: "1803" }),
      purchase({ id: "b", sku: "1807" }),
      purchase({ id: "c", sku: "1810" }),
      purchase({ id: "d", sku: "1801" }),
    ];
    const forward = sortPurchasesForDisplay(rows).map(row => row.id);
    const reversed = sortPurchasesForDisplay([...rows].reverse()).map(row => row.id);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["c", "b", "a", "d"]);
  });

  it("the general recent-purchases comparator still keeps newer order dates first", () => {
    const rows = [
      purchase({ id: "old-high-sku", order_date: "2026-08-01", sku: "9999" }),
      purchase({ id: "new-low-sku", order_date: "2026-08-14", sku: "1" }),
    ];
    expect(sortPurchasesForDisplay(rows).map(row => row.id)).toEqual(["new-low-sku", "old-high-sku"]);
  });

  it("REQUIREMENT: purchases without SKUs remain in chronological position rather than falling to the end", () => {
    const rows = [
      purchase({ id: "dated-24", order_date: "2026-05-24", sku: "1608" }),
      purchase({ id: "blank-22-a", order_date: "2026-05-22", sku: "" }),
      purchase({ id: "blank-22-b", order_date: "2026-05-22", sku: null as unknown as string }),
      purchase({ id: "dated-21", order_date: "2026-05-21", sku: "AA1607" }),
      purchase({ id: "blank-19", order_date: "2026-05-19", sku: "" }),
      purchase({ id: "dated-17", order_date: "2026-05-17", sku: "1607" }),
    ];
    expect(sortPurchasesForDisplay(rows).map(row => row.id)).toEqual([
      "dated-24", "blank-22-b", "blank-22-a", "dated-21", "blank-19", "dated-17",
    ]);
  });

  it("REGRESSION: differing dates never place plain 1714 above AA1714", () => {
    const rows = [
      purchase({ id: "plain", order_date: "2026-06-07", sku: "1714" }),
      purchase({ id: "prefixed", order_date: "2026-06-05", sku: "AA1714" }),
      purchase({ id: "next", order_date: "2026-06-05", sku: "1713" }),
    ];
    expect([...rows].sort(comparePurchasesBySkuSequence).map(row => row.sku)).toEqual(["AA1714", "1714", "1713"]);
  });

  it("REGRESSION: a whole prefixed run is interleaved with its matching plain sequence regardless of dates", () => {
    const rows = [
      purchase({ id: "p24", order_date: "2026-06-05", sku: "1624" }),
      purchase({ id: "p23", order_date: "2026-06-05", sku: "1623" }),
      purchase({ id: "p22", order_date: "2026-06-05", sku: "1622" }),
      purchase({ id: "aa24", order_date: "2026-06-02", sku: "AA1624" }),
      purchase({ id: "aa23", order_date: "2026-06-02", sku: "AA1623" }),
      purchase({ id: "aa22", order_date: "2026-06-02", sku: "AA1622" }),
      purchase({ id: "aa21", order_date: "2026-06-02", sku: "AA1621" }),
      purchase({ id: "p21", order_date: "2026-06-05", sku: "1621" }),
    ];
    expect([...rows].sort(comparePurchasesBySkuSequence).map(row => row.sku)).toEqual([
      "AA1624", "1624", "AA1623", "1623", "AA1622", "1622", "AA1621", "1621",
    ]);
  });

  it("REQUIREMENT: duplicate SKUs remain separate rows, ordered deterministically by created_at then id", () => {
    const rows = [
      purchase({ id: "z-later", sku: "1810", created_at: "2026-08-14T10:00:01+00:00" }),
      purchase({ id: "a-earlier", sku: "1810", created_at: "2026-08-14T10:00:00+00:00" }),
    ];
    const sorted = sortPurchasesForDisplay(rows);
    expect(sorted).toHaveLength(2);
    expect(sorted.map(row => row.id)).toEqual(["z-later", "a-earlier"]); // later created_at first
  });

  it("REQUIREMENT: identical date, SKU, AND created_at still resolves deterministically via id", () => {
    const rows = [
      purchase({ id: "bbbb", sku: "1810", created_at: "2026-08-14T10:00:00+00:00" }),
      purchase({ id: "aaaa", sku: "1810", created_at: "2026-08-14T10:00:00+00:00" }),
    ];
    const first = sortPurchasesForDisplay(rows).map(row => row.id);
    const second = sortPurchasesForDisplay([...rows].reverse()).map(row => row.id);
    expect(first).toEqual(second); // same regardless of input order
    expect(first).toEqual(["bbbb", "aaaa"]); // descending id
  });

  it("REQUIREMENT: non-numeric/blank SKUs rank after numeric ones within the same date, and are never rejected", () => {
    const rows = [
      purchase({ id: "blank", order_date: "2026-08-14", sku: "" }),
      purchase({ id: "text", order_date: "2026-08-14", sku: "SPECIAL" }),
      purchase({ id: "numeric", order_date: "2026-08-14", sku: "5" }),
    ];
    const sorted = sortPurchasesForDisplay(rows);
    expect(sorted[0].id).toBe("numeric");
    expect(sorted).toHaveLength(3); // nothing dropped
  });

  it("REQUIREMENT: invalid/failed Bulk Input rows never existed as saved rows, so they can't affect alignment of the valid ones that were sorted", () => {
    // Simulated: only the rows that actually made it past validation are
    // ever passed to the sort — this is a property of the pipeline (invalid
    // rows are filtered out client-side and again server-side before
    // insert), not something the comparator itself needs to guard against.
    const validOnly = [purchase({ id: "a", sku: "1810" }), purchase({ id: "b", sku: "1801" })];
    expect(sortPurchasesForDisplay(validOnly).map(row => row.id)).toEqual(["a", "b"]);
  });

  it("REQUIREMENT: multiple separate Bulk Input batches combine into one correctly-ordered list", () => {
    // Batch 1 (earlier created_at) and batch 2 (later) both target the same date.
    const batch1 = [
      purchase({ id: "b1-1801", sku: "1801", created_at: "2026-08-14T09:00:00+00:00" }),
      purchase({ id: "b1-1803", sku: "1803", created_at: "2026-08-14T09:00:00+00:00" }),
    ];
    const batch2 = [
      purchase({ id: "b2-1810", sku: "1810", created_at: "2026-08-14T11:00:00+00:00" }),
      purchase({ id: "b2-1807", sku: "1807", created_at: "2026-08-14T11:00:00+00:00" }),
    ];
    const combined = sortPurchasesForDisplay([...batch1, ...batch2]);
    expect(combined.map(row => row.sku)).toEqual(["1810", "1807", "1803", "1801"]);
  });

  it("REQUIREMENT: ordering is correct across a pagination boundary — sorting first, then slicing, never sorting a single page in isolation", () => {
    const rows = Array.from({ length: 25 }, (_, i) => purchase({ id: `id-${i}`, sku: String(i + 1) }));
    const sorted = sortPurchasesForDisplay(rows);
    const page1 = sorted.slice(0, 10);
    const page2 = sorted.slice(10, 20);
    expect(page1[0].sku).toBe("25");
    expect(page1[9].sku).toBe("16");
    expect(page2[0].sku).toBe("15"); // continues seamlessly from page 1's last item
  });

  it("does not mutate the input array", () => {
    const rows = [purchase({ id: "a", sku: "1" }), purchase({ id: "b", sku: "2" })];
    const original = [...rows];
    sortPurchasesForDisplay(rows);
    expect(rows).toEqual(original);
  });

  it("comparePurchasesForDisplay is usable directly as a comparator (returns a real number, not just a boolean)", () => {
    const a = purchase({ id: "a", sku: "10" });
    const b = purchase({ id: "b", sku: "5" });
    expect(comparePurchasesForDisplay(a, b)).toBeLessThan(0);
    expect(comparePurchasesForDisplay(b, a)).toBeGreaterThan(0);
  });
});
