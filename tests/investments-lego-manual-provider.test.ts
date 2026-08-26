import { describe, expect, it } from "vitest";
import { buildManualLegoQuote } from "@/lib/investments/providers/lego-manual";

describe("LEGO manual valuation", () => {
  it("builds a PriceQuote from a positive GBP price", () => {
    const quote = buildManualLegoQuote(219.99, "2026-08-01T12:00:00.000Z", "https://example.com/note");
    expect(quote).toEqual({
      nativeUnitPrice: 219.99, nativeCurrency: "GBP", priceAt: "2026-08-01T12:00:00.000Z", provider: "manual", sourceUrl: "https://example.com/note",
    });
  });

  it("defaults sourceUrl to null and priceAt to now when not supplied", () => {
    const before = Date.now();
    const quote = buildManualLegoQuote(50);
    expect(quote.sourceUrl).toBeNull();
    expect(new Date(quote.priceAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("rejects a zero or negative price rather than silently accepting it", () => {
    expect(() => buildManualLegoQuote(0)).toThrow();
    expect(() => buildManualLegoQuote(-5)).toThrow();
  });

  it("rejects a non-finite price", () => {
    expect(() => buildManualLegoQuote(NaN)).toThrow();
    expect(() => buildManualLegoQuote(Infinity)).toThrow();
  });
});
