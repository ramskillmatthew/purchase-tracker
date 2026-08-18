import { describe, expect, it } from "vitest";
import { computeBasketAllocation, normalizeRevenueInputPence, type BasketUnit } from "@/lib/sales/allocation";

describe("computeBasketAllocation — total revenue mode", () => {
  it("REQUIREMENT: three identical-description units with DIFFERENT purchase costs get correctly different exact profit — never total-profit/N", () => {
    const units: BasketUnit[] = [
      { purchaseId: "a", costPence: 1000 }, // £10
      { purchaseId: "b", costPence: 1500 }, // £15
      { purchaseId: "c", costPence: 2000 }, // £20
    ];
    const allocations = computeBasketAllocation(units, "total", 9000, 0, 0); // £90 revenue, split evenly £30 each
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a]));
    expect(byId.a.revenuePence).toBe(3000);
    expect(byId.b.revenuePence).toBe(3000);
    expect(byId.c.revenuePence).toBe(3000);
    // Same revenue share, different cost -> different profit, never equal.
    expect(byId.a.profitPence).toBe(2000); // 3000 - 1000
    expect(byId.b.profitPence).toBe(1500); // 3000 - 1500
    expect(byId.c.profitPence).toBe(1000); // 3000 - 2000
    expect(new Set([byId.a.profitPence, byId.b.profitPence, byId.c.profitPence]).size).toBe(3);
  });

  it("REQUIREMENT: the sum of exact unit profits equals total profit", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 999 }, { purchaseId: "b", costPence: 1234 }, { purchaseId: "c", costPence: 501 }];
    const totalRevenuePence = 10000;
    const feesPence = 450;
    const postagePence = 300;
    const allocations = computeBasketAllocation(units, "total", totalRevenuePence, feesPence, postagePence);
    const totalCost = units.reduce((sum, u) => sum + u.costPence, 0);
    const expectedTotalProfit = totalRevenuePence - totalCost - feesPence - postagePence;
    expect(allocations.reduce((sum, a) => sum + a.profitPence, 0)).toBe(expectedTotalProfit);
  });

  it("REQUIREMENT: deterministic penny remainder — an odd total splits reproducibly, remainder to the first UUID-sorted units", () => {
    const units: BasketUnit[] = [{ purchaseId: "c", costPence: 0 }, { purchaseId: "a", costPence: 0 }, { purchaseId: "b", costPence: 0 }];
    const allocations = computeBasketAllocation(units, "total", 100, 0, 0); // 100/3 = 33,33,34 with remainder to sorted-first
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a.revenuePence]));
    // sorted order is a, b, c — remainder (1p) goes to the first sorted unit ("a")
    expect(byId.a).toBe(34);
    expect(byId.b).toBe(33);
    expect(byId.c).toBe(33);
    expect(byId.a + byId.b + byId.c).toBe(100);
    // Repeating gives the identical result — fully deterministic.
    const again = computeBasketAllocation(units, "total", 100, 0, 0);
    expect(again).toEqual(allocations);
  });

  it("REQUIREMENT: fees and postage are allocated (evenly, in total/average mode) and reflected in profit", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 500 }, { purchaseId: "b", costPence: 500 }];
    const allocations = computeBasketAllocation(units, "total", 4000, 100, 50);
    // revenue: 2000 each; fees: 50 each; postage: 25 each
    expect(allocations[0].feePence + allocations[1].feePence).toBe(100);
    expect(allocations[0].postagePence + allocations[1].postagePence).toBe(50);
    expect(allocations[0].profitPence).toBe(2000 - 500 - 50 - 25);
  });

  it("REQUIREMENT: negative profit (a genuine loss) is computed correctly, never clamped to zero", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 5000 }];
    const allocations = computeBasketAllocation(units, "total", 1000, 200, 100);
    expect(allocations[0].profitPence).toBe(1000 - 5000 - 200 - 100);
    expect(allocations[0].profitPence).toBeLessThan(0);
  });

  it("handles zero revenue safely (e.g. a giveaway) — profit is simply negative the cost/fees/postage, never NaN", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 1000 }, { purchaseId: "b", costPence: 2000 }];
    const allocations = computeBasketAllocation(units, "total", 0, 100, 0);
    expect(allocations.every(a => Number.isFinite(a.profitPence))).toBe(true);
    expect(allocations.reduce((sum, a) => sum + a.profitPence, 0)).toBe(0 - 3000 - 100);
  });

  it("an empty basket returns an empty allocation, never throws", () => {
    expect(computeBasketAllocation([], "total", 1000, 0, 0)).toEqual([]);
  });
});

describe("computeBasketAllocation — average revenue mode", () => {
  it("REQUIREMENT: caller normalises average x count into the total before calling, and per-unit profit still reflects each unit's own cost", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 1000 }, { purchaseId: "b", costPence: 3000 }];
    const totalRevenuePence = normalizeRevenueInputPence("average", 2000, units.length); // £20 average x 2 = £40
    expect(totalRevenuePence).toBe(4000);
    const allocations = computeBasketAllocation(units, "average", totalRevenuePence, 0, 0);
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a]));
    expect(byId.a.revenuePence).toBe(2000);
    expect(byId.b.revenuePence).toBe(2000);
    expect(byId.a.profitPence).toBe(1000); // 2000 - 1000
    expect(byId.b.profitPence).toBe(-1000); // 2000 - 3000 (a genuine loss on this specific costlier unit)
  });
});

describe("computeBasketAllocation — itemised revenue mode (mixed baskets)", () => {
  it("REQUIREMENT: revenue is exactly the per-unit value supplied, not an equal split", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 1000 }, { purchaseId: "b", costPence: 2000 }];
    const itemisedRevenuePence = { a: 1500, b: 3500 };
    const allocations = computeBasketAllocation(units, "itemised", 5000, 0, 0, itemisedRevenuePence);
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a]));
    expect(byId.a.revenuePence).toBe(1500);
    expect(byId.b.revenuePence).toBe(3500);
  });

  it("REQUIREMENT: fees/postage allocate proportionally to each unit's own revenue in itemised mode — a higher-revenue unit gets a bigger share", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 0 }, { purchaseId: "b", costPence: 0 }];
    const itemisedRevenuePence = { a: 1000, b: 3000 }; // 1:3 ratio
    const allocations = computeBasketAllocation(units, "itemised", 4000, 400, 200, itemisedRevenuePence);
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a]));
    expect(byId.a.feePence).toBe(100); // 1/4 of 400
    expect(byId.b.feePence).toBe(300); // 3/4 of 400
    expect(byId.a.postagePence).toBe(50);
    expect(byId.b.postagePence).toBe(150);
  });

  it("REQUIREMENT: falls back to cost-proportion for fees/postage when every unit's itemised revenue is zero", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 1000 }, { purchaseId: "b", costPence: 3000 }];
    const itemisedRevenuePence = { a: 0, b: 0 };
    const allocations = computeBasketAllocation(units, "itemised", 0, 400, 0, itemisedRevenuePence);
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a]));
    expect(byId.a.feePence).toBe(100); // 1/4 of 400, proportional to cost 1000:3000
    expect(byId.b.feePence).toBe(300);
  });

  it("REQUIREMENT: mixed purchase costs in an itemised basket still produce individually-correct profit per unit", () => {
    const units: BasketUnit[] = [
      { purchaseId: "a", costPence: 800 }, // Pokémon box, cheap supplier
      { purchaseId: "b", costPence: 1200 }, // Pokémon box, expensive supplier
      { purchaseId: "c", costPence: 4000 }, // Trainers
    ];
    const itemisedRevenuePence = { a: 1500, b: 1500, c: 6000 };
    const allocations = computeBasketAllocation(units, "itemised", 9000, 300, 150, itemisedRevenuePence);
    const byId = Object.fromEntries(allocations.map(a => [a.purchaseId, a]));
    // Same revenue (1500 each) but different cost -> different profit for the two Pokémon boxes.
    expect(byId.a.profitPence).not.toBe(byId.b.profitPence);
    expect(allocations.reduce((sum, a) => sum + a.profitPence, 0)).toBe(9000 - (800 + 1200 + 4000) - 300 - 150);
  });

  it("REQUIREMENT: itemised remainder pennies are deterministic — repeated calls agree exactly", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 0 }, { purchaseId: "b", costPence: 0 }, { purchaseId: "c", costPence: 0 }];
    const itemisedRevenuePence = { a: 100, b: 100, c: 100 };
    const first = computeBasketAllocation(units, "itemised", 300, 10, 0, itemisedRevenuePence);
    const second = computeBasketAllocation(units, "itemised", 300, 10, 0, itemisedRevenuePence);
    expect(first).toEqual(second);
    expect(first.reduce((sum, a) => sum + a.feePence, 0)).toBe(10);
  });

  it("a unit missing from itemisedRevenuePence defaults to zero revenue rather than throwing", () => {
    const units: BasketUnit[] = [{ purchaseId: "a", costPence: 100 }];
    const allocations = computeBasketAllocation(units, "itemised", 0, 0, 0, {});
    expect(allocations[0].revenuePence).toBe(0);
    expect(allocations[0].profitPence).toBe(-100);
  });
});
