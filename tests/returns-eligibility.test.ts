import { describe, expect, it } from "vitest";
import {
  eligibleReturnQuantity, validateReturnQuantity, unitsAlreadyReturning, validateLossQuantity,
  selectSaleItemIdsForReturn,
} from "@/lib/returns/eligibility";

function ret(workflow_status: string, quantity: number, id = "r") {
  return { workflow_status: workflow_status as never, quantity, id };
}

describe("return quantity eligibility", () => {
  it("6. a requested quantity cannot exceed the eligible remaining quantity", () => {
    const v = validateReturnQuantity({ requested: 3, soldUnitCount: 2, existingReturns: [] });
    expect(v.ok).toBe(false);
  });

  it("6. positive-integer only", () => {
    expect(validateReturnQuantity({ requested: 0, soldUnitCount: 5, existingReturns: [] }).ok).toBe(false);
    expect(validateReturnQuantity({ requested: 1.5, soldUnitCount: 5, existingReturns: [] }).ok).toBe(false);
    expect(validateReturnQuantity({ requested: -1, soldUnitCount: 5, existingReturns: [] }).ok).toBe(false);
    expect(validateReturnQuantity({ requested: 2, soldUnitCount: 5, existingReturns: [] })).toEqual({ ok: true, quantity: 2 });
  });

  it("7. a unit already tied to an active or completed return cannot be returned again", () => {
    const existing = [ret("return_started", 1, "a"), ret("return_completed", 1, "b")];
    expect(unitsAlreadyReturning(existing)).toBe(2);
    expect(eligibleReturnQuantity(3, existing)).toBe(1);
    expect(validateReturnQuantity({ requested: 2, soldUnitCount: 3, existingReturns: existing }).ok).toBe(false);
    expect(validateReturnQuantity({ requested: 1, soldUnitCount: 3, existingReturns: existing }).ok).toBe(true);
  });

  it("7. a CANCELLED return frees its units again", () => {
    const existing = [ret("return_cancelled", 1, "a")];
    expect(eligibleReturnQuantity(1, existing)).toBe(1);
    expect(validateReturnQuantity({ requested: 1, soldUnitCount: 1, existingReturns: existing }).ok).toBe(true);
  });

  it("editing a return excludes ITSELF from the already-returning total", () => {
    const existing = [ret("return_started", 1, "self"), ret("return_started", 1, "other")];
    // without exclusion: 2 of 3 used -> only 1 free; editing 'self' up to 2 must consider only 'other' (1 used) -> 2 free
    expect(validateReturnQuantity({ requested: 2, soldUnitCount: 3, existingReturns: existing, currentReturnId: "self" }).ok).toBe(true);
  });
});

describe("selectSaleItemIdsForReturn — precise unit-level selection", () => {
  it("7. picks the requested count from the units not already claimed by another return", () => {
    const r = selectSaleItemIdsForReturn({ allActiveSaleItemIds: ["a", "b", "c"], alreadyClaimedIds: ["a"], quantity: 2 });
    expect(r).toEqual({ ok: true, saleItemIds: ["b", "c"] });
  });

  it("7. a unit already claimed by another return can never be selected again", () => {
    const r = selectSaleItemIdsForReturn({ allActiveSaleItemIds: ["a", "b"], alreadyClaimedIds: ["a", "b"], quantity: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects a request exceeding what remains, with an exact count in the message", () => {
    const r = selectSaleItemIdsForReturn({ allActiveSaleItemIds: ["a", "b", "c"], alreadyClaimedIds: ["a"], quantity: 3 });
    expect(r).toEqual({ ok: false, error: "Only 2 units from this sale can still be returned." });
  });
});

describe("loss quantity eligibility", () => {
  it("8/loss. cannot exceed remaining eligible in-stock units, positive integer only", () => {
    expect(validateLossQuantity({ requested: 2, remainingEligible: 1 }).ok).toBe(false);
    expect(validateLossQuantity({ requested: 0, remainingEligible: 5 }).ok).toBe(false);
    expect(validateLossQuantity({ requested: 1, remainingEligible: 1 })).toEqual({ ok: true, quantity: 1 });
    expect(validateLossQuantity({ requested: 1, remainingEligible: 0 }).ok).toBe(false);
  });
});
