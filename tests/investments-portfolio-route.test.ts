import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));

import { GET as getPortfolio } from "@/app/api/investments/portfolio/route";

const OWNER_ID = "owner-1";
const ASSET_ID = "chaos-rising";

beforeEach(() => {
  requireOwner.mockClear();
  requireOwner.mockResolvedValue({ id: OWNER_ID, email: "owner@example.com" });
  supabaseRequestAll.mockReset();
});

function mockData(snapshotRows: Array<Record<string, unknown>>) {
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("investment_accounts?")) return [{ id: "acc-1", name: "Main", account_type: "isa" }];
    if (path.startsWith("investment_assets?")) return [{
      id: ASSET_ID, category: "pokemon", display_name: "Chaos Rising Elite Trainer Box", ticker: null,
      native_currency: "GBP", pricing_provider: "pokepulse", image_url: null, source_url: null, archived_at: null,
    }];
    if (path.startsWith("investment_transactions?")) return [{
      id: "tx-1", account_id: "acc-1", asset_id: ASSET_ID, transaction_type: "buy", trade_at: "2026-08-01T00:00:00.000Z",
      quantity: "1", native_unit_price: "60", fx_rate_at_trade: "1", gbp_total: "60", gbp_fees: "0",
    }];
    if (path.startsWith("investment_price_snapshots?")) return snapshotRows;
    return [];
  });
}

describe("GET /api/investments/portfolio — same-day revision collapse (chart + sparkline)", () => {
  it("REGRESSION: three same-day revisions for one asset collapse to ONE chart point and ONE sparkline entry — never drawn as duplicate/zig-zag points at the same date", async () => {
    mockData([
      { asset_id: ASSET_ID, id: "s1", native_unit_price: "69.64", gbp_unit_price: "69.64", fx_rate: "1", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T07:57:00.000Z", data_quality: "market", provider: "pokepulse" },
      { asset_id: ASSET_ID, id: "s2", native_unit_price: "70.31", gbp_unit_price: "70.31", fx_rate: "1", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T12:57:00.000Z", data_quality: "market", provider: "pokepulse" },
      { asset_id: ASSET_ID, id: "s3", native_unit_price: "67.52", gbp_unit_price: "67.52", fx_rate: "1", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T13:39:00.000Z", data_quality: "market", provider: "pokepulse" },
    ]);
    const response = await getPortfolio();
    const body = await response.json();

    // Exactly one chart point for this date (never three, never a
    // zig-zag) — the whole portfolio's chartSeries is one row per
    // DISTINCT date, so this also proves the underlying per-asset history
    // feeding reconstruction was collapsed before reconstruction ever ran.
    const pointsOnThatDate = body.chartSeries.filter((p: { date: string }) => p.date === "2026-08-17");
    expect(pointsOnThatDate).toHaveLength(1);
    expect(pointsOnThatDate[0].totalGbpValue).toBeCloseTo(67.52); // qty 1 * latest accepted revision

    // Sparkline reflects the collapsed series (one value, not three).
    const holding = body.holdings.find((h: { assetId: string }) => h.assetId === ASSET_ID);
    expect(holding.sparkline).toEqual([67.52]);

    // Current holding value uses the latest accepted revision.
    expect(holding.currentNativePrice).toBe(67.52);
    expect(holding.priceAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("distinct-day snapshots are never collapsed together — a genuine multi-day history stays intact in both chart and sparkline", async () => {
    mockData([
      { asset_id: ASSET_ID, id: "s1", native_unit_price: "60", gbp_unit_price: "60", fx_rate: "1", price_at: "2026-08-15T00:00:00.000Z", created_at: "2026-08-15T09:00:00.000Z", data_quality: "market", provider: "pokepulse" },
      { asset_id: ASSET_ID, id: "s2", native_unit_price: "62", gbp_unit_price: "62", fx_rate: "1", price_at: "2026-08-16T00:00:00.000Z", created_at: "2026-08-16T09:00:00.000Z", data_quality: "market", provider: "pokepulse" },
      { asset_id: ASSET_ID, id: "s3", native_unit_price: "65", gbp_unit_price: "65", fx_rate: "1", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T09:00:00.000Z", data_quality: "market", provider: "pokepulse" },
    ]);
    const response = await getPortfolio();
    const body = await response.json();
    const dates = body.chartSeries.map((p: { date: string }) => p.date);
    expect(dates).toEqual(["2026-08-01", "2026-08-15", "2026-08-16", "2026-08-17"]); // 08-01 is the buy transaction date
    const holding = body.holdings.find((h: { assetId: string }) => h.assetId === ASSET_ID);
    expect(holding.sparkline).toEqual([60, 62, 65]);
  });
});

describe("GET /api/investments/portfolio — generic archived-asset inclusion rule (2026-08-17 forensic audit)", () => {
  const SOLD_ASSET_ID = "sold-holding";
  const DUPLICATE_ASSET_ID = "erroneous-duplicate";

  it("REGRESSION: a genuine holding — bought, held across several dates, fully sold, then archived — keeps its historical value/return for the dates it was held, while disappearing from current holdings and totals", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_accounts?")) return [{ id: "acc-1", name: "Main", account_type: "isa" }];
      if (path.startsWith("investment_assets?")) return [{
        // archived_at is populated (a real, closed position) — the route
        // no longer filters this out at the query level, so this row must
        // still come back for the test to be meaningful.
        id: SOLD_ASSET_ID, category: "stock", display_name: "Closed Co", ticker: "CLSD",
        native_currency: "GBP", pricing_provider: "twelve_data", image_url: null, source_url: null, archived_at: "2026-01-11T00:00:00.000Z",
      }];
      if (path.startsWith("investment_transactions?")) return [
        { id: "buy-1", account_id: "acc-1", asset_id: SOLD_ASSET_ID, transaction_type: "buy", trade_at: "2026-01-01T00:00:00.000Z", quantity: "10", native_unit_price: "10", fx_rate_at_trade: "1", gbp_total: "100", gbp_fees: "0" },
        { id: "sell-1", account_id: "acc-1", asset_id: SOLD_ASSET_ID, transaction_type: "sell", trade_at: "2026-01-10T00:00:00.000Z", quantity: "10", native_unit_price: "15", fx_rate_at_trade: "1", gbp_total: "150", gbp_fees: "0" },
      ];
      if (path.startsWith("investment_price_snapshots?")) return [
        { asset_id: SOLD_ASSET_ID, id: "s1", native_unit_price: "12", gbp_unit_price: "12", fx_rate: "1", price_at: "2026-01-05T00:00:00.000Z", created_at: "2026-01-05T09:00:00.000Z", data_quality: "market", provider: "twelve_data" },
      ];
      return [];
    });

    const response = await getPortfolio();
    const body = await response.json();

    // Historical value on a date it was genuinely held (before the sale) is present, using the real snapshot.
    const heldPoint = body.chartSeries.find((p: { date: string }) => p.date === "2026-01-05");
    expect(heldPoint?.totalGbpValue).toBeCloseTo(120); // 10 units x £12

    // The genuine buy AND sell both appear as real cash-flow events for their real dates — a sale must count as a real (negative) flow, not vanish.
    const buyEvent = body.cashFlowEvents.find((e: { date: string }) => e.date === "2026-01-01");
    const sellEvent = body.cashFlowEvents.find((e: { date: string }) => e.date === "2026-01-10");
    expect(buyEvent?.amountGbp).toBeCloseTo(100);
    expect(sellEvent?.amountGbp).toBeCloseTo(-150);

    // Current state: zero quantity, absent from the active holdings list and every current total — computePortfolio's own zero-quantity exclusion, unchanged, does this automatically.
    expect(body.holdings.find((h: { assetId: string }) => h.assetId === SOLD_ASSET_ID)).toBeUndefined();
    expect(body.totals.totalGbpValue).toBe(0);
  });

  it("an erroneous duplicate transaction (reversed_at set) never counts — neither in historical value nor in cash flows — proving exclusion now happens via the ledger's reversal mechanism, not asset archival", async () => {
    // reversed_at=is.null is already applied server-side in the real
    // Supabase query string; this mock simulates that filtering by simply
    // never returning the reversed transaction at all — exactly what the
    // real filtered query would do.
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_accounts?")) return [{ id: "acc-1", name: "Main", account_type: "isa" }];
      if (path.startsWith("investment_assets?")) return [{
        id: DUPLICATE_ASSET_ID, category: "stock", display_name: "Erroneous Duplicate Co", ticker: "DUPE",
        native_currency: "GBP", pricing_provider: "twelve_data", image_url: null, source_url: null, archived_at: "2026-01-11T00:00:00.000Z",
      }];
      if (path.startsWith("investment_transactions?")) return []; // the one real transaction for this asset was reversed, so the reversed_at=is.null-filtered query returns nothing for it
      if (path.startsWith("investment_price_snapshots?")) return [];
      return [];
    });

    const response = await getPortfolio();
    const body = await response.json();

    expect(body.chartSeries.some((p: { totalGbpValue: number }) => p.totalGbpValue > 0)).toBe(false);
    expect(body.cashFlowEvents).toHaveLength(0);
    expect(body.holdings.find((h: { assetId: string }) => h.assetId === DUPLICATE_ASSET_ID)).toBeUndefined();
  });

  it("REGRESSION (confirmed live, same-day): an ARCHIVED duplicate whose transaction has NOT yet been reversed — a real, non-zero quantity, exactly the live NVDA/APP shape — must never double-count into current totals/holdings just because assetRows is no longer archived_at-filtered", async () => {
    const ACTIVE_ID = "nvda-active", ARCHIVED_DUPE_ID = "nvda-archived-dupe";
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_accounts?")) return [{ id: "acc-1", name: "Main", account_type: "isa" }];
      if (path.startsWith("investment_assets?")) return [
        { id: ACTIVE_ID, category: "stock", display_name: "Nvidia", ticker: "NVDA", native_currency: "GBP", pricing_provider: "twelve_data", image_url: null, source_url: null, archived_at: null },
        { id: ARCHIVED_DUPE_ID, category: "stock", display_name: "Nvidia", ticker: "NVDA", native_currency: "GBP", pricing_provider: "twelve_data", image_url: null, source_url: null, archived_at: "2026-01-01T00:00:01.000Z" },
      ];
      if (path.startsWith("investment_transactions?")) return [
        { id: "buy-active", account_id: "acc-1", asset_id: ACTIVE_ID, transaction_type: "buy", trade_at: "2026-01-01T00:00:00.000Z", quantity: "3", native_unit_price: "100", fx_rate_at_trade: "1", gbp_total: "300", gbp_fees: "0" },
        // The erroneous duplicate's transaction is deliberately NOT reversed here — this is the exact, currently-real state of the live NVDA duplicate (archived, but its own buy transaction still on record, unreversed).
        { id: "buy-dupe", account_id: "acc-1", asset_id: ARCHIVED_DUPE_ID, transaction_type: "buy", trade_at: "2026-01-01T00:00:00.000Z", quantity: "3", native_unit_price: "130", fx_rate_at_trade: "1", gbp_total: "390", gbp_fees: "0" },
      ];
      if (path.startsWith("investment_price_snapshots?")) return [
        { asset_id: ACTIVE_ID, id: "s1", native_unit_price: "150", gbp_unit_price: "150", fx_rate: "1", price_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T09:00:00.000Z", data_quality: "market", provider: "twelve_data" },
        { asset_id: ARCHIVED_DUPE_ID, id: "s2", native_unit_price: "150", gbp_unit_price: "150", fx_rate: "1", price_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T09:00:00.000Z", data_quality: "market", provider: "twelve_data" },
      ];
      return [];
    });

    const response = await getPortfolio();
    const body = await response.json();

    // Exactly ONE NVDA holding in current totals — never two.
    const nvdaHoldings = body.holdings.filter((h: { ticker: string }) => h.ticker === "NVDA");
    expect(nvdaHoldings).toHaveLength(1);
    expect(nvdaHoldings[0].assetId).toBe(ACTIVE_ID);
    expect(body.totals.totalGbpValue).toBeCloseTo(450); // 3 x £150 — the ACTIVE row only, not doubled to £900
  });

  it("REGRESSION (real correction, 2026-08-18, approved not-yet-applied): once NVDA's duplicate is reversed and its native_unit_price/fx_rate_at_trade corrected, cashFlowEvents carries the single, correct £499.24 flow — never the pre-correction duplicated £1,153.45 (£654.21 archived + £499.24 active) — and the corrected fx_rate_at_trade is never used by valuation math (only display), so totalGbpValue is unaffected by the native-price correction itself", async () => {
    const NVDA_ID = "nvda-real-corrected";
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_accounts?")) return [{ id: "acc-1", name: "Main", account_type: "isa" }];
      if (path.startsWith("investment_assets?")) return [
        { id: NVDA_ID, category: "stock", display_name: "Nvidia", ticker: "NVDA", native_currency: "USD", pricing_provider: "twelve_data", image_url: null, source_url: null, archived_at: null },
      ];
      if (path.startsWith("investment_transactions?")) return [
        // Corrected values exactly as approved: gbp_total/quantity/trade_at/gbp_fees UNCHANGED; only native_unit_price + fx_rate_at_trade corrected. The duplicate archived transaction (76f38e33…) is reversed_at-filtered out by the real query and simply never appears here.
        { id: "25fa8f63-7f1f-4b21-90d8-e148d2829be6", account_id: "acc-1", asset_id: NVDA_ID, transaction_type: "buy", trade_at: "2025-11-06T00:00:00.000Z", quantity: "3.45064199", native_unit_price: "189.59", fx_rate_at_trade: "0.7631221250", gbp_total: "499.24", gbp_fees: "0" },
      ];
      if (path.startsWith("investment_price_snapshots?")) return [
        { asset_id: NVDA_ID, id: "s1", native_unit_price: "225.05", gbp_unit_price: "166.30", fx_rate: "0.73874", price_at: "2026-08-17T00:00:00.000Z", created_at: "2026-08-17T09:00:00.000Z", data_quality: "market", provider: "twelve_data" },
      ];
      return [];
    });

    const response = await getPortfolio();
    const body = await response.json();

    const nov6Event = body.cashFlowEvents.find((e: { date: string }) => e.date === "2025-11-06");
    expect(nov6Event?.amountGbp).toBeCloseTo(499.24); // single, correct flow — not 1,153.45
    expect(nov6Event?.count).toBe(1);

    const holding = body.holdings.find((h: { assetId: string }) => h.assetId === NVDA_ID);
    // Valuation uses the SNAPSHOT (225.05 x 0.73874), never the transaction's native_unit_price — the correction is a display/reference fix only.
    expect(holding.currentGbpValue).toBeCloseTo(3.45064199 * 225.05 * 0.73874, 1);
  });
});
