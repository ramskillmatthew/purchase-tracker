import { describe, expect, it } from "vitest";
import { comparePurchasesForDisplay, compareSkuDescending, sortPurchasesForDisplay } from "@/lib/purchase-order";
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

  it("equal numeric SKUs compare equal", () => {
    expect(compareSkuDescending("1500", "1500")).toBe(0);
  });

  it("leading zeros don't distort numeric magnitude", () => {
    expect(compareSkuDescending("0100", "99")).toBeLessThan(0); // 100 > 99
  });

  it("REQUIREMENT: numeric SKUs always rank before non-numeric/blank ones", () => {
    expect(compareSkuDescending("1500", "ABC")).toBeLessThan(0);
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

  it("a decimal-looking or negative-looking SKU is treated as non-numeric (only pure digit strings are numeric)", () => {
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

  it("REQUIREMENT: a newer order date always outranks an older one, even with a much lower SKU", () => {
    const rows = [
      purchase({ id: "old-high-sku", order_date: "2026-08-01", sku: "9999" }),
      purchase({ id: "new-low-sku", order_date: "2026-08-14", sku: "1" }),
    ];
    expect(sortPurchasesForDisplay(rows).map(row => row.id)).toEqual(["new-low-sku", "old-high-sku"]);
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
