import { describe, expect, it } from "vitest";
import { allocateEqually, allocateProportionally, expandOrderToRows, penceToPounds, poundsToPence } from "@/lib/purchase-import/allocate";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("poundsToPence / penceToPounds", () => {
  it("round-trips exactly", () => {
    expect(poundsToPence(300)).toBe(30000);
    expect(poundsToPence(10)).toBe(1000);
    expect(poundsToPence(14.19)).toBe(1419);
    expect(penceToPounds(30000)).toBe(300);
    expect(penceToPounds(1419)).toBe(14.19);
  });
});

describe("allocateEqually", () => {
  it("REGRESSION: splits £300 across 3 units into exactly £100 each, matching the reported example", () => {
    expect(allocateEqually(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  it("REGRESSION: splits £10 across 3 units without losing or inventing a penny", () => {
    const result = allocateEqually(1000, 3);
    expect(result).toEqual([334, 333, 333]);
    expect(sum(result)).toBe(1000);
  });

  it("gives the remainder to the first rows, deterministically", () => {
    expect(allocateEqually(101, 3)).toEqual([34, 34, 33]);
    expect(allocateEqually(100, 7)).toEqual([15, 15, 14, 14, 14, 14, 14]);
  });

  it("handles a single unit (the whole total)", () => {
    expect(allocateEqually(1999, 1)).toEqual([1999]);
  });

  it("handles a zero total", () => {
    expect(allocateEqually(0, 3)).toEqual([0, 0, 0]);
  });

  it("returns an empty array for zero or negative count", () => {
    expect(allocateEqually(1000, 0)).toEqual([]);
    expect(allocateEqually(1000, -1)).toEqual([]);
  });

  it("always sums back to the exact total, for many divisors", () => {
    for (let count = 1; count <= 13; count += 1) {
      for (const total of [1, 7, 99, 1000, 30000, 123456]) {
        expect(sum(allocateEqually(total, count))).toBe(total);
      }
    }
  });
});

describe("allocateProportionally", () => {
  it("splits proportionally to each weight and sums exactly", () => {
    const result = allocateProportionally(10000, [3000, 1000]); // 3:1 ratio
    expect(result).toEqual([7500, 2500]);
    expect(sum(result)).toBe(10000);
  });

  it("folds in shared delivery/fees while preserving relative item value", () => {
    // Two items priced £20 and £10 (2:1), plus £3 delivery folded into a
    // £33 total — the £20 item should still get roughly double the £10
    // item's share, and the two rows must sum to exactly £33.
    const result = allocateProportionally(3300, [2000, 1000]);
    expect(sum(result)).toBe(3300);
    expect(result[0]).toBeGreaterThan(result[1]);
  });

  it("falls back to an even split when every weight is zero", () => {
    expect(allocateProportionally(900, [0, 0, 0])).toEqual([300, 300, 300]);
  });

  it("distributes the remainder deterministically so the sum is always exact", () => {
    const result = allocateProportionally(1000, [1, 1, 1]);
    expect(sum(result)).toBe(1000);
  });

  it("returns an empty array for no weights", () => {
    expect(allocateProportionally(1000, [])).toEqual([]);
  });
});

describe("expandOrderToRows", () => {
  it("REGRESSION: a single item with quantity 3 and a £300 total becomes three £100 rows", () => {
    const result = expandOrderToRows([{ description: "Pokémon Elite Trainer Box", size: null, condition: null, quantity: 3, linePricePence: null }], 30000);
    expect(result.allocationOk).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map(row => row.pricePence)).toEqual([10000, 10000, 10000]);
    expect(result.rows.every(row => row.itemIndex === 0)).toBe(true);
    expect(result.rows.map(row => row.unitIndex)).toEqual([0, 1, 2]);
  });

  it("REGRESSION: a single item with quantity 3 and a £10 total produces rows that sum to exactly £10", () => {
    const result = expandOrderToRows([{ description: "Item", size: null, condition: null, quantity: 3, linePricePence: null }], 1000);
    expect(sum(result.rows.map(row => row.pricePence ?? 0))).toBe(1000);
    expect(result.rows.map(row => row.pricePence)).toEqual([334, 333, 333]);
  });

  it("a single item, quantity 1, keeps the whole total on one row", () => {
    const result = expandOrderToRows([{ description: "Solo item", size: "M", condition: "Brand new", quantity: 1, linePricePence: null }], 1850);
    expect(result.rows).toEqual([{ description: "Solo item", size: "M", condition: "Brand new", itemIndex: 0, unitIndex: 0, pricePence: 1850 }]);
    expect(result.allocationOk).toBe(true);
  });

  it("multiple differently-priced items with known line prices allocate proportionally and sum exactly", () => {
    const result = expandOrderToRows([
      { description: "Item A", size: null, condition: null, quantity: 1, linePricePence: 2000 },
      { description: "Item B", size: null, condition: null, quantity: 1, linePricePence: 1000 },
    ], 3300); // includes £3 shared delivery/fees
    expect(result.allocationOk).toBe(true);
    expect(sum(result.rows.map(row => row.pricePence ?? 0))).toBe(3300);
    expect(result.rows.find(row => row.description === "Item A")!.pricePence).toBeGreaterThan(result.rows.find(row => row.description === "Item B")!.pricePence!);
  });

  it("multiple items each with quantity > 1 and known line prices expand every unit and still sum exactly", () => {
    const result = expandOrderToRows([
      { description: "Item A", size: null, condition: null, quantity: 2, linePricePence: 2000 },
      { description: "Item B", size: null, condition: null, quantity: 3, linePricePence: 1000 },
    ], 10000);
    expect(result.rows).toHaveLength(5);
    expect(sum(result.rows.map(row => row.pricePence ?? 0))).toBe(10000);
    expect(result.rows.filter(row => row.description === "Item A")).toHaveLength(2);
    expect(result.rows.filter(row => row.description === "Item B")).toHaveLength(3);
  });

  it("REGRESSION: multiple items without reliable individual prices split evenly per unit and are flagged for review, never guessed silently", () => {
    const result = expandOrderToRows([
      { description: "Item A", size: null, condition: null, quantity: 1, linePricePence: null },
      { description: "Item B", size: null, condition: null, quantity: 1, linePricePence: 2500 },
    ], 5000);
    expect(result.allocationOk).toBe(false);
    expect(result.reason).toMatch(/split evenly/i);
    expect(sum(result.rows.map(row => row.pricePence ?? 0))).toBe(5000);
  });

  it("REGRESSION: an unknown order total never invents row prices — every row is null and the order is flagged", () => {
    const result = expandOrderToRows([{ description: "Mystery item", size: null, condition: null, quantity: 2, linePricePence: null }], null);
    expect(result.allocationOk).toBe(false);
    expect(result.reason).toMatch(/could not be determined/i);
    expect(result.rows.every(row => row.pricePence === null)).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it("returns no rows for an empty item list", () => {
    expect(expandOrderToRows([], 1000)).toEqual({ rows: [], allocationOk: true, reason: null });
  });

  it("treats a quantity of 0 or negative as 1 unit, never producing zero rows for a real item", () => {
    const result = expandOrderToRows([{ description: "Item", size: null, condition: null, quantity: 0, linePricePence: null }], 500);
    expect(result.rows).toHaveLength(1);
  });

  it("REGRESSION: linePricePence is the LINE TOTAL (quantity already folded in), not a per-unit price — Item A qty 2 @ £20/unit (line total £40) and Item B qty 1 @ £10, complete charged total £55 including fees, weight correctly between items and each row lands on its exact expected price", () => {
    // If linePricePence were mistakenly treated as a per-unit price without
    // multiplying by quantity, Item A's weight would be understated (2000
    // instead of its true 4000 line total), giving it too small a share of
    // the shared £5 fees relative to Item B — this test pins the correct,
    // exact per-row output so that regression can never creep back in.
    const result = expandOrderToRows([
      { description: "Item A", size: null, condition: null, quantity: 2, linePricePence: 4000 }, // £20/unit x 2 = £40 line total
      { description: "Item B", size: null, condition: null, quantity: 1, linePricePence: 1000 }, // £10 line total
    ], 5500); // £55 complete charged total (£50 items + £5 shared fees)
    expect(result.allocationOk).toBe(true);
    expect(result.rows).toHaveLength(3);
    const itemARows = result.rows.filter(row => row.description === "Item A").map(row => row.pricePence);
    const itemBRows = result.rows.filter(row => row.description === "Item B").map(row => row.pricePence);
    // Item A's £40 line (80% of the £50 item total) proportionally absorbs
    // 80% of the £55 grand total = £44, split evenly across its 2 units.
    expect(itemARows).toEqual([2200, 2200]);
    // Item B's £10 line (20%) absorbs the remaining £11.
    expect(itemBRows).toEqual([1100]);
    expect(sum(result.rows.map(row => row.pricePence ?? 0))).toBe(5500);
  });
});
