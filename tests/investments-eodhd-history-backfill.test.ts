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
  nearestRate: vi.fn(() => null),
}));
vi.mock("@/lib/investments/providers/fx-provider", () => ({ getFxRatesForRange, nearestRate }));

// getEodRange is the ONLY EODHD entry point mocked — normalizeEodRange,
// latestQuoteFromRange, nativeCurrencyForUnit and multiplierForUnit stay
// the REAL implementations (via importOriginal), so these tests exercise
// the exact same normalizer the live current-price path already uses.
const { getEodRangeMock } = vi.hoisted(() => ({ getEodRangeMock: vi.fn() }));
vi.mock("@/lib/investments/providers/eodhd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investments/providers/eodhd")>();
  return {
    ...actual,
    eodhdProvider: {
      ...actual.eodhdProvider,
      isConfigured: () => true,
      getEodRange: getEodRangeMock,
    },
  };
});

import { backfillAllEodhdHistory, backfillEodhdAssetHistory, type BackfillAssetRow } from "@/lib/investments/history-backfill";
import { latestCompletedTradingDate } from "@/lib/investments/refresh-classification";

const OWNER_ID = "owner-1";
const REAL_LATEST_LSE_SESSION = latestCompletedTradingDate("LSE");
const FIRST_BUY = "2025-11-05";

function eodhdAssetRow(overrides: Partial<BackfillAssetRow> = {}): BackfillAssetRow {
  return { id: "asset-vwrp", ticker: "VWRP", exchange: "LSE", native_currency: "GBP", pricing_provider: "eodhd", external_id: null, provider_quote_unit: "GBP", ...overrides };
}

/** Every trading-day-ish date (Mon-Fri only) between two ISO dates, inclusive — a convenient synthetic "already fully backfilled" fixture. */
function weekdayDatesBetween(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function mockDbState(opts: { firstBuy?: string | null; existingSnapshotRows?: Array<{ price_at: string; native_unit_price: number }>; assets?: BackfillAssetRow[] }) {
  const { firstBuy = FIRST_BUY, existingSnapshotRows = [], assets = [eodhdAssetRow()] } = opts;
  supabaseRequest.mockImplementation(async (path: string) => {
    if (path.startsWith("investment_transactions?")) {
      return new Response(JSON.stringify(firstBuy ? [{ trade_at: `${firstBuy}T00:00:00.000Z` }] : []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  });
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("investment_price_snapshots?")) return existingSnapshotRows as unknown[];
    if (path.startsWith("investment_assets?")) return assets as unknown[];
    return [];
  });
}

function writeCallBodies(): Array<Record<string, unknown>> {
  const call = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots" && (c[1] as RequestInit)?.method === "POST");
  if (!call) return [];
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
  getEodRangeMock.mockReset();
  getFxRatesForRange.mockReset();
  nearestRate.mockReset();
  mockDbState({});
});

describe("backfillEodhdAssetHistory", () => {
  it("requests history starting exactly on the asset's first non-reversed buy date", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: FIRST_BUY, rawPrice: 140 }] });
    await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(getEodRangeMock).toHaveBeenCalledTimes(1);
    const [ticker, exchange, from] = getEodRangeMock.mock.calls[0];
    expect(ticker).toBe("VWRP");
    expect(exchange).toBe("LSE");
    expect(from).toBe(FIRST_BUY);
  });

  it("requests through the dynamically computed latest COMPLETED LSE session, never a hard-coded date", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: FIRST_BUY, rawPrice: 140 }] });
    await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    const [, , , to] = getEodRangeMock.mock.calls[0];
    expect(to).toBe(REAL_LATEST_LSE_SESSION);
    const today = new Date().toISOString().slice(0, 10);
    expect(to <= today).toBe(true);
  });

  it("never writes a point earlier than the first purchase date, even if the provider returns one", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2025-11-04", rawPrice: 139 }, { date: FIRST_BUY, rawPrice: 140 }] });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(result.ok).toBe(true);
    const body = writeCallBodies();
    expect(body.every(r => (r.price_at as string) >= FIRST_BUY)).toBe(true);
    expect(body.some(r => (r.price_at as string).startsWith("2025-11-04"))).toBe(false);
  });

  it("skips the EODHD request entirely once the stored range already looks like a complete daily series", async () => {
    const fullSeries = weekdayDatesBetween(FIRST_BUY, REAL_LATEST_LSE_SESSION).map(date => ({ price_at: `${date}T12:00:00.000Z`, native_unit_price: 144 }));
    mockDbState({ existingSnapshotRows: fullSeries });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(getEodRangeMock).not.toHaveBeenCalled();
    expect(result.skippedAlreadyCovered).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("does NOT skip when only a handful of dates exist (the real starting state — 3 dates, not a genuine daily series)", async () => {
    mockDbState({ existingSnapshotRows: [
      { price_at: "2026-08-12T12:00:00.000Z", native_unit_price: 144.1 },
      { price_at: "2026-08-13T12:00:00.000Z", native_unit_price: 144.2 },
      { price_at: "2026-08-14T00:00:00.000Z", native_unit_price: 144.34 },
    ] });
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: FIRST_BUY, rawPrice: 140 }] });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(getEodRangeMock).toHaveBeenCalledTimes(1);
    expect(result.skippedAlreadyCovered).toBe(false);
  });

  it("normalizes GBP explicitly with multiplier 1 — raw and normalized prices are identical, never divided by 100", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-01-05", rawPrice: 141.2 }] });
    await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    const body = writeCallBodies();
    expect(body).toHaveLength(1);
    expect(body[0].raw_provider_price).toBe(141.2);
    expect(body[0].native_unit_price).toBe(141.2);
    expect(body[0].gbp_unit_price).toBe(141.2);
    expect(body[0].normalization_multiplier).toBe(1);
    expect(body[0].provider_quote_unit).toBe("GBP");
    expect(body[0].fx_rate).toBe(1);
  });

  it("REGRESSION: V3AB-style raw closes (~6.6) stay single-digit GBP — never scaled up by 100x or down by 100x", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-01-05", rawPrice: 6.631 }] });
    await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow({ id: "asset-v3ab", ticker: "V3AB" }));
    const body = writeCallBodies();
    expect(body[0].native_unit_price).toBe(6.631);
    expect(body[0].native_unit_price).not.toBeCloseTo(663.1, 0);
    expect(body[0].native_unit_price).not.toBeCloseTo(0.06631, 3);
  });

  it("never applies a GBX-style 0.01 conversion for a GBP-verified asset (no magnitude-based guessing)", async () => {
    // A value that WOULD look like plausible GBX pence for a ~£145 fund if
    // magnitude-guessed — the asset's verified unit is GBP, so it must be
    // taken at face value, exactly the flaw this feature's design replaced.
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-01-05", rawPrice: 588 }] });
    await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    const body = writeCallBodies();
    expect(body[0].native_unit_price).toBe(588);
    expect(body[0].normalization_multiplier).toBe(1);
  });

  it("writes only genuinely new dates — an already-stored date is excluded from the write payload, not duplicated", async () => {
    mockDbState({ existingSnapshotRows: [{ price_at: "2026-08-14T00:00:00.000Z", native_unit_price: 144.34 }] });
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-08-13", rawPrice: 144.1 }, { date: "2026-08-14", rawPrice: 144.34 }] });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    const body = writeCallBodies();
    expect(body).toHaveLength(1);
    expect((body[0].price_at as string).startsWith("2026-08-13")).toBe(true);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.newRowsInserted).toBe(1);
  });

  it("writes exactly the dates the provider returned — never an invented weekend/holiday row", async () => {
    // A real trading week: Mon/Tue/Wed only, Thu/Fri deliberately absent —
    // simulates the provider genuinely having no data for those two days.
    getEodRangeMock.mockResolvedValue({
      ok: true,
      data: [{ date: "2026-01-05", rawPrice: 140 }, { date: "2026-01-06", rawPrice: 141 }, { date: "2026-01-07", rawPrice: 142 }],
    });
    await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    const body = writeCallBodies();
    expect(body.map(r => (r.price_at as string).slice(0, 10)).sort()).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
  });

  it("rejects the whole series (writes nothing) when EODHD returns an internal ~100x scale discontinuity", async () => {
    getEodRangeMock.mockResolvedValue({
      ok: true,
      data: [{ date: "2026-01-05", rawPrice: 144 }, { date: "2026-01-06", rawPrice: 14400 }],
    });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/[Ii]mplausible/);
    expect(writeCallBodies()).toHaveLength(0);
  });

  it("rejects and writes nothing on a non-finite/non-positive provider price", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-01-05", rawPrice: 0 }] });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(result.ok).toBe(false);
    expect(writeCallBodies()).toHaveLength(0);
  });

  it("rejects and writes nothing on out-of-order/duplicate provider dates", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: "2026-01-06", rawPrice: 140 }, { date: "2026-01-05", rawPrice: 139 }] });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(result.ok).toBe(false);
    expect(writeCallBodies()).toHaveLength(0);
  });

  it("refuses to guess a currency unit when provider_quote_unit is unverified, and never calls EODHD", async () => {
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow({ provider_quote_unit: null }));
    expect(result.ok).toBe(false);
    expect(getEodRangeMock).not.toHaveBeenCalled();
  });

  it("an asset with no buy transaction on record is skipped, not treated as an error", async () => {
    mockDbState({ firstBuy: null });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(result.ok).toBe(true);
    expect(getEodRangeMock).not.toHaveBeenCalled();
  });

  it("a provider-level failure (e.g. rate limit) is reported honestly without throwing, preserving existing snapshots", async () => {
    mockDbState({ existingSnapshotRows: [{ price_at: "2026-08-14T00:00:00.000Z", native_unit_price: 144.34 }] });
    getEodRangeMock.mockResolvedValue({ ok: false, error: "EODHD daily/rate limit reached.", retryable: true });
    const result = await backfillEodhdAssetHistory(OWNER_ID, eodhdAssetRow());
    expect(result.ok).toBe(false);
    expect(result.existingCountBefore).toBe(1);
    expect(writeCallBodies()).toHaveLength(0);
  });
});

describe("backfillAllEodhdHistory — one request per fund, partial failure isolation", () => {
  it("issues exactly ONE getEodRange call per EODHD-routed asset — three assets, three calls total", async () => {
    const assets = [
      eodhdAssetRow({ id: "a-vwrp", ticker: "VWRP" }),
      eodhdAssetRow({ id: "a-v3ab", ticker: "V3AB" }),
      eodhdAssetRow({ id: "a-vuag", ticker: "VUAG" }),
    ];
    mockDbState({ assets });
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: FIRST_BUY, rawPrice: 100 }] });
    const { results } = await backfillAllEodhdHistory(OWNER_ID);
    expect(getEodRangeMock).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
  });

  it("only queries pricing_provider = eodhd assets — never touches twelve_data/pokepulse rows", async () => {
    getEodRangeMock.mockResolvedValue({ ok: true, data: [{ date: FIRST_BUY, rawPrice: 140 }] });
    await backfillAllEodhdHistory(OWNER_ID);
    const assetsQuery = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("investment_assets?"))?.[0] as string;
    expect(assetsQuery).toContain("pricing_provider=eq.eodhd");
    expect(twelveDataProvider.getHistory).not.toHaveBeenCalled();
    expect(pokePulseProvider.getHistory).not.toHaveBeenCalled();
  });

  it("one fund's validation failure never blocks another fund's successful backfill in the same run", async () => {
    const assets = [eodhdAssetRow({ id: "good", ticker: "VWRP" }), eodhdAssetRow({ id: "bad", ticker: "V3AB" })];
    mockDbState({ assets });
    getEodRangeMock.mockImplementation(async (ticker: string) =>
      ticker === "VWRP"
        ? { ok: true, data: [{ date: FIRST_BUY, rawPrice: 140 }] }
        : { ok: false, error: "EODHD daily/rate limit reached.", retryable: true },
    );
    const { results } = await backfillAllEodhdHistory(OWNER_ID);
    expect(results.find(r => r.assetId === "good")?.ok).toBe(true);
    expect(results.find(r => r.assetId === "bad")?.ok).toBe(false);
  });
});
