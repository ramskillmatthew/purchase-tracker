import { describe, expect, it } from "vitest";
import { parseEbayErrors, formatEbayErrorForUser } from "@/lib/ebay-account/ebay-error";

/**
 * Corrective pass (failed first eBay draft) — the error-parsing half of
 * the root-cause fix: the previous inventoryError() kept only eBay's
 * generic top-level `message` ("Invalid request"), discarding the actual
 * diagnostic detail (`longMessage`, `parameters`, `errorId`).
 */
describe("parseEbayErrors — REQUIREMENT 12: preserves safe eBay error ID/message/parameters", () => {
  it("extracts errorId, domain, category, message, longMessage and parameters from a real-shaped eBay error envelope", () => {
    const body = {
      errors: [{
        errorId: 25002, domain: "API_INVENTORY", category: "REQUEST",
        message: "Invalid request",
        longMessage: "The value of field condition is invalid: must be a supported ConditionEnum value.",
        parameters: [{ name: "condition", value: "Used – Very Good" }],
      }],
    };
    const [parsed] = parseEbayErrors(body);
    expect(parsed).toEqual({
      errorId: 25002, domain: "API_INVENTORY", category: "REQUEST",
      message: "Invalid request",
      longMessage: "The value of field condition is invalid: must be a supported ConditionEnum value.",
      parameters: [{ name: "condition", value: "Used – Very Good" }],
    });
  });

  it("returns an empty array for a non-JSON-shaped or empty errors array, never throws", () => {
    expect(parseEbayErrors(null)).toEqual([]);
    expect(parseEbayErrors(undefined)).toEqual([]);
    expect(parseEbayErrors("a plain string")).toEqual([]);
    expect(parseEbayErrors({})).toEqual([]);
    expect(parseEbayErrors({ errors: [] })).toEqual([]);
    expect(parseEbayErrors({ errors: "not an array" })).toEqual([]);
  });

  it("REQUIREMENT: bounds the number of errors and parameters parsed", () => {
    const manyErrors = Array.from({ length: 10 }, (_, i) => ({ errorId: i, message: `err ${i}` }));
    expect(parseEbayErrors({ errors: manyErrors }).length).toBeLessThanOrEqual(3);
    const manyParams = { errors: [{ errorId: 1, message: "x", parameters: Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, value: "v" })) }] };
    expect(parseEbayErrors(manyParams)[0].parameters.length).toBeLessThanOrEqual(6);
  });

  it("REQUIREMENT 13: never crashes on a malformed entry (missing fields, wrong types) — degrades to null/empty safely", () => {
    const body = { errors: [{}, { errorId: "not-a-number" }, { parameters: "not-an-array" }, null, "a string entry"] };
    expect(() => parseEbayErrors(body)).not.toThrow();
    const parsed = parseEbayErrors(body);
    expect(parsed[0]).toEqual({ errorId: null, domain: null, category: null, message: null, longMessage: null, parameters: [] });
  });

  it("REQUIREMENT 13/14: redacts a long opaque token-shaped substring wherever it appears, and bounds field length", () => {
    const longToken = "a".repeat(50);
    const body = { errors: [{ message: `Bearer ${longToken}`, longMessage: longToken, parameters: [{ name: "token", value: longToken }] }] };
    const [parsed] = parseEbayErrors(body);
    expect(parsed.message).toBe("[redacted]");
    expect(parsed.longMessage).toBe("[redacted]");
    expect(parsed.parameters[0].value).toBe("[redacted]");
  });

  it("bounds an ordinarily-safe but very long field to a fixed maximum length", () => {
    const body = { errors: [{ longMessage: "word ".repeat(200) }] }; // ~1000 chars, no secret-shaped run
    const [parsed] = parseEbayErrors(body);
    expect(parsed.longMessage!.length).toBeLessThanOrEqual(300);
  });
});

describe("formatEbayErrorForUser", () => {
  it("prefers the detailed longMessage over the generic top-level message — the exact improvement over the old 'Invalid request' behaviour", () => {
    const [parsed] = parseEbayErrors({ errors: [{ message: "Invalid request", longMessage: "condition must be a supported ConditionEnum value" }] });
    expect(formatEbayErrorForUser([parsed], "fallback")).toContain("condition must be a supported ConditionEnum value");
  });

  it("falls back to the short message when no longMessage is present", () => {
    const [parsed] = parseEbayErrors({ errors: [{ message: "Invalid request" }] });
    expect(formatEbayErrorForUser([parsed], "fallback")).toBe("Invalid request");
  });

  it("falls back to the caller's own fallback text when nothing structured could be parsed at all", () => {
    expect(formatEbayErrorForUser([], "This eBay inventory item could not be created.")).toBe("This eBay inventory item could not be created.");
  });

  it("appends the offending field name when eBay identified one", () => {
    const [parsed] = parseEbayErrors({ errors: [{ longMessage: "Invalid condition value.", parameters: [{ name: "condition", value: "Used – Very Good" }] }] });
    expect(formatEbayErrorForUser([parsed], "fallback")).toBe("Invalid condition value. (field: condition)");
  });

  it("REQUIREMENT 14: the final formatted message is bounded, never an enormous raw JSON dump", () => {
    const [parsed] = parseEbayErrors({ errors: [{ longMessage: "x".repeat(500) }] });
    expect(formatEbayErrorForUser([parsed], "fallback").length).toBeLessThanOrEqual(320);
  });
});
