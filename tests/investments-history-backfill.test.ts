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

const { getFxRatesForRange, nearestRate } = vi.hoisted(() => ({
  getFxRatesForRange: vi.fn(),
  nearestRate: vi.fn((map: Map<string, number>, date: string) => {
    if (map.size === 0) return null;
    const dates = [...map.keys()].sort();
    let best: string | null = null;
    for (const d of dates) { if (d <= date) best = d; else break; }
    return map.get(best ?? dates[0]) ?? null;
  }),
}));
vi.mock("@/lib/investments/providers/fx-provider", () => ({ getFxRatesForRange, nearestRate }));

import { backfillOneAsset, runHistoryBackfill, type BackfillAssetRow } from "@/lib/investments/history-backfill";

const OWNER_ID = "owner-1";

function assetRow(overrides: Partial<BackfillAssetRow> = {}): BackfillAssetRow {
  return { id: "asset-1", ticker: "NVDA", exchange: "NASDAQ", native_currency: "USD", pricing_provider: "twelve_data", external_id: null, ...overrides };
}

beforeEach(() => {
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
  twelveDataProvider.getHistory.mockReset();
  pokePulseProvider.getHistory.mockReset();
  getFxRatesForRange.mockReset();
  getFxRatesForRange.mockResolvedValue(new Map([["2026-01-01", 0.8]]));

  // earliestBuyDate() uses supabaseRequest() directly (never supabaseRequestAll —
  // see this module's own REGRESSION-GUARD-driven comment).
  supabaseRequest.mockImplementation(async (path: string) => {
    if (path.startsWith("investment_transactions?")) {
      return new Response(JSON.stringify([{ trade_at: "2026-01-01T00:00:00.000Z" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  });
});

describe("backfillOneAsset", () => {
  it("requests history from the earliest BUY date through yesterday — never before the first purchase", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-01-02", nativeUnitPrice: 100 }] });
    await backfillOneAsset(OWNER_ID, assetRow());
    const [, exchange, startDate] = twelveDataProvider.getHistory.mock.calls[0];
    expect(twelveDataProvider.getHistory.mock.calls[0][0]).toBe("NVDA");
    expect(exchange).toBe("NASDAQ");
    expect(startDate).toBe("2026-01-01");
  });

  it("never requests today's date as the end (a daily-close provider has no data for an unfinished trading day)", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [] });
    await backfillOneAsset(OWNER_ID, assetRow());
    const endDate = twelveDataProvider.getHistory.mock.calls[0][3];
    const today = new Date().toISOString().slice(0, 10);
    expect(endDate < today).toBe(true);
  });

  it("an asset with no buy transaction on record is skipped, not treated as an error", async () => {
    supabaseRequest.mockImplementation(async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await backfillOneAsset(OWNER_ID, assetRow());
    expect(result.ok).toBe(true);
    expect(result.pointsWritten).toBe(0);
  });

  it("a USD stock converts every point using the historical FX rate for that date, via ONE range request (never per-date)", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({
      ok: true, data: [{ date: "2026-01-01", nativeUnitPrice: 100 }, { date: "2026-01-02", nativeUnitPrice: 110 }],
    });
    getFxRatesForRange.mockResolvedValue(new Map([["2026-01-01", 0.8], ["2026-01-02", 0.82]]));
    await backfillOneAsset(OWNER_ID, assetRow());
    expect(getFxRatesForRange).toHaveBeenCalledTimes(1);
    const writeCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    const body = JSON.parse((writeCall![1] as RequestInit).body as string);
    expect(body[0].gbp_unit_price).toBeCloseTo(100 * 0.8);
    expect(body[1].gbp_unit_price).toBeCloseTo(110 * 0.82);
  });

  it("a GBP-native stock skips the FX lookup entirely (fxRate always 1, no wasted request)", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-01-01", nativeUnitPrice: 130 }] });
    await backfillOneAsset(OWNER_ID, assetRow({ native_currency: "GBP" }));
    expect(getFxRatesForRange).not.toHaveBeenCalled();
    const writeCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    const body = JSON.parse((writeCall![1] as RequestInit).body as string);
    expect(body[0].gbp_unit_price).toBe(130);
    expect(body[0].fx_rate).toBe(1);
  });

  it("PokePulse values are written as-is with no FX conversion (already GBP)", async () => {
    pokePulseProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-01-01", nativeUnitPrice: 45.5 }] });
    await backfillOneAsset(OWNER_ID, assetRow({ pricing_provider: "pokepulse", external_id: "prod-1", ticker: null, native_currency: "GBP" }));
    expect(getFxRatesForRange).not.toHaveBeenCalled();
    const writeCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    const body = JSON.parse((writeCall![1] as RequestInit).body as string);
    expect(body[0].gbp_unit_price).toBe(45.5);
  });

  it("a plan-restricted symbol (VUAG-style) fails this ONE asset honestly without throwing", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: false, error: "This symbol is available starting with the Grow or Venture plan." });
    const result = await backfillOneAsset(OWNER_ID, assetRow({ ticker: "VUAG" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Grow or Venture plan/);
  });

  it("a LEGO/manual asset is skipped — never fetched, no invented history", async () => {
    const result = await backfillOneAsset(OWNER_ID, assetRow({ pricing_provider: "manual" }));
    expect(result.ok).toBe(false);
    expect(twelveDataProvider.getHistory).not.toHaveBeenCalled();
    expect(pokePulseProvider.getHistory).not.toHaveBeenCalled();
  });

  it("a trading date with no exact FX match uses the nearest earlier rate, never a silent 1", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-01-03", nativeUnitPrice: 100 }] }); // a stock-only trading day
    getFxRatesForRange.mockResolvedValue(new Map([["2026-01-01", 0.75]])); // FX has no 2026-01-03 entry
    await backfillOneAsset(OWNER_ID, assetRow());
    const writeCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    const body = JSON.parse((writeCall![1] as RequestInit).body as string);
    expect(body[0].fx_rate).toBe(0.75);
  });

  it("a date with genuinely no FX rate available anywhere is dropped, not defaulted to 1", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-01-01", nativeUnitPrice: 100 }] });
    getFxRatesForRange.mockResolvedValue(new Map()); // nothing available at all
    const result = await backfillOneAsset(OWNER_ID, assetRow());
    expect(result.pointsWritten).toBe(0);
  });

  it("writes points at a fixed midday timestamp per date, so a repeat run collides with (and dedupes against) the same date", async () => {
    twelveDataProvider.getHistory.mockResolvedValue({ ok: true, data: [{ date: "2026-01-01", nativeUnitPrice: 100 }] });
    await backfillOneAsset(OWNER_ID, assetRow({ native_currency: "GBP" }));
    const writeCall = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    const body = JSON.parse((writeCall![1] as RequestInit).body as string);
    expect(body[0].price_at).toBe("2026-01-01T12:00:00.000Z");
    const prefer = (writeCall![1] as RequestInit).headers as Record<string, string>;
    expect(prefer.Prefer).toContain("resolution=ignore-duplicates");
  });
});

describe("runHistoryBackfill — partial failure isolation", () => {
  it("one asset's failure never blocks another asset's successful backfill in the same run", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_assets?")) {
        return [assetRow({ id: "good", ticker: "NVDA" }), assetRow({ id: "bad", ticker: "VUAG" })];
      }
      return [];
    });
    twelveDataProvider.getHistory.mockImplementation(async (ticker: string) =>
      ticker === "NVDA"
        ? { ok: true, data: [{ date: "2026-01-01", nativeUnitPrice: 100 }] }
        : { ok: false, error: "This symbol is available starting with the Grow or Venture plan." },
    );
    const { results } = await runHistoryBackfill(OWNER_ID);
    expect(results.find(r => r.assetId === "good")?.ok).toBe(true);
    expect(results.find(r => r.assetId === "bad")?.ok).toBe(false);
  });

  it("only queries twelve_data/pokepulse/eodhd assets — manual/none are never included in the run at all", async () => {
    await runHistoryBackfill(OWNER_ID);
    const assetsQuery = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("investment_assets?"))?.[0] as string;
    expect(assetsQuery).toContain("pricing_provider=in.(twelve_data,pokepulse,eodhd)");
  });
});
