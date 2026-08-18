import { describe, expect, it } from "vitest";
import { allocateFeesOrPostagePence, allocateProportionalPence } from "@/lib/sales/allocation";

describe("allocateProportionalPence — largest-remainder proportional allocation", () => {
  it("REQUIREMENT: splits exactly proportionally when it divides evenly", () => {
    expect(allocateProportionalPence(300, [1, 1, 1])).toEqual([100, 100, 100]);
    expect(allocateProportionalPence(300, [2, 1])).toEqual([200, 100]);
  });

  it("REQUIREMENT: the sum of allocations always equals the exact total, never losing or inventing a penny", () => {
    const cases: [number, number[]][] = [
      [100, [3, 7]], [1, [1, 1, 1, 1, 1, 1, 1]], [9999, [13, 27, 41]], [10000, [1, 2, 3]],
      [1, [1000, 1]], [50, [1, 1, 1]],
    ];
    for (const [total, weights] of cases) {
      const shares = allocateProportionalPence(total, weights);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(total);
    }
  });

  it("REQUIREMENT: larger weights receive proportionally larger shares", () => {
    const shares = allocateProportionalPence(1000, [1, 3]);
    expect(shares[1]).toBeGreaterThan(shares[0]);
    expect(shares).toEqual([250, 750]);
  });

  it("REQUIREMENT: the remainder goes to the largest fractional-remainder positions first", () => {
    // total=100, weights=[1,1,1] -> exact 33.33 each; base=[33,33,33], remainder=1
    // -> all fracs equal (.333...), tie broken by ascending index -> first position gets it.
    expect(allocateProportionalPence(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("REQUIREMENT: ties in fractional remainder are broken deterministically by ascending index, not weight magnitude or insertion order", () => {
    const a = allocateProportionalPence(10, [1, 1, 1]);
    const b = allocateProportionalPence(10, [1, 1, 1]);
    expect(a).toEqual(b);
    expect(a).toEqual([4, 3, 3]);
  });

  it("is deterministic across repeated calls with identical inputs", () => {
    expect(allocateProportionalPence(733, [17, 42, 5, 91])).toEqual(allocateProportionalPence(733, [17, 42, 5, 91]));
  });

  it("REQUIREMENT: falls back to an equal split when every weight is zero — never divides by zero", () => {
    expect(allocateProportionalPence(300, [0, 0, 0])).toEqual([100, 100, 100]);
    expect(allocateProportionalPence(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it("handles zero total safely regardless of weights", () => {
    expect(allocateProportionalPence(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it("a single position receives the entire total", () => {
    expect(allocateProportionalPence(999, [42])).toEqual([999]);
  });

  it("an empty weights array returns an empty result", () => {
    expect(allocateProportionalPence(500, [])).toEqual([]);
  });

  it("one weight much larger than the others still reconciles exactly", () => {
    const shares = allocateProportionalPence(101, [1, 1, 1000]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(101);
    expect(shares[2]).toBeGreaterThan(shares[0]);
    expect(shares[2]).toBeGreaterThan(shares[1]);
  });
});

describe("allocateFeesOrPostagePence — Stage 4 fee/postage allocation rule", () => {
  it("REQUIREMENT: proportional to each line's own revenue when at least one line has nonzero revenue", () => {
    expect(allocateFeesOrPostagePence(300, [2000, 1000], [500, 500])).toEqual([200, 100]);
  });

  it("REQUIREMENT: falls back to proportional-by-purchase-cost when every line's revenue is zero (a free/giveaway order)", () => {
    expect(allocateFeesOrPostagePence(300, [0, 0], [2000, 1000])).toEqual([200, 100]);
  });

  it("REQUIREMENT: falls back to an equal split when both revenue and cost are all zero", () => {
    expect(allocateFeesOrPostagePence(300, [0, 0, 0], [0, 0, 0])).toEqual([100, 100, 100]);
  });

  it("always reconciles exactly to the total pence, regardless of which fallback tier is used", () => {
    expect(allocateFeesOrPostagePence(101, [50, 30, 0], [10, 10, 10]).reduce((a, b) => a + b, 0)).toBe(101);
    expect(allocateFeesOrPostagePence(101, [0, 0, 0], [7, 3, 0]).reduce((a, b) => a + b, 0)).toBe(101);
    expect(allocateFeesOrPostagePence(101, [0, 0, 0], [0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(101);
  });

  it("REGRESSION: equal-revenue lines (Quick Sale's own shape) produce the same result as an equal split, matching the RPC's unchanged total/average behaviour", () => {
    expect(allocateFeesOrPostagePence(100, [500, 500, 500], [1, 2, 3])).toEqual([34, 33, 33]);
  });
});
