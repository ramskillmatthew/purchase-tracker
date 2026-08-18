import { describe, expect, it } from "vitest";
import { formatMarginPercent, formatPenceAsGBP, penceToPounds, poundsToPence } from "@/lib/sales/money";
import { normalizeRevenueInputPence, splitEvenlyPence } from "@/lib/sales/allocation";
import { calculateLineProfitPence, calculateMarginPercent, calculateTotalProfitPence } from "@/lib/sales/profit";

describe("poundsToPence / penceToPounds", () => {
  it("converts a whole-pound amount exactly", () => {
    expect(poundsToPence(12)).toBe(1200);
    expect(penceToPounds(1200)).toBe(12);
  });

  it("converts a penny-precise amount exactly", () => {
    expect(poundsToPence(12.34)).toBe(1234);
    expect(penceToPounds(1234)).toBe(12.34);
  });

  it("REQUIREMENT: never accumulates floating-point drift — a classic lossy case (e.g. 0.1 + 0.2) round-trips exactly in pence", () => {
    expect(poundsToPence(19.99)).toBe(1999);
    expect(penceToPounds(1999)).toBe(19.99);
    expect(poundsToPence(0.1 + 0.2)).toBe(30); // 0.30000000000000004 in raw JS float
  });

  it("rounds a sub-penny pounds value to the nearest penny", () => {
    expect(poundsToPence(12.345)).toBe(1235); // rounds half up via Math.round
    expect(poundsToPence(12.344)).toBe(1234);
  });

  it("zero round-trips exactly", () => {
    expect(poundsToPence(0)).toBe(0);
    expect(penceToPounds(0)).toBe(0);
  });
});

describe("formatPenceAsGBP", () => {
  it("formats pence as a £-prefixed 2dp string", () => {
    expect(formatPenceAsGBP(1999)).toBe("£19.99");
    expect(formatPenceAsGBP(0)).toBe("£0.00");
  });

  it("formats null/undefined/non-finite as an em dash, never a fabricated £0.00", () => {
    expect(formatPenceAsGBP(null)).toBe("—");
    expect(formatPenceAsGBP(undefined)).toBe("—");
    expect(formatPenceAsGBP(NaN)).toBe("—");
  });

  it("formats a negative (loss) value with a leading minus", () => {
    expect(formatPenceAsGBP(-500)).toBe("£-5.00");
  });
});

describe("formatMarginPercent", () => {
  it("formats a percentage to 2dp with a % suffix", () => {
    expect(formatMarginPercent(26.72)).toBe("26.72%");
    expect(formatMarginPercent(-25)).toBe("-25.00%");
  });

  it("REQUIREMENT: formats null (zero-revenue, not applicable) as an em dash, never 0% or NaN%", () => {
    expect(formatMarginPercent(null)).toBe("—");
  });
});

describe("normalizeRevenueInputPence", () => {
  it("REQUIREMENT: total mode passes the value through unchanged", () => {
    expect(normalizeRevenueInputPence("total", 5000, 3)).toBe(5000);
  });

  it("REQUIREMENT: average mode multiplies the per-item value by the item count", () => {
    expect(normalizeRevenueInputPence("average", 1000, 3)).toBe(3000);
  });

  it("average mode with a single item equals that one item's value", () => {
    expect(normalizeRevenueInputPence("average", 1500, 1)).toBe(1500);
  });

  it("handles zero revenue safely in both modes", () => {
    expect(normalizeRevenueInputPence("total", 0, 5)).toBe(0);
    expect(normalizeRevenueInputPence("average", 0, 5)).toBe(0);
  });
});

describe("splitEvenlyPence — exact penny allocation with deterministic remainder", () => {
  it("REQUIREMENT: an evenly-divisible total splits with no remainder", () => {
    expect(splitEvenlyPence(300, 3)).toEqual([100, 100, 100]);
  });

  it("REQUIREMENT: the sum of allocations always equals the exact total, never losing or inventing a penny", () => {
    for (const [total, count] of [[100, 3], [1, 7], [9999, 13], [10000, 3]] as const) {
      const shares = splitEvenlyPence(total, count);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(total);
    }
  });

  it("REQUIREMENT: a one-penny remainder goes to the first position deterministically", () => {
    expect(splitEvenlyPence(100, 3)).toEqual([34, 33, 33]);
  });

  it("REQUIREMENT: a multi-penny remainder goes to the first N positions in order, never scattered or reversed", () => {
    expect(splitEvenlyPence(101, 3)).toEqual([34, 34, 33]);
    expect(splitEvenlyPence(10, 3)).toEqual([4, 3, 3]);
  });

  it("is deterministic — calling twice with the same inputs gives the identical result", () => {
    expect(splitEvenlyPence(101, 3)).toEqual(splitEvenlyPence(101, 3));
  });

  it("REQUIREMENT: handles zero revenue safely — every share is zero, no division-by-zero artifact", () => {
    expect(splitEvenlyPence(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("a single item receives the entire total", () => {
    expect(splitEvenlyPence(999, 1)).toEqual([999]);
  });

  it("zero items returns an empty array rather than throwing (defensive — callers validate item count separately)", () => {
    expect(splitEvenlyPence(500, 0)).toEqual([]);
  });
});

describe("calculateLineProfitPence / calculateTotalProfitPence", () => {
  it("REQUIREMENT: profit = allocated revenue - cost - allocated fee - allocated postage", () => {
    expect(calculateLineProfitPence(2000, 800, 100, 50)).toBe(1050);
  });

  it("REQUIREMENT: can be negative — a genuine loss when cost+fees+postage exceed revenue", () => {
    expect(calculateLineProfitPence(500, 800, 50, 20)).toBe(-370);
  });

  it("zero revenue and zero cost/fees/postage yields zero profit", () => {
    expect(calculateLineProfitPence(0, 0, 0, 0)).toBe(0);
  });

  it("totals the given line profits, negative and positive alike", () => {
    expect(calculateTotalProfitPence([1000, -200, 300])).toBe(1100);
  });

  it("an empty line list totals to zero", () => {
    expect(calculateTotalProfitPence([])).toBe(0);
  });
});

describe("calculateMarginPercent", () => {
  it("REQUIREMENT: profit / revenue * 100, rounded to 2dp", () => {
    expect(calculateMarginPercent(2500, 10000)).toBe(25);
    expect(calculateMarginPercent(3333, 10000)).toBe(33.33);
  });

  it("REQUIREMENT: a loss yields a negative margin", () => {
    expect(calculateMarginPercent(-500, 2000)).toBe(-25);
  });

  it("100% margin when cost/fees/postage are all zero", () => {
    expect(calculateMarginPercent(1000, 1000)).toBe(100);
  });

  it("REQUIREMENT: zero revenue returns null — never NaN or Infinity", () => {
    const result = calculateMarginPercent(0, 0);
    expect(result).toBeNull();
    expect(Number.isNaN(result)).toBe(false);
  });

  it("REQUIREMENT: zero revenue with a nonzero (loss) profit also safely returns null, not -Infinity", () => {
    const result = calculateMarginPercent(-500, 0);
    expect(result).toBeNull();
    expect(result).not.toBe(-Infinity);
  });
});
