import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

const { twelveDataProvider } = vi.hoisted(() => ({
  twelveDataProvider: { name: "twelve_data", isConfigured: vi.fn(() => true), getQuote: vi.fn(), getHistory: vi.fn() },
}));
vi.mock("@/lib/investments/providers/twelve-data", () => ({ twelveDataProvider }));

const { pokePulseProvider } = vi.hoisted(() => ({
  pokePulseProvider: { name: "pokepulse", isConfigured: vi.fn(() => true), getQuote: vi.fn(), getHistory: vi.fn() },
}));
vi.mock("@/lib/investments/providers/pokepulse", () => ({ pokePulseProvider }));

const { getFxRate } = vi.hoisted(() => ({ getFxRate: vi.fn(async () => ({ rate: 0.8, requestedDate: "2026-08-12", provider: "frankfurter" as const })) }));
vi.mock("@/lib/investments/providers/fx-provider", () => ({ getFxRate }));

// getEodRange (the real network call) is mocked; normalizeEodRange/
// latestQuoteFromRange are the REAL, already-unit-tested pure functions —
// this exercises the real integration between refresh.ts and the real
// normalizer, not a re-implemented test double of it.
const { getEodRangeMock, isEodhdConfiguredMock } = vi.hoisted(() => ({ getEodRangeMock: vi.fn(), isEodhdConfiguredMock: vi.fn(() => true) }));
vi.mock("@/lib/investments/providers/eodhd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investments/providers/eodhd")>();
  return { ...actual, eodhdProvider: { name: "eodhd", isConfigured: isEodhdConfiguredMock, getEodRange: getEodRangeMock, normalizeEodRange: actual.normalizeEodRange, latestQuoteFromRange: actual.latestQuoteFromRange } };
});

import { runRefresh } from "@/lib/investments/refresh";

const OWNER_ID = "owner-1";

function assetRow(overrides: Record<string, unknown> = {}) {
  return { id: "asset-1", category: "stock", ticker: "NVDA", exchange: null, native_currency: "USD", pricing_provider: "twelve_data", external_id: "NVDA:", ...overrides };
}

beforeEach(() => {
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
  twelveDataProvider.getQuote.mockReset();
  pokePulseProvider.getQuote.mockReset();
  getEodRangeMock.mockReset();
  isEodhdConfiguredMock.mockReset();
  isEodhdConfiguredMock.mockReturnValue(true);
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.includes("status=eq.running")) return []; // no concurrent run in progress
    if (path.startsWith("investment_assets?")) return [assetRow()];
    return [];
  });
  supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
    // Default: every snapshot POST genuinely inserts a fresh row (matches
    // real `return=representation` behaviour) — a test that needs to
    // simulate an IGNORED duplicate insert overrides this explicitly.
    if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
      return new Response(JSON.stringify([{ id: `snap-${Math.random().toString(36).slice(2)}`, created_at: new Date().toISOString() }]), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  });
});

describe("refresh orchestration — partial success", () => {
  it("one failing asset does not block a successful one in the same run", async () => {
    vi.useFakeTimers();
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [
        assetRow({ id: "good", ticker: "NVDA" }),
        assetRow({ id: "bad", ticker: "BADTICKER" }),
      ];
      return [];
    });
    twelveDataProvider.getQuote.mockImplementation(async (ticker: string) =>
      ticker === "NVDA"
        ? { ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } }
        : { ok: false, error: "Invalid symbol", retryable: false },
    );

    // Two twelve_data assets in one run genuinely triggers this module's
    // own inter-call pacing (see refresh.ts's TWELVE_DATA_MIN_INTERVAL_MS)
    // — fake timers let that real 8s spacing resolve instantly here.
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect("skipped" in result).toBe(false);
    if (!("skipped" in result)) {
      expect(result.status).toBe("partial_failure");
      expect(result.results.find(r => r.assetId === "good")?.ok).toBe(true);
      expect(result.results.find(r => r.assetId === "bad")?.ok).toBe(false);
    }
  });

  it("a failed PokePulse item does not erase valid stock results, and vice versa", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [
        assetRow({ id: "stock1", category: "stock", ticker: "NVDA", pricing_provider: "twelve_data" }),
        assetRow({ id: "poke1", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "card:x" }),
      ];
      return [];
    });
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: false, error: "PokePulse returned no market price for this item.", retryable: true });

    vi.useFakeTimers();
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if (!("skipped" in result)) {
      expect(result.results.find(r => r.assetId === "stock1")?.ok).toBe(true);
      expect(result.results.find(r => r.assetId === "poke1")?.ok).toBe(false);
      expect(result.status).toBe("partial_failure");
    }
  });

  it("every asset failing marks the run 'failed', not 'partial_failure'", async () => {
    vi.useFakeTimers();
    twelveDataProvider.getQuote.mockResolvedValue({ ok: false, error: "down", retryable: true });
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if (!("skipped" in result)) expect(result.status).toBe("failed");
  });

  it("every asset succeeding marks the run 'completed'", async () => {
    vi.useFakeTimers();
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if (!("skipped" in result)) expect(result.status).toBe("completed");
  });

  it("REGRESSION: never overwrites a previous valid snapshot with a failed result — a failed asset simply produces no new snapshot write", async () => {
    vi.useFakeTimers();
    twelveDataProvider.getQuote.mockResolvedValue({ ok: false, error: "down", retryable: true });
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();
    const snapshotWrites = supabaseRequest.mock.calls.filter(c => c[0] === "investment_price_snapshots");
    expect(snapshotWrites).toHaveLength(0);
  });

  it("LEGO (manual-provider) assets are included in the run's own counts but never priced or written — automation never touches a manual valuation", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) {
        // Cash (pricing_provider='none') is excluded via category=neq.cash;
        // manual (LEGO) assets ARE included so the run's own counts stay
        // accurate — they just always resolve to the 'manual' outcome
        // below with zero provider calls.
        expect(path).toContain("category=neq.cash");
        expect(path).not.toContain("pricing_provider=in.");
        return [assetRow({ id: "lego1", category: "lego", ticker: null, pricing_provider: "manual", external_id: null })];
      }
      return [];
    });
    const result = await runRefresh(OWNER_ID, "manual");
    if (!("skipped" in result)) {
      expect(result.results).toEqual([{ assetId: "lego1", provider: "manual", outcome: "manual", ok: true }]);
      expect(result.counts.manual).toBe(1);
      expect(result.status).toBe("completed");
    }
    expect(twelveDataProvider.getQuote).not.toHaveBeenCalled();
    expect(pokePulseProvider.getQuote).not.toHaveBeenCalled();
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_price_snapshots")).toBe(false);
  });

  it("REGRESSION: refuses to start a second refresh while one is already running for this owner", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [{ id: "already-running" }];
      return [];
    });
    const result = await runRefresh(OWNER_ID, "manual");
    expect(result).toEqual({ skipped: "already_running" });
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_refresh_runs")).toBe(false);
  });

  it("resolves a non-GBP stock's FX rate via the FX provider before writing its snapshot", async () => {
    vi.useFakeTimers();
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();
    expect(getFxRate).toHaveBeenCalledWith("USD", expect.any(String));
    const snapshotWrite = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    expect(snapshotWrite).toBeDefined();
    const body = JSON.parse((snapshotWrite![1] as RequestInit).body as string);
    expect(body.gbp_unit_price).toBeCloseTo(180 * 0.8);
  });

  it("REGRESSION: a successful ordinary refresh also rides along a cheap trailing-window history catch-up — history stays current without any separate manual step", async () => {
    vi.useFakeTimers();
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-08-11", nativeUnitPrice: 179 }] });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_transactions?")) return new Response(JSON.stringify([{ trade_at: "2026-01-01T00:00:00.000Z" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        return new Response(JSON.stringify([{ id: "snap-1", created_at: new Date().toISOString() }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    // Catch-up's own getHistory call now shares Twelve Data's inter-call
    // pacing with the quote call above (see refresh.ts's own comment on
    // this real, confirmed-live bug) — fake timers resolve that real delay
    // instantly here.
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();
    expect(twelveDataProvider.getHistory).toHaveBeenCalled();
    const [, , startArg, endArg] = twelveDataProvider.getHistory.mock.calls[0];
    const today = new Date().toISOString().slice(0, 10);
    expect(endArg < today).toBe(true); // never requests today (unfinished trading day)
    expect(startArg <= endArg).toBe(true);
  });

  it("a catch-up failure never turns an otherwise-successful price refresh into a failed result", async () => {
    vi.useFakeTimers();
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    twelveDataProvider.getHistory.mockRejectedValue(new Error("provider hiccup"));
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if (!("skipped" in result)) expect(result.status).toBe("completed");
  });
});

describe("refresh orchestration — PokePulse request deduplication", () => {
  it("two holdings mapping to the exact same external product ID trigger only ONE PokePulse request, and both get the same result", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [
        assetRow({ id: "holding-a", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "sealed:sv8|Surging Sparks Elite Trainer Box" }),
        assetRow({ id: "holding-b", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "sealed:sv8|Surging Sparks Elite Trainer Box" }),
      ];
      return [];
    });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 114.34, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" } });

    const result = await runRefresh(OWNER_ID, "manual");
    expect(pokePulseProvider.getQuote).toHaveBeenCalledTimes(1);
    if (!("skipped" in result)) {
      expect(result.results.find(r => r.assetId === "holding-a")?.outcome).toBe("updated");
      expect(result.results.find(r => r.assetId === "holding-b")?.outcome).toBe("updated");
      expect(result.pokePulseDedup).toEqual({ holdings: 2, uniqueProducts: 1 });
    }
  });

  it("two holdings with DIFFERENT external product IDs each trigger their own request — never merged by similar names", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [
        assetRow({ id: "etb", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "sealed:sv8|Surging Sparks Elite Trainer Box" }),
        assetRow({ id: "booster-box", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "sealed:sv8|Surging Sparks Booster Box" }),
      ];
      return [];
    });
    pokePulseProvider.getQuote.mockImplementation(async (productId: string) => ({
      ok: true, data: { nativeUnitPrice: productId.includes("Booster Box") ? 165.32 : 114.34, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" },
    }));

    const result = await runRefresh(OWNER_ID, "manual");
    expect(pokePulseProvider.getQuote).toHaveBeenCalledTimes(2);
    if (!("skipped" in result)) {
      expect(result.results.find(r => r.assetId === "etb")?.nativeUnitPrice).toBe(114.34);
      expect(result.results.find(r => r.assetId === "booster-box")?.nativeUnitPrice).toBe(165.32);
      expect(result.pokePulseDedup).toEqual({ holdings: 2, uniqueProducts: 2 });
    }
  });

  it("REGRESSION: a retried PokePulse holding evicts the cached failure first — the retry issues a genuinely new request, never re-serving the same cached failure", async () => {
    vi.useFakeTimers();
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "p1", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "sealed:me04|Chaos Rising Booster Box" })];
      return [];
    });
    let attempt = 0;
    pokePulseProvider.getQuote.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, error: "PokePulse rate limit reached.", retryable: true, code: "rate_limited" };
      return { ok: true, data: { nativeUnitPrice: 165.32, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" } };
    });
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect(attempt).toBe(2);
    if (!("skipped" in result)) expect(result.results[0].outcome).toBe("updated");
  });
});

describe("refresh orchestration — progress reporting", () => {
  it("reports progress exactly once per holding, in order, only after each holding's final result is known", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [
        assetRow({ id: "a", pricing_provider: "twelve_data", ticker: "NVDA" }),
        assetRow({ id: "b", category: "pokemon", ticker: null, pricing_provider: "pokepulse", external_id: "sealed:x|Y" }),
      ];
      return [];
    });
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 50, nativeCurrency: "GBP", priceAt: "2026-08-12T00:00:00.000Z", provider: "pokepulse" } });

    vi.useFakeTimers();
    const ticks: Array<{ completed: number; total: number }> = [];
    const promise = runRefresh(OWNER_ID, "manual", p => ticks.push(p));
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();
    expect(ticks).toEqual([{ completed: 1, total: 2 }, { completed: 2, total: 2 }]);
  });
});

function eodhdAssetRow(overrides: Record<string, unknown> = {}) {
  return { id: "v3ab", category: "stock", ticker: "V3AB", exchange: "LSE", native_currency: "GBP", pricing_provider: "eodhd", external_id: "V3AB:LSE", provider_quote_unit: "GBX", ...overrides };
}

describe("refresh orchestration — EODHD (explicit unit, no magnitude guessing)", () => {
  it("REGRESSION: an asset with no verified provider_quote_unit is refused outright, never guessed from magnitude", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow({ provider_quote_unit: null })];
      return [];
    });
    const result = await runRefresh(OWNER_ID, "manual");
    if (!("skipped" in result)) {
      expect(result.results[0].outcome).toBe("provider_mapping_missing");
      expect(result.results[0].ok).toBe(false);
    }
    expect(getEodRangeMock).not.toHaveBeenCalled(); // never even attempts a request without a verified unit
  });

  it("REGRESSION: V3AB's real ~588 GBX price normalizes to £5.88 end-to-end through the real refresh path, never £588", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow()];
      return [];
    });
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-08-17", rawPrice: 588 }] });
    const result = await runRefresh(OWNER_ID, "manual");
    if (!("skipped" in result)) {
      expect(result.results[0].outcome).toBe("updated");
      expect(result.results[0].nativeUnitPrice).toBeCloseTo(5.88);
      expect(result.results[0].nativeUnitPrice).toBeLessThan(10); // nowhere near the old heuristic's £588 error
    }
    const snapshotWrite = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots" && (c[1] as RequestInit).body?.toString().includes("v3ab"));
    expect(snapshotWrite).toBeDefined();
    const body = JSON.parse((snapshotWrite![1] as RequestInit).body as string);
    expect(body.native_unit_price).toBeCloseTo(5.88);
    expect(body.raw_provider_price).toBe(588);
    expect(body.provider_quote_unit).toBe("GBX");
    expect(body.normalization_multiplier).toBe(0.01);
  });

  it("REGRESSION (confirmed live): a brand-new EODHD asset with NO prior snapshot requests a real trailing window, never a collapsed from=today&to=today range that EODHD (an end-of-day provider) always returns empty for", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow()];
      if (path.startsWith("investment_price_snapshots?")) return []; // no prior snapshot for this asset at all
      return [];
    });
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-08-14", rawPrice: 144.34 }] });
    await runRefresh(OWNER_ID, "manual");
    expect(getEodRangeMock).toHaveBeenCalledTimes(1);
    const [, , fromArg, toArg] = getEodRangeMock.mock.calls[0];
    expect(fromArg).not.toBe(toArg); // a real window, not a single collapsed day
    expect(fromArg < toArg).toBe(true);
  });

  it("ONE combined EODHD request serves both the quote and the trailing-history catch-up — never a second, separate request for the same asset in the same run", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow()];
      return [];
    });
    getEodRangeMock.mockResolvedValue({
      ok: true,
      data: [{ date: "2026-08-13", rawPrice: 580 }, { date: "2026-08-14", rawPrice: 585 }, { date: "2026-08-17", rawPrice: 588 }],
    });
    await runRefresh(OWNER_ID, "manual");
    expect(getEodRangeMock).toHaveBeenCalledTimes(1);
    // The earlier two points in the SAME response are written as ordinary
    // history snapshots — no separate catch-up request needed for them.
    const historyWrites = supabaseRequest.mock.calls.filter(c => c[0] === "investment_price_snapshots");
    const allBodies = historyWrites.flatMap(c => JSON.parse((c[1] as RequestInit).body as string));
    const bodies = Array.isArray(allBodies) ? allBodies : [allBodies];
    const writtenDates = bodies.map((b: { price_at: string }) => b.price_at.slice(0, 10));
    expect(writtenDates).toEqual(expect.arrayContaining(["2026-08-13", "2026-08-14", "2026-08-17"]));
  });

  it("skips the EODHD request entirely when the latest completed LSE session is already stored — real quota conservation, not just a display nicety", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T20:00:00Z")); // a Monday, well after LSE close
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow()];
      if (path.startsWith("investment_price_snapshots?")) return [{ asset_id: "v3ab", native_unit_price: "6.65", price_at: "2026-08-17T00:00:00.000Z" }];
      return [];
    });
    const result = await runRefresh(OWNER_ID, "manual");
    vi.useRealTimers();
    expect(getEodRangeMock).not.toHaveBeenCalled();
    if (!("skipped" in result)) expect(["unchanged_current", "market_closed_current"]).toContain(result.results[0].outcome);
  });

  it("REGRESSION: a proposed price ~100x the last known good value is quarantined, never written — defense-in-depth against exactly the class of GBX/GBP mismatch this feature exists to prevent", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow()];
      if (path.startsWith("investment_price_snapshots?")) return [{ asset_id: "v3ab", native_unit_price: "6.65", price_at: "2026-08-10T00:00:00.000Z" }];
      return [];
    });
    // Correctly normalized (GBX -> GBP) this raw value becomes £665 —
    // genuinely ~100x the last known good £6.65 — the guard must catch
    // this regardless of whether the unit itself was correct, since a
    // provider-side data glitch could produce this even with a verified unit.
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-08-17", rawPrice: 66500 }] });
    const result = await runRefresh(OWNER_ID, "manual");
    if (!("skipped" in result)) {
      expect(result.results[0].outcome).not.toBe("updated");
      expect(result.results[0].ok).toBe(false);
    }
    // No snapshot was written for the implausible price.
    const snapshotWrite = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    expect(snapshotWrite).toBeUndefined();
  });

  it("a genuinely missing EODHD_API_KEY is a clean, non-retryable configuration outcome — never a crash", async () => {
    isEodhdConfiguredMock.mockReturnValue(false);
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow()];
      return [];
    });
    const result = await runRefresh(OWNER_ID, "manual");
    if (!("skipped" in result)) {
      expect(result.results[0].outcome).toBe("provider_mapping_missing");
    }
    expect(getEodRangeMock).not.toHaveBeenCalled();
  });

  it("a failed EODHD asset does not block other holdings in the same run", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [eodhdAssetRow({ id: "v3ab" }), assetRow({ id: "nvda", pricing_provider: "twelve_data" })];
      return [];
    });
    getEodRangeMock.mockResolvedValue({ ok: false, error: "EODHD returned 500.", retryable: true });
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-12T00:00:00.000Z", provider: "twelve_data" } });
    vi.useFakeTimers();
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if (!("skipped" in result)) {
      expect(result.results.find(r => r.assetId === "v3ab")?.ok).toBe(false);
      expect(result.results.find(r => r.assetId === "nvda")?.ok).toBe(true);
    }
  });
});

describe("same-day price revisions — confirmed-live bug: a genuinely different same-day price must never be silently discarded", () => {
  function mockLastSnapshot(row: { asset_id: string; native_unit_price: string; price_at: string; gbp_unit_price?: string; id?: string; created_at?: string }) {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "chaos-rising", pricing_provider: "pokepulse", ticker: null, external_id: "sealed:x" })];
      if (path.includes("asset_id=in.")) return [{ ...row, id: row.id ?? "old-snap", gbp_unit_price: row.gbp_unit_price ?? row.native_unit_price, created_at: row.created_at ?? "2026-08-17T07:57:00.000Z" }];
      return [];
    });
  }

  it("REGRESSION: Chaos Rising Elite Trainer Box — a genuinely different price on the SAME aggregation date is stored as a new revision and reported as 'updated'", async () => {
    mockLastSnapshot({ asset_id: "chaos-rising", native_unit_price: "69.64", price_at: "2026-08-17T00:00:00.000Z" });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 70.31, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" } });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.native_unit_price).toBe(70.31); // the genuinely new price is what gets sent, never dropped
        return new Response(JSON.stringify([{ id: "snap-new", created_at: "2026-08-17T12:57:00.000Z" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const result = await runRefresh(OWNER_ID, "manual");
    if ("skipped" in result) throw new Error("unexpected skip");
    expect(result.results[0].outcome).toBe("updated");
    expect(result.results[0].snapshotWritten).toBe(true);
    expect(result.results[0].snapshotId).toBe("snap-new");
    expect(result.results[0].previousPrice).toBe(69.64);
    expect(result.results[0].selectedStoredPrice).toBe(70.31);
  });

  it("an identical same-day price never attempts a write and is reported unchanged_current — no duplicate row", async () => {
    mockLastSnapshot({ asset_id: "chaos-rising", native_unit_price: "69.64", price_at: "2026-08-17T00:00:00.000Z" });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 69.64, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" } });
    const result = await runRefresh(OWNER_ID, "manual");
    if ("skipped" in result) throw new Error("unexpected skip");
    expect(result.results[0].outcome).toBe("unchanged_current");
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_price_snapshots" && (c[1] as RequestInit)?.method === "POST")).toBe(false);
  });

  it("an ignored insert (exact duplicate under the widened key) whose real stored winner matches the returned quote is honestly reported as 'updated', never assumed", async () => {
    mockLastSnapshot({ asset_id: "chaos-rising", native_unit_price: "69.64", price_at: "2026-08-17T00:00:00.000Z" });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 67.52, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" } });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      // The insert is IGNORED — simulates a concurrent writer having just
      // inserted the identical 67.52 revision a moment earlier.
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        return new Response(JSON.stringify([]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      // The follow-up "what's the real current winner" lookup — proves the
      // concurrent writer's row, not our own failed attempt.
      if (path.includes("asset_id=eq.chaos-rising")) {
        return new Response(JSON.stringify([{ id: "snap-concurrent", native_unit_price: "67.52", gbp_unit_price: "67.52", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T13:39:00.000Z" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const result = await runRefresh(OWNER_ID, "manual");
    if ("skipped" in result) throw new Error("unexpected skip");
    expect(result.results[0].outcome).toBe("updated");
    expect(result.results[0].snapshotWritten).toBe(false);
    expect(result.results[0].snapshotId).toBe("snap-concurrent");
    expect(result.results[0].selectedStoredPrice).toBe(67.52);
  });

  it("PROOF an ignored insert can NEVER be blindly reported as 'updated': when the real stored winner still equals what we already knew, the outcome is unchanged_current", async () => {
    mockLastSnapshot({ asset_id: "chaos-rising", native_unit_price: "69.64", price_at: "2026-08-17T00:00:00.000Z" });
    // The provider returns a different value, but the write is ignored AND
    // the real stored winner (queried afterward) turns out to still be the
    // pre-refresh 69.64 — proving this codepath never trusts the HTTP
    // response alone.
    pokePulseProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 70.31, nativeCurrency: "GBP", priceAt: "2026-08-17T00:00:00.000Z", provider: "pokepulse" } });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        return new Response(JSON.stringify([]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (path.includes("asset_id=eq.chaos-rising")) {
        return new Response(JSON.stringify([{ id: "old-snap", native_unit_price: "69.64", gbp_unit_price: "69.64", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T07:57:00.000Z" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const result = await runRefresh(OWNER_ID, "manual");
    if ("skipped" in result) throw new Error("unexpected skip");
    expect(result.results[0].outcome).toBe("unchanged_current");
    expect(result.results[0].snapshotWritten).toBe(false);
    expect(result.results[0].selectedStoredPrice).toBe(69.64);
  });

  it("a different FX-derived GBP price (native price unchanged) is still genuinely stored — Twelve Data USD assets", async () => {
    vi.useFakeTimers();
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "nvda", pricing_provider: "twelve_data", ticker: "NVDA" })];
      if (path.includes("asset_id=in.")) return [{ asset_id: "nvda", id: "old-snap", native_unit_price: "180", gbp_unit_price: "144", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T07:00:00.000Z" }];
      return [];
    });
    // Native price genuinely different here too — this proves the WRITE
    // layer itself correctly persists a distinct GBP value once a write is
    // attempted. The FX-ONLY case (native price identical, only FX moves)
    // is covered by the dedicated test below, which exercises
    // maybeWriteFxOnlyRevision — the fix for the gap this comment used to
    // describe (see refresh.ts's own comment on that function).
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 181, nativeCurrency: "USD", priceAt: "2026-08-17T00:00:00.000Z", provider: "twelve_data" } });
    getFxRate.mockResolvedValueOnce({ rate: 0.79, requestedDate: "2026-08-17", provider: "frankfurter" as const });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.gbp_unit_price).toBeCloseTo(181 * 0.79);
        return new Response(JSON.stringify([{ id: "snap-fx", created_at: "2026-08-17T12:00:00.000Z" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if ("skipped" in result) throw new Error("unexpected skip");
    expect(result.results[0].outcome).toBe("updated");
  });

  it("FIX (sign-off audit item 4 — required invariant): a USD holding whose native price is UNCHANGED still produces a genuinely different, non-zero GBP value when only the FX rate moves — two different real historical FX rates, no contribution or withdrawal", async () => {
    vi.useFakeTimers();
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "nvda", pricing_provider: "twelve_data", ticker: "NVDA" })];
      // Last stored snapshot: native £180, fx 0.80 -> gbp £144.00 (the FX rate the OLD implicit rate is derived from — 144/180 = 0.80).
      if (path.includes("asset_id=in.")) return [{ asset_id: "nvda", id: "old-snap", native_unit_price: "180", gbp_unit_price: "144", price_at: "2026-08-16T00:00:00.000Z", created_at: "2026-08-16T07:00:00.000Z" }];
      return [];
    });
    // Same native price AND same price_at as the last snapshot — isSameObservation is TRUE, the exact short-circuit condition this fix addresses.
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-16T00:00:00.000Z", provider: "twelve_data" } });
    // A second, genuinely different real historical GBP/USD rate (0.80 -> 0.75) — the only thing that moved.
    getFxRate.mockResolvedValueOnce({ rate: 0.75, requestedDate: "2026-08-17", provider: "frankfurter" as const });

    let writtenBody: Record<string, unknown> | null = null;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        writtenBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify([{ id: "snap-fx-only", created_at: "2026-08-17T09:00:00.000Z" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });

    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if ("skipped" in result) throw new Error("unexpected skip");

    // The refresh is classified as a genuine update, not unchanged_current — the GBP value DID change even though the native price didn't.
    expect(result.results[0].outcome).toBe("updated");
    expect(result.results[0].snapshotWritten).toBe(true);
    expect(writtenBody).not.toBeNull();
    expect(writtenBody!.native_unit_price).toBe(180); // carried forward, never fabricated
    expect(writtenBody!.fx_rate).toBe(0.75); // the genuine new FX observation
    expect(writtenBody!.gbp_unit_price).toBeCloseTo(180 * 0.75); // £135.00 — a real, non-zero change from the prior £144.00
    expect(writtenBody!.gbp_unit_price).not.toBeCloseTo(144); // proves this isn't just re-persisting the old GBP value
    // FX-timestamp model (2026-08-17 forensic audit): this row's price_at
    // is the new FX-revaluation instant, NOT when the exchange actually
    // priced NVDA — native_price_observed_at must carry the true original
    // observation (the prior snapshot's own price_at) forward, so a
    // consumer never mistakes this Monday-style revision for a new
    // exchange-supplied price. See supabase-investments.sql's PENDING
    // native_price_observed_at migration and holding-status.ts's own use
    // of this field.
    expect(writtenBody!.native_price_observed_at).toBe("2026-08-16T00:00:00.000Z");
  });

  it("FX timestamp model: two genuinely different same-native-price FX valuations in a row each write their OWN distinct, auditable row — neither overwrites the other, both remain independently retrievable", async () => {
    vi.useFakeTimers();
    const insertedBodies: Record<string, unknown>[] = [];
    let latestSnapshot = { asset_id: "nvda", id: "old-snap", native_unit_price: "180", gbp_unit_price: "144", price_at: "2026-08-16T00:00:00.000Z", created_at: "2026-08-16T07:00:00.000Z" };
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "nvda", pricing_provider: "twelve_data", ticker: "NVDA" })];
      if (path.includes("asset_id=in.")) return [latestSnapshot];
      return [];
    });
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-16T00:00:00.000Z", provider: "twelve_data" } });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        insertedBodies.push(body);
        return new Response(JSON.stringify([{ id: `snap-${insertedBodies.length}`, created_at: new Date().toISOString() }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });

    // First FX-only revision: 0.80 -> 0.75.
    getFxRate.mockResolvedValueOnce({ rate: 0.75, requestedDate: "2026-08-17", provider: "frankfurter" as const });
    let promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    await promise;
    // The next refresh call sees the row just written as its new "last snapshot".
    latestSnapshot = { asset_id: "nvda", id: "snap-1", native_unit_price: "180", gbp_unit_price: String(180 * 0.75), price_at: insertedBodies[0].price_at as string, created_at: insertedBodies[0].price_at as string };

    // Second, genuinely different FX revision: 0.75 -> 0.70.
    getFxRate.mockResolvedValueOnce({ rate: 0.70, requestedDate: "2026-08-18", provider: "frankfurter" as const });
    promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(insertedBodies).toHaveLength(2);
    expect(insertedBodies[0].fx_rate).toBe(0.75);
    expect(insertedBodies[1].fx_rate).toBe(0.70);
    // First revision: a genuine FX-only revision (isSameObservation matched
    // the true prior snapshot) — price_at is the new revision instant,
    // native_price_observed_at correctly points back at the true native
    // observation.
    expect(insertedBodies[0].native_price_observed_at).toBe("2026-08-16T00:00:00.000Z");
    expect(insertedBodies[0].price_at).not.toBe("2026-08-16T00:00:00.000Z");
    // Second call: the "last snapshot" is now the first revision's own
    // synthetic instant, which no longer matches the provider's still-
    // pinned real priceAt ("2026-08-16") — isSameObservation is correctly
    // FALSE (a genuinely different price_at from what's now stored), so
    // this self-correctingly falls through to the ORDINARY write path
    // rather than chaining a second FX-only revision. That path writes
    // price_at as the quote's own true native date directly — no
    // native_price_observed_at needed, because price_at itself is already
    // accurate for this row. Both revisions remain independently
    // retrievable, real, distinct, non-colliding rows either way.
    expect(insertedBodies[1].price_at).toBe("2026-08-16T00:00:00.000Z");
    expect(insertedBodies[1].native_price_observed_at).toBeUndefined();
  });

  it("an unchanged native price with FX that genuinely has NOT moved still short-circuits to unchanged_current with no write — the fix never writes a spurious revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T15:00:00Z")); // a Monday, 11:00 ET — during regular US market hours, so the outcome is deterministically unchanged_current, never market_closed_current
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "nvda", pricing_provider: "twelve_data", ticker: "NVDA" })];
      if (path.includes("asset_id=in.")) return [{ asset_id: "nvda", id: "old-snap", native_unit_price: "180", gbp_unit_price: "144", price_at: "2026-08-16T00:00:00.000Z", created_at: "2026-08-16T07:00:00.000Z" }];
      return [];
    });
    twelveDataProvider.getQuote.mockResolvedValue({ ok: true, data: { nativeUnitPrice: 180, nativeCurrency: "USD", priceAt: "2026-08-16T00:00:00.000Z", provider: "twelve_data" } });
    getFxRate.mockResolvedValueOnce({ rate: 0.8, requestedDate: "2026-08-17", provider: "frankfurter" as const }); // identical to the implicit rate behind the stored 144/180
    const promise = runRefresh(OWNER_ID, "manual");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    if ("skipped" in result) throw new Error("unexpected skip");
    expect(result.results[0].outcome).toBe("unchanged_current");
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_price_snapshots" && (c[1] as RequestInit)?.method === "POST")).toBe(false);
  });
});

describe("orphaned refresh-run recovery", () => {
  it("a stale 'running' row (older than the defensible timeout) is reclaimed as 'failed' with a sanitized reason before a new refresh starts", async () => {
    let patchedStaleRun: { path: string; body: Record<string, unknown> } | null = null;
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return []; // reclaimed already by the time the concurrency check runs
      if (path.startsWith("investment_assets?")) return [];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes("status=eq.running") && init?.method === "PATCH") {
        patchedStaleRun = { path, body: JSON.parse(init.body as string) };
        return new Response(null, { status: 204 });
      }
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-2" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      return new Response(null, { status: 204 });
    });
    await runRefresh(OWNER_ID, "manual");
    expect(patchedStaleRun).not.toBeNull();
    expect(patchedStaleRun!.body.status).toBe("failed");
    expect(String(patchedStaleRun!.body.failure_reason)).toMatch(/abandoned/i);
    // Never deletes — only ever a PATCH, confirmed by the mock never
    // seeing a DELETE method for this path.
    expect(supabaseRequest.mock.calls.some(c => c[0].toString().includes("status=eq.running") && (c[1] as RequestInit)?.method === "DELETE")).toBe(false);
  });

  it("a genuinely active run (started within the timeout) still blocks a new refresh — never incorrectly abandoned", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [{ id: "active-run" }];
      return [];
    });
    const result = await runRefresh(OWNER_ID, "manual");
    expect(result).toEqual({ skipped: "already_running" });
  });

  it("an unexpected exception mid-run finalizes the run row as 'failed' with a sanitized reason instead of leaving it stuck at 'running'", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("status=eq.running")) return [];
      if (path.startsWith("investment_assets?")) return [assetRow({ id: "boom" })];
      return [];
    });
    twelveDataProvider.getQuote.mockImplementation(async () => { throw new Error("simulated provider crash"); });
    let finalizePatch: Record<string, unknown> | null = null;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-3" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      if (path === "investment_refresh_runs?id=eq.run-3" && init?.method === "PATCH") {
        finalizePatch = JSON.parse(init.body as string);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
    await expect(runRefresh(OWNER_ID, "manual")).rejects.toThrow("simulated provider crash");
    expect(finalizePatch).not.toBeNull();
    expect((finalizePatch as unknown as { status: string }).status).toBe("failed");
    expect(String((finalizePatch as unknown as { failure_reason: string }).failure_reason)).toMatch(/simulated provider crash/);
  });
});
