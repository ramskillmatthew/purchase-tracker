import { describe, expect, it } from "vitest";
import { matchesOrderTotal, hasConsistentOrderTotal, sharedOrderTotal } from "@/lib/purchase-import/order-total";

describe("matchesOrderTotal", () => {
  it("REGRESSION: £100 + £100 + £100 matches a £300 order total", () => {
    expect(matchesOrderTotal([100, 100, 100], 300)).toBe(true);
  });

  it("REGRESSION: £99 + £100 + £100 (£299) is rejected against a £300 order total", () => {
    expect(matchesOrderTotal([99, 100, 100], 300)).toBe(false);
  });

  it("an order with a null total is never blocked by this rule (remains reviewable under the existing rules)", () => {
    expect(matchesOrderTotal([1, 2, 3], null)).toBe(true);
    expect(matchesOrderTotal([], null)).toBe(true);
  });

  it("REGRESSION: compares decimal/penny values exactly, with no floating-point drift", () => {
    // 33.33 + 33.33 + 33.34 = 100.00 exactly, in pence: 3333 + 3333 + 3334 = 10000.
    expect(matchesOrderTotal([33.33, 33.33, 33.34], 100)).toBe(true);
    // The classic 0.1 + 0.2 !== 0.3 float trap must not leak through.
    expect(matchesOrderTotal([0.1, 0.2], 0.3)).toBe(true);
    // One penny off must still fail.
    expect(matchesOrderTotal([33.33, 33.33, 33.33], 100)).toBe(false);
  });

  it("a single row must equal the order total exactly", () => {
    expect(matchesOrderTotal([49.99], 49.99)).toBe(true);
    expect(matchesOrderTotal([49.98], 49.99)).toBe(false);
  });
});

describe("hasConsistentOrderTotal / sharedOrderTotal", () => {
  it("REGRESSION: sibling totals of £300 and £301 are inconsistent — the whole group must be rejected rather than one value silently winning", () => {
    expect(hasConsistentOrderTotal([300, 301, 300])).toBe(false);
    expect(sharedOrderTotal([300, 301, 300])).toBeNull();
  });

  it("identical non-null totals across every sibling are consistent", () => {
    expect(hasConsistentOrderTotal([300, 300, 300])).toBe(true);
    expect(sharedOrderTotal([300, 300, 300])).toBe(300);
  });

  it("REGRESSION: retains the existing null-total behaviour when every sibling total is null", () => {
    expect(hasConsistentOrderTotal([null, null])).toBe(true);
    expect(sharedOrderTotal([null, null])).toBeNull();
  });

  it("a mix of one non-null value and nulls is still consistent (nulls don't count as a second distinct value)", () => {
    expect(hasConsistentOrderTotal([300, null, 300])).toBe(true);
    expect(sharedOrderTotal([300, null, 300])).toBe(300);
  });

  it("an empty sibling set is trivially consistent with no shared total", () => {
    expect(hasConsistentOrderTotal([])).toBe(true);
    expect(sharedOrderTotal([])).toBeNull();
  });
});
