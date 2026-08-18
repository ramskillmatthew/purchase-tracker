import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

import { getFxRate, getFxRatesForDates, getFxRatesForRange, nearestRate } from "@/lib/investments/providers/fx-provider";

beforeEach(() => {
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
  supabaseRequestAll.mockResolvedValue([]);
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("FX provider — Frankfurter", () => {
  it("GBP native currency short-circuits to rate 1 with no network call and no cache write", async () => {
    const result = await getFxRate("GBP", "2026-01-15");
    expect(result.rate).toBe(1);
    expect(supabaseRequestAll).not.toHaveBeenCalled();
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("returns a cached rate without calling the network", async () => {
    supabaseRequestAll.mockResolvedValue([{ rate: "0.79123" }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getFxRate("USD", "2026-01-15");
    expect(result.rate).toBeCloseTo(0.79123);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("fetches from Frankfurter on a cache miss, using the historical-date endpoint for a past date", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ amount: 1, base: "USD", date: "2026-01-15", rates: { GBP: 0.7864 } }), { status: 200 }),
    );
    const result = await getFxRate("USD", "2026-01-15");
    expect(result.rate).toBeCloseTo(0.7864);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/v1/2026-01-15?base=USD&symbols=GBP"), expect.anything());
    fetchSpy.mockRestore();
  });

  it("uses the 'latest' endpoint for today's date", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: { GBP: 0.75 } }), { status: 200 }),
    );
    const today = new Date().toISOString().slice(0, 10);
    await getFxRate("USD", today);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/v1/latest?base=USD&symbols=GBP"), expect.anything());
    fetchSpy.mockRestore();
  });

  it("REGRESSION: caches the fresh rate keyed by the REQUESTED date, so a second identical lookup never hits the network again", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: { GBP: 0.7864 } }), { status: 200 }),
    );
    await getFxRate("USD", "2026-01-13"); // a Saturday — Frankfurter itself would return Friday's rate
    const insertCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_fx_rates");
    expect(insertCall).toBeDefined();
    const body = JSON.parse((insertCall![1] as RequestInit).body as string);
    // Cached against the date we ASKED for, not whatever trading-day date
    // the provider's own response might separately report.
    expect(body.rate_at).toBe("2026-01-13");
    expect(body.base_currency).toBe("USD");
    expect(body.quote_currency).toBe("GBP");
    fetchSpy.mockRestore();
  });

  it("throws a clear error when the provider returns a non-OK status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 500 }));
    await expect(getFxRate("USD", "2026-01-15")).rejects.toThrow(/500/);
    fetchSpy.mockRestore();
  });

  it("throws a clear error on a network failure, rather than silently returning a fabricated rate", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(getFxRate("USD", "2026-01-15")).rejects.toThrow(/Frankfurter/);
    fetchSpy.mockRestore();
  });

  it("throws when the response has no usable GBP rate rather than defaulting to 0 or 1", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ rates: {} }), { status: 200 }));
    await expect(getFxRate("USD", "2026-01-15")).rejects.toThrow(/no usable GBP rate/);
    fetchSpy.mockRestore();
  });

  it("getFxRatesForDates fetches each DISTINCT date only once even if the same date repeats in the input", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ rates: { GBP: 0.8 } }), { status: 200 }));
    await getFxRatesForDates("USD", ["2026-01-01", "2026-01-01", "2026-01-02"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it("getFxRatesForRange makes exactly ONE request for a whole date range, not one per date", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      rates: { "2026-01-01": { GBP: 0.8 }, "2026-01-02": { GBP: 0.81 }, "2026-01-05": { GBP: 0.79 } },
    }), { status: 200 }));
    const result = await getFxRatesForRange("USD", "2026-01-01", "2026-01-05");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/v1/2026-01-01..2026-01-05?base=USD&symbols=GBP"), expect.anything());
    expect(result.get("2026-01-02")).toBeCloseTo(0.81);
    fetchSpy.mockRestore();
  });

  it("getFxRatesForRange returns an empty map for GBP (no FX effect, no network call)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getFxRatesForRange("GBP", "2026-01-01", "2026-01-05");
    expect(result.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("getFxRatesForRange bulk-caches every returned date in one insert", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      rates: { "2026-01-01": { GBP: 0.8 }, "2026-01-02": { GBP: 0.81 } },
    }), { status: 200 }));
    await getFxRatesForRange("USD", "2026-01-01", "2026-01-02");
    const insertCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_fx_rates");
    const body = JSON.parse((insertCall![1] as RequestInit).body as string);
    expect(body).toHaveLength(2);
  });
});

describe("nearestRate", () => {
  it("returns the exact rate when the date is present", () => {
    const map = new Map([["2026-01-01", 0.8], ["2026-01-02", 0.81]]);
    expect(nearestRate(map, "2026-01-02")).toBe(0.81);
  });

  it("falls back to the nearest EARLIER date when the exact date is missing", () => {
    const map = new Map([["2026-01-01", 0.8], ["2026-01-04", 0.83]]);
    expect(nearestRate(map, "2026-01-03")).toBe(0.8);
  });

  it("falls back to the earliest available date when the target is before every entry", () => {
    const map = new Map([["2026-01-05", 0.79]]);
    expect(nearestRate(map, "2026-01-01")).toBe(0.79);
  });

  it("returns null (never a silent default) for a genuinely empty map", () => {
    expect(nearestRate(new Map(), "2026-01-01")).toBeNull();
  });
});
