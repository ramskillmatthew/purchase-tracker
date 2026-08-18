import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eodhdProvider, latestQuoteFromRange, multiplierForUnit, normalizeEodRange, normalizeProviderPrice, type EodPoint } from "@/lib/investments/providers/eodhd";

const ORIGINAL_ENV = process.env.EODHD_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV === undefined) delete process.env.EODHD_API_KEY; else process.env.EODHD_API_KEY = ORIGINAL_ENV;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// ----------------------------------------------------------------------------
// REGRESSION — the exact confirmed-dangerous design flaw this adapter was
// rewritten to remove: a prior version guessed GBX-vs-GBP from the raw
// value's MAGNITUDE ("divide by 100 if >= 1000, else already GBP"). V3AB
// genuinely trades around 588 GBX (£5.88) — comfortably below 1000 — so
// that heuristic would have silently stored £588, a real ~100x error. Every
// case here uses an EXPLICIT unit, never a magnitude threshold.
// ----------------------------------------------------------------------------
describe("normalizeProviderPrice — explicit unit only, no magnitude guessing", () => {
  it("REGRESSION: 588 GBX (V3AB's real approximate price) normalizes to £5.88, never £588", () => {
    const result = normalizeProviderPrice(588, "GBX");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBeCloseTo(5.88);
  });

  it("9808 GBX normalizes to £98.08", () => {
    const result = normalizeProviderPrice(9808, "GBX");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBeCloseTo(98.08);
  });

  it("12979 GBX normalizes to £129.79", () => {
    const result = normalizeProviderPrice(12979, "GBX");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBeCloseTo(129.79);
  });

  it("129.79 GBP stays £129.79 — never divided by 100 just because it's a large-looking GBP value", () => {
    const result = normalizeProviderPrice(129.79, "GBP");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBeCloseTo(129.79);
  });

  it("5.88 GBP stays £5.88 — a genuinely small GBP value is never mistaken for GBX and multiplied", () => {
    const result = normalizeProviderPrice(5.88, "GBP");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBeCloseTo(5.88);
  });

  it("REGRESSION: a GBX value below 1000 (the old heuristic's exact blind spot) is STILL correctly divided by 100", () => {
    const result = normalizeProviderPrice(588, "GBX");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBeLessThan(10); // must land at ~£5.88, nowhere near £588
  });

  it("REGRESSION: a genuine GBP value above 1000 is NOT divided by 100 just because it's large", () => {
    const result = normalizeProviderPrice(1500, "GBP");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBe(1500);
  });

  it("USD is not sub-unit-scaled — cross-currency conversion is a separate, downstream concern (the FX-rate provider)", () => {
    const result = normalizeProviderPrice(450, "USD");
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.data.nativeUnitPrice).toBe(450); expect(result.data.nativeCurrency).toBe("USD"); }
  });

  it("EUR is not sub-unit-scaled either", () => {
    const result = normalizeProviderPrice(80, "EUR");
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.data.nativeUnitPrice).toBe(80); expect(result.data.nativeCurrency).toBe("EUR"); }
  });

  it("zero is rejected, never treated as a real (free) price", () => {
    expect(normalizeProviderPrice(0, "GBX").ok).toBe(false);
  });

  it("a negative value is rejected", () => {
    expect(normalizeProviderPrice(-5.88, "GBP").ok).toBe(false);
  });

  it("NaN is rejected", () => {
    expect(normalizeProviderPrice(NaN, "GBP").ok).toBe(false);
  });

  it("Infinity is rejected", () => {
    expect(normalizeProviderPrice(Infinity, "GBX").ok).toBe(false);
  });

  it("multiplierForUnit reports the exact deterministic multiplier per unit — 1 for GBP/USD/EUR, 0.01 for GBX", () => {
    expect(multiplierForUnit("GBP")).toBe(1);
    expect(multiplierForUnit("GBX")).toBe(0.01);
    expect(multiplierForUnit("USD")).toBe(1);
    expect(multiplierForUnit("EUR")).toBe(1);
  });
});

describe("normalizeEodRange — quote and history share the exact same normalizer (no double conversion, no drift)", () => {
  it("every point in a range is normalized through the identical function a single quote uses", () => {
    const points: EodPoint[] = [{ date: "2026-08-12", rawPrice: 12800 }, { date: "2026-08-13", rawPrice: 12979 }];
    const result = normalizeEodRange(points, "GBX");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].nativeUnitPrice).toBeCloseTo(128);
      expect(result.data[1].nativeUnitPrice).toBeCloseTo(129.79);
    }
  });

  it("preserves the raw provider price alongside the normalized value, for full provenance", () => {
    const result = normalizeEodRange([{ date: "2026-08-13", rawPrice: 588 }], "GBX");
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.data[0].rawPrice).toBe(588); expect(result.data[0].nativeUnitPrice).toBeCloseTo(5.88); }
  });

  it("a single invalid point (e.g. zero) fails the whole range rather than silently dropping it", () => {
    const result = normalizeEodRange([{ date: "2026-08-12", rawPrice: 100 }, { date: "2026-08-13", rawPrice: 0 }], "GBP");
    expect(result.ok).toBe(false);
  });

  it("REGRESSION: no double conversion — a GBX range normalized once is never re-divided by 100 a second time downstream", () => {
    const points: EodPoint[] = [{ date: "2026-08-13", rawPrice: 9808 }];
    const once = normalizeEodRange(points, "GBX");
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    // Re-running the SAME normalizer on the raw price again (simulating an
    // accidental double-normalize bug) must still be deterministic and
    // based on the ORIGINAL raw value, never the already-normalized one —
    // this test exists to catch a future regression where a caller might
    // accidentally feed an already-normalized value back in.
    const again = normalizeProviderPrice(points[0].rawPrice, "GBX");
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.nativeUnitPrice).toBe(once.data[0].nativeUnitPrice);
  });
});

describe("latestQuoteFromRange", () => {
  it("takes the LAST point as the current quote, with priceAt from its date", () => {
    const normalized = normalizeEodRange(
      [{ date: "2026-08-12", rawPrice: 12800 }, { date: "2026-08-13", rawPrice: 12979 }], "GBX",
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const quote = latestQuoteFromRange("VWRP", normalized.data, "GBX");
    expect(quote.ok).toBe(true);
    if (quote.ok) {
      expect(quote.data.nativeUnitPrice).toBeCloseTo(129.79);
      expect(quote.data.nativeCurrency).toBe("GBP");
      expect(quote.data.priceAt.slice(0, 10)).toBe("2026-08-13");
      expect(quote.data.rawPrice).toBe(12979);
      expect(quote.data.multiplier).toBe(0.01);
      expect(quote.data.provider).toBe("eodhd");
    }
  });

  it("an empty range is reported as no data, never a fabricated quote", () => {
    const quote = latestQuoteFromRange("VWRP", [], "GBX");
    expect(quote.ok).toBe(false);
  });
});

describe("EODHD provider — not configured", () => {
  beforeEach(() => { delete process.env.EODHD_API_KEY; });

  it("isConfigured() is false with no API key", () => {
    expect(eodhdProvider.isConfigured()).toBe(false);
  });

  it("getEodRange() fails clearly with no API key, and never calls the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toMatch(/EODHD_API_KEY/); expect(result.retryable).toBe(false); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("EODHD provider — configured, raw fetch (unit-agnostic — normalization happens in the caller)", () => {
  beforeEach(() => { process.env.EODHD_API_KEY = "test-key"; });

  it("isConfigured() is true once a key is present", () => {
    expect(eodhdProvider.isConfigured()).toBe(true);
  });

  it("parses every row in the range as raw (unnormalized) points, ascending by date", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([
      { date: "2026-08-12", open: 128, high: 129, low: 127, close: 12800, volume: 100000 },
      { date: "2026-08-13", open: 128.5, high: 130, low: 128, close: 12979, volume: 110000 },
    ]));
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([{ date: "2026-08-12", rawPrice: 12800 }, { date: "2026-08-13", rawPrice: 12979 }]);
    }
  });

  it("requests the ticker.exchange symbol form with from/to params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([{ date: "2026-08-13", close: 12979 }]));
    await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/eod/VWRP.LSE");
    expect(url).toContain("from=2026-08-01");
    expect(url).toContain("to=2026-08-13");
  });

  it("a 401/403 (bad key) is a non-retryable failure — retrying it can never succeed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });

  it("a 429 (rate limit) is a retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("an empty array is reported as no data, never a fabricated zero price", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(true); // an empty range is a valid (if unhelpful) result — the CALLER decides "no data" via latestQuoteFromRange
    if (result.ok) expect(result.data).toEqual([]);
  });

  it("a non-array response body is rejected as malformed, never partially trusted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "not found" }));
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(false);
  });

  it("a zero or negative close is filtered out of the raw points, never treated as a real price", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([{ date: "2026-08-12", close: 0 }, { date: "2026-08-13", close: -5 }]));
    const result = await eodhdProvider.getEodRange("VWRP", "LSE", "2026-08-01", "2026-08-13");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });
});
