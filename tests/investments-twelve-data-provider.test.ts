import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { twelveDataProvider } from "@/lib/investments/providers/twelve-data";

const ORIGINAL_ENV = process.env.TWELVE_DATA_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV === undefined) delete process.env.TWELVE_DATA_API_KEY; else process.env.TWELVE_DATA_API_KEY = ORIGINAL_ENV;
});

describe("Twelve Data stock provider — not configured", () => {
  beforeEach(() => { delete process.env.TWELVE_DATA_API_KEY; });

  it("isConfigured() is false with no API key", () => {
    expect(twelveDataProvider.isConfigured()).toBe(false);
  });

  it("getQuote() fails clearly (never fabricates a price) with no API key, and never calls the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await twelveDataProvider.getQuote("NVDA");
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toMatch(/not configured/i); expect(result.retryable).toBe(false); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("getHistory() fails clearly with no API key, and never calls the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await twelveDataProvider.getHistory("NVDA", null, "2026-01-01", "2026-02-01");
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Twelve Data stock provider — configured", () => {
  beforeEach(() => { process.env.TWELVE_DATA_API_KEY = "test-key"; });

  it("isConfigured() is true once a key is present", () => {
    expect(twelveDataProvider.isConfigured()).toBe(true);
  });

  it("parses a real-shaped quote response into a PriceQuote", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      symbol: "NVDA", name: "NVIDIA Corp", exchange: "NASDAQ", currency: "USD",
      datetime: "2026-08-12", open: "180.00", high: "185.00", low: "179.00", close: "182.40",
      previous_close: "180.00", change: "2.40", percent_change: "1.33", volume: "1000000", is_market_open: true,
    }), { status: 200 }));

    const result = await twelveDataProvider.getQuote("NVDA");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.nativeUnitPrice).toBe(182.40);
      expect(result.data.nativeCurrency).toBe("USD");
      expect(result.data.provider).toBe("twelve_data");
    }
  });

  it("includes the exchange param when supplied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      symbol: "VOO", currency: "USD", datetime: "2026-08-12", close: "494.21",
    }), { status: 200 }));
    await twelveDataProvider.getQuote("VOO", "NYSE");
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("exchange=NYSE"), expect.anything());
  });

  it("REGRESSION: a provider error response (status:'error') is surfaced as a failed result, never thrown, and never treated as a real price", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 400, message: "Invalid symbol", status: "error",
    }), { status: 200 })); // Twelve Data returns HTTP 200 with an error body for some failures
    const result = await twelveDataProvider.getQuote("NOTREAL");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Invalid symbol");
  });

  it("REGRESSION (real confirmed bug — VUAG): a genuine non-2xx HTTP status (404) with a parseable JSON error body surfaces the REAL error message, not a generic 'Twelve Data returned 404' — verified against Twelve Data's actual live response for a free-plan-gated LSE ETF", async () => {
    // Real response captured live: the free ("Basic") plan simply doesn't
    // include this instrument — this is never fixable by better symbol
    // resolution, and the UI must show the truthful, actionable reason
    // instead of a bare HTTP status.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 404, message: "This symbol is available starting with the Grow or Venture plan. Consider upgrading now at https://twelvedata.com/pricing", status: "error",
    }), { status: 404 }));
    const result = await twelveDataProvider.getQuote("VUAG", "LSE");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("This symbol is available starting with the Grow or Venture plan. Consider upgrading now at https://twelvedata.com/pricing");
      expect(result.error).not.toMatch(/^Twelve Data returned \d+ for/); // the old, unhelpful generic message
      expect(result.retryable).toBe(false); // a plan limitation is never resolved by retrying
    }
  });

  it("marks a 429 (rate limit) as retryable, and a bad symbol (400) as not retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ code: 429, message: "Too many requests", status: "error" }), { status: 200 }));
    const rateLimited = await twelveDataProvider.getQuote("NVDA");
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) expect(rateLimited.retryable).toBe(true);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ code: 400, message: "Invalid symbol", status: "error" }), { status: 200 }));
    const badSymbol = await twelveDataProvider.getQuote("NOTREAL");
    expect(badSymbol.ok).toBe(false);
    if (!badSymbol.ok) expect(badSymbol.retryable).toBe(false);
  });

  it("a network failure returns a retryable failed result, never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    const result = await twelveDataProvider.getQuote("NVDA");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("parses a real-shaped time_series response into sorted, ascending HistoricalPricePoints", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      meta: { symbol: "NVDA", currency: "USD" },
      values: [
        { datetime: "2026-01-03", close: "150.00" },
        { datetime: "2026-01-02", close: "148.50" },
      ],
      status: "ok",
    }), { status: 200 }));
    const result = await twelveDataProvider.getHistory("NVDA", null, "2026-01-01", "2026-01-05");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { date: "2026-01-02", nativeUnitPrice: 148.5 },
        { date: "2026-01-03", nativeUnitPrice: 150 },
      ]);
    }
  });

  it("filters out any non-positive/non-finite close values from history rather than passing them through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      meta: { symbol: "NVDA", currency: "USD" },
      values: [{ datetime: "2026-01-02", close: "0" }, { datetime: "2026-01-03", close: "150.00" }],
      status: "ok",
    }), { status: 200 }));
    const result = await twelveDataProvider.getHistory("NVDA", null, "2026-01-01", "2026-01-05");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([{ date: "2026-01-03", nativeUnitPrice: 150 }]);
  });
});
