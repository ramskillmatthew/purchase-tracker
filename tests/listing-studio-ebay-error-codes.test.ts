import { describe, expect, it } from "vitest";
import { describeEbayApiFailure, describeEbayAspectsFailure } from "@/lib/listing-studio/ebay-error-codes";

describe("describeEbayApiFailure — Phase 8: precise, actionable messages and safe codes", () => {
  it("REGRESSION (proven real bug): auth_failed maps to EBAY_AUTH_FAILED with the exact required message", () => {
    expect(describeEbayApiFailure("auth_failed")).toEqual({ code: "EBAY_AUTH_FAILED", message: "eBay rejected the local developer credentials." });
  });
  it("not_configured maps to EBAY_NOT_CONFIGURED with the exact required message", () => {
    expect(describeEbayApiFailure("not_configured")).toEqual({ code: "EBAY_NOT_CONFIGURED", message: "eBay category access is not configured on localhost." });
  });
  it("rate_limited maps to EBAY_RATE_LIMITED", () => {
    expect(describeEbayApiFailure("rate_limited").code).toBe("EBAY_RATE_LIMITED");
  });
  it("timeout and request_failed map to EBAY_TAXONOMY_UNAVAILABLE — a genuinely different case from auth_failed", () => {
    expect(describeEbayApiFailure("timeout").code).toBe("EBAY_TAXONOMY_UNAVAILABLE");
    expect(describeEbayApiFailure("request_failed").code).toBe("EBAY_TAXONOMY_UNAVAILABLE");
  });
  it("never returns the same code for auth_failed and a generic upstream failure — these are actionable differently (fix credentials vs. retry later)", () => {
    expect(describeEbayApiFailure("auth_failed").code).not.toBe(describeEbayApiFailure("request_failed").code);
  });

  // Live-diagnostic follow-up fix — these ten states (from the product
  // spec's own required list) must each stay distinguishable, never
  // collapsed back into one generic bucket.
  it("REQUIREMENT: every one of the product spec's distinguishable failure states maps to its own distinct code (credentials rejected, OAuth scope rejected, marketplace unsupported, category tree unavailable, rate limited, server failure, response parsing failure, local network failure — 'no category suggestions' is a success state, not a failure, see ebay-category-service.ts's own 'no_results')", () => {
    const codes = new Set([
      describeEbayApiFailure("auth_failed").code,
      describeEbayApiFailure("scope_rejected").code,
      describeEbayApiFailure("marketplace_unsupported").code,
      describeEbayApiFailure("category_tree_unavailable").code,
      describeEbayApiFailure("rate_limited").code,
      describeEbayApiFailure("server_error").code,
      describeEbayApiFailure("invalid_response").code,
      describeEbayApiFailure("network_failure").code,
    ]);
    expect(codes.size).toBe(8);
  });

  it("REQUIREMENT: app response parsing failure (invalid_response) has its own code, never folded into the generic 'temporarily unavailable' bucket", () => {
    const result = describeEbayApiFailure("invalid_response");
    expect(result.code).toBe("EBAY_RESPONSE_PARSE_FAILED");
    expect(result.code).not.toBe(describeEbayApiFailure("request_failed").code);
    expect(result.code).not.toBe(describeEbayApiFailure("timeout").code);
  });

  it("scope_rejected is distinct from auth_failed and names the specific cause (forbidden despite accepted credentials)", () => {
    const result = describeEbayApiFailure("scope_rejected");
    expect(result.code).toBe("EBAY_SCOPE_REJECTED");
    expect(result.code).not.toBe(describeEbayApiFailure("auth_failed").code);
    expect(result.message).toMatch(/forbidden|scope/i);
  });

  it("marketplace_unsupported is distinct from category_tree_unavailable — different real eBay errorIds (62003 vs 62004), different causes", () => {
    const marketplace = describeEbayApiFailure("marketplace_unsupported");
    const tree = describeEbayApiFailure("category_tree_unavailable");
    expect(marketplace.code).toBe("EBAY_MARKETPLACE_UNSUPPORTED");
    expect(tree.code).toBe("EBAY_CATEGORY_TREE_UNAVAILABLE");
    expect(marketplace.code).not.toBe(tree.code);
  });

  it("server_error (a real 5xx from eBay) is distinct from request_failed/invalid_response (this app's own classification of an unclear or unparseable response)", () => {
    expect(describeEbayApiFailure("server_error").code).toBe("EBAY_SERVER_ERROR");
    expect(describeEbayApiFailure("server_error").code).not.toBe(describeEbayApiFailure("request_failed").code);
  });

  it("network_failure (fetch never completed) is distinct from timeout (the request was sent) and from every status-code-driven failure", () => {
    const result = describeEbayApiFailure("network_failure");
    expect(result.code).toBe("EBAY_NETWORK_FAILURE");
    expect(result.code).not.toBe(describeEbayApiFailure("timeout").code);
    expect(result.message).toMatch(/network|reach/i);
  });
});

describe("describeEbayAspectsFailure — item-specifics-specific wording", () => {
  it("a generic upstream failure at the aspects step says so specifically, not a bare category-lookup message", () => {
    const result = describeEbayAspectsFailure("request_failed");
    expect(result.code).toBe("EBAY_ASPECTS_FAILED");
    expect(result.message).toMatch(/item specifics could not be loaded/i);
  });
  it("still reports auth_failed/not_configured precisely, not folded into the generic aspects message", () => {
    expect(describeEbayAspectsFailure("auth_failed").code).toBe("EBAY_AUTH_FAILED");
    expect(describeEbayAspectsFailure("not_configured").code).toBe("EBAY_NOT_CONFIGURED");
  });
});
