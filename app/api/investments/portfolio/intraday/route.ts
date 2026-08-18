import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { reduceLedger, type LedgerTransaction } from "@/lib/investments/cost-basis";
import { reconstructIntradaySeries, type IntradayAssetInput } from "@/lib/investments/intraday";
import { INTRADAY_UNAVAILABLE_MESSAGE } from "@/lib/investments/chart-helpers";
import { twelveDataProvider } from "@/lib/investments/providers/twelve-data";
import { getFxRate } from "@/lib/investments/providers/fx-provider";

export const runtime = "nodejs";

type AssetRow = {
  id: string; category: string; ticker: string | null; exchange: string | null; native_currency: string; pricing_provider: string;
};
type TransactionRow = { id: string; asset_id: string | null; transaction_type: string; trade_at: string; quantity: string | null; gbp_total: string };
type SnapshotRow = { asset_id: string; native_unit_price: string; price_at: string; created_at: string; id: string };

const LEDGER_TYPE_MAP: Record<string, "buy" | "sell" | "adjustment" | null> = {
  buy: "buy", sell: "sell", adjustment: "adjustment", deposit: "buy", withdrawal: "sell", fee: null,
};

/**
 * Genuine 1D reconstruction, on demand (not backfilled/persisted — see
 * lib/investments/intraday.ts for why: this is live-session data that's
 * only meaningful for "right now", not something to accumulate forever).
 * Real Twelve Data 15-minute bars for intraday-capable stocks, the latest
 * known value held flat for everything else (PokePulse, manual, plan-
 * restricted funds) — never a fabricated intraday tick for either.
 */
export async function GET() {
  try {
    const user = await requireOwner();

    const [assetRows, transactionRows, snapshotRows] = await Promise.all([
      supabaseRequestAll<AssetRow>(`investment_assets?owner_id=eq.${user.id}&archived_at=is.null&select=id,category,ticker,exchange,native_currency,pricing_provider`),
      supabaseRequestAll<TransactionRow>(`investment_transactions?owner_id=eq.${user.id}&reversed_at=is.null&select=id,asset_id,transaction_type,trade_at,quantity,gbp_total&order=trade_at.asc`),
      // See lib/investments/price-revisions.ts — price_at,created_at,id
      // ordering is the deterministic "latest wins" key used everywhere a
      // same-day price revision needs to resolve consistently.
      supabaseRequestAll<SnapshotRow>(`investment_price_snapshots?owner_id=eq.${user.id}&select=asset_id,native_unit_price,price_at,created_at,id&order=price_at.asc,created_at.asc,id.asc`),
    ]);

    const quantityByAsset = new Map<string, number>();
    const cashLedger: LedgerTransaction[] = [];
    const ledgerByAsset = new Map<string, LedgerTransaction[]>();
    for (const row of transactionRows) {
      if (!row.asset_id) continue;
      const ledgerType = LEDGER_TYPE_MAP[row.transaction_type];
      if (!ledgerType) continue;
      const list = ledgerByAsset.get(row.asset_id) ?? [];
      list.push({ id: row.id, type: ledgerType, tradeAt: row.trade_at, quantity: row.quantity ?? 0 });
      ledgerByAsset.set(row.asset_id, list);
      const asset = assetRows.find(a => a.id === row.asset_id);
      if (asset?.category === "cash") cashLedger.push({ id: row.id, type: ledgerType, tradeAt: row.trade_at, quantity: row.quantity ?? 0, gbpTotal: row.gbp_total });
    }
    for (const [assetId, ledger] of ledgerByAsset) quantityByAsset.set(assetId, reduceLedger(ledger).state.quantity.toNumber());

    const latestNativePriceByAsset = new Map<string, number>();
    for (const row of snapshotRows) latestNativePriceByAsset.set(row.asset_id, Number(row.native_unit_price));

    const todayIso = new Date().toISOString().slice(0, 10);
    const fxRateByCurrency = new Map<string, number>();
    async function fxRateFor(currency: string): Promise<number> {
      if (currency === "GBP") return 1;
      if (fxRateByCurrency.has(currency)) return fxRateByCurrency.get(currency)!;
      const { rate } = await getFxRate(currency, todayIso);
      fxRateByCurrency.set(currency, rate);
      return rate;
    }

    const priceableAssets = assetRows.filter(a => a.category !== "cash" && (quantityByAsset.get(a.id) ?? 0) > 0);

    const assetInputs: IntradayAssetInput[] = await Promise.all(priceableAssets.map(async (asset): Promise<IntradayAssetInput> => {
      const quantity = quantityByAsset.get(asset.id) ?? 0;
      const fxRateToday = await fxRateFor(asset.native_currency);

      if (asset.pricing_provider === "twelve_data" && asset.ticker && twelveDataProvider.isConfigured()) {
        const result = await twelveDataProvider.getIntradaySeries(asset.ticker, asset.exchange);
        if (result.ok && result.data.length > 0) {
          // A fixed bar COUNT (outputsize), not a date range, can genuinely
          // span more than one session (yesterday's closing bars plus
          // today's, if today hasn't produced enough bars yet on its own)
          // — confirmed live (a real two-session dip-recover-dip-recover
          // shape, not a single day's movement). Keep only the LATEST
          // calendar date present, per asset, in its own exchange-local
          // time — "1D" must mean one real session, never two concatenated.
          const latestDate = result.data[result.data.length - 1].timestamp.slice(0, 10);
          const todayOnly = result.data.filter(p => p.timestamp.slice(0, 10) === latestDate);
          return { assetId: asset.id, quantity, fxRateToday, kind: "intraday", points: todayOnly };
        }
      }
      // Not intraday-capable (PokePulse, manual, no ticker) or the intraday
      // call itself failed (e.g. plan-restricted, market closed with no
      // recent bars) — held flat at the latest genuine snapshot instead of
      // being silently dropped from the 1D total.
      return { assetId: asset.id, quantity, fxRateToday, kind: "constant", nativeUnitPrice: latestNativePriceByAsset.get(asset.id) ?? null };
    }));

    const cashGbp = reduceLedger(cashLedger).state.costBasisGbp.toNumber();
    const points = reconstructIntradaySeries(assetInputs, cashGbp);

    const anyGenuineIntraday = assetInputs.some(a => a.kind === "intraday");
    if (!anyGenuineIntraday || points.length === 0) {
      return NextResponse.json({ available: false, reason: INTRADAY_UNAVAILABLE_MESSAGE, points: [] });
    }

    return NextResponse.json({ available: true, reason: null, points });
  } catch (error) { return safeApiError(error, "Could not load intraday portfolio history."); }
}
