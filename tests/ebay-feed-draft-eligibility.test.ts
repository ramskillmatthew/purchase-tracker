import { describe, expect, it } from "vitest";
import { evaluateEbayFeedDraftEligibility, type EbayFeedDraftEligibilityInput } from "@/lib/listing-studio/ebay-feed/feed-draft-eligibility";

function baseInput(overrides: Partial<EbayFeedDraftEligibilityInput> = {}): EbayFeedDraftEligibilityInput {
  return {
    hasEbayPreparation: true, accountUsable: true, alreadyHasFeedDraft: false, contentReady: true,
    hasValidPrice: true, hasPhoto: true, hasSku: true, hasQuantity: true, hasCategoryId: true,
    conditionValue: "Used – Very Good",
    ...overrides,
  };
}

describe("evaluateEbayFeedDraftEligibility", () => {
  it("a fully-ready listing is eligible with no reasons", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput())).toEqual({ eligible: true, reasons: [] });
  });

  it("REQUIREMENT: does NOT require a fulfillment/return/payment policy or a merchant location — the real template only requires Action and Category ID", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-draft-eligibility.ts", "utf8") as string;
    expect(source).not.toMatch(/fulfillmentPolicy|returnPolicy|paymentPolicy|merchantLocation/i);
  });

  it("no eBay preparation short-circuits with exactly one reason", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ hasEbayPreparation: false }))).toEqual({ eligible: false, reasons: ["No eBay preparation for this listing"] });
  });

  it("an already-drafted listing short-circuits, never re-offered for a duplicate draft", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ alreadyHasFeedDraft: true }))).toEqual({ eligible: false, reasons: ["A Seller Hub draft already exists for this listing"] });
  });

  it("disconnected account blocks with a clear reason", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ accountUsable: false })).reasons).toContain("eBay account is not connected");
  });

  it("missing category ID blocks — eBay's own #INFO row says this is required", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ hasCategoryId: false })).reasons).toContain("Missing eBay category");
  });

  it("missing price/photo/SKU/quantity each block with their own reason", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ hasValidPrice: false })).reasons).toContain("Missing eBay selling price");
    expect(evaluateEbayFeedDraftEligibility(baseInput({ hasPhoto: false })).reasons).toContain("No uploaded photos");
    expect(evaluateEbayFeedDraftEligibility(baseInput({ hasSku: false })).reasons).toContain("Missing SKU");
    expect(evaluateEbayFeedDraftEligibility(baseInput({ hasQuantity: false })).reasons).toContain("Missing quantity");
  });

  it("an ambiguous condition blocks, fail-closed, same as every other condition check in this codebase", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ conditionValue: "Used" })).eligible).toBe(false);
  });

  it("content not ready blocks", () => {
    expect(evaluateEbayFeedDraftEligibility(baseInput({ contentReady: false })).reasons).toContain("eBay content is not yet complete — finish it in Listing Studio");
  });

  it("multiple simultaneous problems are all reported, not just the first", () => {
    const result = evaluateEbayFeedDraftEligibility(baseInput({ hasValidPrice: false, hasPhoto: false, hasSku: false }));
    expect(result.reasons).toHaveLength(3);
  });
});
