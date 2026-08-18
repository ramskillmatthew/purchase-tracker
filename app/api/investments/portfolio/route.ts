import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { computePortfolio, computeTodaysChange, type AssetForPortfolio } from "@/lib/investments/portfolio-view";
import { deriveFallbackPrice } from "@/lib/investments/holding-aggregate";
import { reconstructPortfolioValue, type AssetHistoryInput, type AssetHistoryPoint } from "@/lib/investments/reconstruction";
import { deriveCashFlowEvents } from "@/lib/investments/chart-helpers";
import { collapseToLatestPerObservation } from "@/lib/investments/price-revisions";
import type { AssetTransactionInput } from "@/lib/investments/holding-aggregate";

export const runtime = "nodejs";

type AccountRow = { id: string; name: string; account_type: string };
type AssetRow = { id: string; category: string; display_name: string; ticker: string | null; native_currency: string; pricing_provider: string; image_url: string | null; source_url: string | null; archived_at: string | null };
type TransactionRow = {
  id: string; account_id: string; asset_id: string | null; transaction_type: string; trade_at: string;
  quantity: string | null; native_unit_price: string | null; fx_rate_at_trade: string | null; gbp_total: string; gbp_fees: string;
};
type SnapshotRow = { asset_id: string; id: string; native_unit_price: string; fx_rate: string | null; price_at: string; created_at: string; data_quality: string; provider: string };

// investment_transactions' own transaction_type values that feed the
// weighted-average cost-basis ledger, mapped onto cost-basis.ts's smaller
// "buy"/"sell"/"adjustment" vocabulary — deposit/withdrawal only ever
// apply to a 'cash' category asset, where they behave exactly like a
// buy/sell of the cash "unit" itself (native_unit_price is always 1 for
// cash). A standalone 'fee' transaction is never quantity-bearing and is
// deliberately excluded from every holding's ledger.
const LEDGER_TYPE_MAP: Record<string, "buy" | "sell" | "adjustment" | null> = {
  buy: "buy", sell: "sell", adjustment: "adjustment", deposit: "buy", withdrawal: "sell", fee: null,
};

/**
 * The Investments dashboard's ONE data source — every total, holding row,
 * allocation slice, and chart point the UI shows comes from this single
 * response, computed via lib/investments/portfolio-view.ts +
 * reconstruction.ts (never recomputed independently by a component).
 */
export async function GET() {
  try {
    const user = await requireOwner();

    const [accountRows, assetRows, transactionRows, snapshotRows] = await Promise.all([
      supabaseRequestAll<AccountRow>(`investment_accounts?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,account_type&order=created_at.asc`),
      // Deliberately NOT archived_at=is.null (see 2026-08-17 forensic
      // audit). `archived_at` means "hide from current-facing pickers/
      // lists" ONLY — it is not a safe proxy for "this asset never counted
      // financially." A genuinely sold-and-closed holding (real,
      // non-reversed transactions, now zero quantity) MUST still
      // contribute to chartSeries/cashFlowEvents for the real dates it was
      // held, or its entire purchase-then-sale history vanishes from
      // Estimated return. Excluding it here previously did that
      // unconditionally for EVERY archived asset, not just erroneous ones.
      // Zero-quantity exclusion from the CURRENT portfolio total/holdings
      // list already happens correctly and automatically downstream (see
      // computePortfolio's `if (holding.quantity.lte(0)) continue`, and
      // reconstructPortfolioValue's identical per-date qty check) — no
      // separate archived_at filter is needed to keep a sold-out position
      // out of "what you currently hold". An asset that should NEVER have
      // counted at all (an erroneous duplicate, e.g. a same-session
      // price-entry correction) is excluded via `reversed_at` on its own
      // transaction — the ledger's existing, audited mechanism for "this
      // specific transaction never happened" — not by archiving the asset.
      supabaseRequestAll<AssetRow>(`investment_assets?owner_id=eq.${user.id}&select=id,category,display_name,ticker,native_currency,pricing_provider,image_url,source_url,archived_at`),
      supabaseRequestAll<TransactionRow>(`investment_transactions?owner_id=eq.${user.id}&reversed_at=is.null&select=id,account_id,asset_id,transaction_type,trade_at,quantity,native_unit_price,fx_rate_at_trade,gbp_total,gbp_fees&order=trade_at.asc`),
      // Ordered by price_at, then created_at, then id — the same
      // deterministic three-key ordering used everywhere a "latest
      // snapshot" is selected (see lib/investments/price-revisions.ts):
      // among same-day revisions (see supabase-investments.sql's own
      // comment on the dedup index this depends on), the most recently
      // RETRIEVED one sorts last, so `snapshots[snapshots.length-1]` below
      // is never an earlier, since-superseded revision.
      supabaseRequestAll<SnapshotRow>(`investment_price_snapshots?owner_id=eq.${user.id}&select=asset_id,id,native_unit_price,fx_rate,price_at,created_at,data_quality,provider&order=price_at.asc,created_at.asc,id.asc`),
    ]);

    const transactionsByAsset = new Map<string, AssetTransactionInput[]>();
    const accountIdByAsset = new Map<string, string>(); // first account an asset's transactions were recorded under — see this route's own account-rollup note below
    for (const row of transactionRows) {
      if (!row.asset_id) continue;
      const ledgerType = LEDGER_TYPE_MAP[row.transaction_type];
      if (!ledgerType) continue;
      const list = transactionsByAsset.get(row.asset_id) ?? [];
      list.push({
        id: row.id, type: ledgerType, tradeAt: row.trade_at, quantity: row.quantity ?? 0,
        gbpTotal: Number(row.gbp_total), gbpFees: Number(row.gbp_fees),
        nativeUnitPrice: row.native_unit_price !== null ? Number(row.native_unit_price) : null,
        fxRateAtTrade: row.fx_rate_at_trade !== null ? Number(row.fx_rate_at_trade) : null,
      });
      transactionsByAsset.set(row.asset_id, list);
      if (!accountIdByAsset.has(row.asset_id)) accountIdByAsset.set(row.asset_id, row.account_id);
    }

    const snapshotsByAsset = new Map<string, SnapshotRow[]>();
    for (const row of snapshotRows) {
      const list = snapshotsByAsset.get(row.asset_id) ?? [];
      list.push(row);
      snapshotsByAsset.set(row.asset_id, list);
    }

    const portfolioAssets: AssetForPortfolio[] = [];
    const historyAssets: AssetHistoryInput[] = [];
    const priceMeta = new Map<string, { priceAt: string | null; provider: string | null; dataQuality: string | null }>();
    // Up to the 10 most recent GBP unit prices per asset — a compact,
    // genuinely-observed trend for the holdings table's sparkline (never a
    // fabricated shape); a stock/Pokémon asset with fewer than 2 real
    // snapshots simply renders no sparkline.
    const sparklineByAsset = new Map<string, number[]>();

    for (const asset of assetRows) {
      const transactions = transactionsByAsset.get(asset.id) ?? [];
      const snapshots = snapshotsByAsset.get(asset.id) ?? [];
      const latest = snapshots[snapshots.length - 1] ?? null;

      const firstBuy = transactions.find(t => t.type === "buy");
      const { fallbackNativePrice, fallbackFxRate } = deriveFallbackPrice(firstBuy, asset.native_currency);

      portfolioAssets.push({
        id: asset.id, category: asset.category as AssetForPortfolio["category"], displayName: asset.display_name, ticker: asset.ticker,
        transactions, currentNativePrice: latest ? Number(latest.native_unit_price) : fallbackNativePrice,
        currentFxRate: latest ? Number(latest.fx_rate ?? 1) : (fallbackFxRate ?? 1),
        archived: Boolean(asset.archived_at),
      });
      priceMeta.set(asset.id, { priceAt: latest?.price_at ?? null, provider: latest?.provider ?? asset.pricing_provider, dataQuality: latest?.data_quality ?? (fallbackNativePrice !== null ? "purchase_price_fallback" : null) });

      // Collapsed to ONE row per (provider, price_at) BEFORE building the
      // chart/sparkline series — a same-day revision (see
      // lib/investments/price-revisions.ts) must never draw as two points
      // at the same X-coordinate or push a genuinely distinct earlier day
      // out of the sparkline's last-10 window.
      const collapsedSnapshots = collapseToLatestPerObservation(
        snapshots.map(s => ({ provider: s.provider, priceAt: s.price_at, createdAt: s.created_at, id: s.id, source: s })),
      ).map(r => r.source);

      sparklineByAsset.set(asset.id, collapsedSnapshots.slice(-10).map(s => Number(s.native_unit_price) * Number(s.fx_rate ?? 1)));

      const historyPoints: AssetHistoryPoint[] = collapsedSnapshots.map(s => ({
        date: s.price_at.slice(0, 10), nativeUnitPrice: Number(s.native_unit_price), fxRate: Number(s.fx_rate ?? 1),
        dataQuality: s.data_quality as AssetHistoryPoint["dataQuality"],
      }));
      historyAssets.push({ assetId: asset.id, transactions, priceHistory: historyPoints, fallbackNativePrice, fallbackFxRate });
    }

    const portfolio = computePortfolio(portfolioAssets);

    // Today's change — computed PER ASSET from each one's own real (never
    // fallback) price history, isolated from cash-flow distortion. Cash is
    // excluded (no price concept at all); a brand-new holding or an asset
    // priced for the first time today naturally contributes nothing until
    // it has two genuine price points to compare — see computeTodaysChange's
    // own comment for exactly why the old whole-portfolio-diff approach was
    // wrong (it counted new purchases as a market "gain").
    const quantityByAsset = new Map(portfolio.holdings.map(h => [h.assetId, h.quantity]));
    const todaysChangeInputs = historyAssets
      .filter(a => assetRows.find(row => row.id === a.assetId)?.category !== "cash")
      .map(a => {
        const realPoints = a.priceHistory.filter(p => p.dataQuality !== "purchase_price_fallback");
        const latest = realPoints.at(-1) ?? null;
        const previous = realPoints.length > 1 ? realPoints[realPoints.length - 2] : null;
        return {
          currentQuantity: quantityByAsset.get(a.assetId) ?? 0,
          latestReal: latest ? { nativePrice: latest.nativeUnitPrice, fxRate: latest.fxRate } : null,
          previousReal: previous ? { nativePrice: previous.nativeUnitPrice, fxRate: previous.fxRate } : null,
        };
      });
    const { todaysChangeGbp, todaysChangePercent } = computeTodaysChange(todaysChangeInputs);

    const fullSeries = reconstructPortfolioValue(historyAssets);

    // Cash-flow events for the "Portfolio value" chart's transaction
    // markers/tooltips — buy=contribution, sell=withdrawal, keyed by real
    // trade date (never a synthetic date). Previously also fed a separate
    // time-weighted "Estimated return" chart mode, removed at the user's
    // explicit request (see PortfolioHeroCard.tsx's own comment) — this is
    // now purely a chart-marker data source. Cash-category
    // assets are excluded: a cash deposit/withdrawal isn't a portfolio-
    // level external flow, it's a transfer WITHIN the portfolio (the cash
    // balance itself is already part of totalGbpValue).
    //
    // HISTORY (2026-08-17, two audits): a first pass here excluded every
    // ARCHIVED asset's transactions, matching `assetRows` then being
    // archived_at-filtered — this correctly fixed an erroneous-duplicate
    // NVDA/APP/Prismatic-Evolutions trio inflating "Net contributions" by
    // £888.44 with no matching value anywhere in the series. A later,
    // deeper forensic audit found that "fix" was not generically safe: it
    // silently deleted a LEGITIMATELY sold-and-archived holding's entire
    // cash-flow history too, not just erroneous duplicates. `assetRows` no
    // longer filters by archived_at at all (see this route's own comment
    // on that fetch) — `found(...)` now resolves for every real asset,
    // archived or not, so every real (non-reversed) buy/sell counts here
    // exactly once, whether or not its asset is later archived. The
    // erroneous-duplicate case is excluded at the SOURCE instead: its own
    // transaction should carry `reversed_at`, which the transactionRows
    // query above already filters out (`reversed_at=is.null`) before this
    // code ever runs.
    const found = (assetId: string) => assetRows.find(a => a.id === assetId);
    const cashFlowEvents = deriveCashFlowEvents(
      transactionRows
        .filter(row => row.asset_id && (row.transaction_type === "buy" || row.transaction_type === "sell"))
        .filter(row => found(row.asset_id!) !== undefined && found(row.asset_id!)!.category !== "cash")
        .map(row => ({
          date: row.trade_at.slice(0, 10), type: row.transaction_type as "buy" | "sell", amountGbp: Number(row.gbp_total),
          assetName: found(row.asset_id!)!.display_name,
        })),
    );

    // Bottom "collection card" rollups — one per real account. An asset is
    // attributed to the account its FIRST transaction was recorded under;
    // splitting one asset's value across multiple accounts is not
    // supported in this version (a documented simplification — a personal
    // holding is realistically bought within one account).
    const accounts = accountRows.map(account => {
      const assetsInAccount = portfolioAssets.filter(a => accountIdByAsset.get(a.id) === account.id);
      const holdingRows = portfolio.holdings.filter(h => assetsInAccount.some(a => a.id === h.assetId));
      const gbpValue = holdingRows.reduce((sum, h) => sum + h.currentGbpValue, 0);
      const costBasis = holdingRows.reduce((sum, h) => sum + h.costBasisGbp, 0);
      const returnGbp = Math.round((gbpValue - costBasis) * 100) / 100;
      const returnPercent = costBasis > 0 ? Math.round((returnGbp / costBasis) * 1000) / 10 : null;
      // Cash has no price concept at all and is excluded; stock/PokePulse
      // (automated) and LEGO (manual valuation) all have a genuine "last
      // synced" timestamp, but only automated providers count as "live".
      // Also requires a currently-held (qty > 0) position — assetRows is no
      // longer archived_at-filtered (see this route's own comment above),
      // so a sold-out or erroneous-duplicate asset with real historical
      // transactions must not resurrect a stale "last synced"/"all live"
      // badge on an account that no longer actually holds it.
      const priceableAssetIds = new Set(
        assetRows
          .filter(a => accountIdByAsset.get(a.id) === account.id && a.pricing_provider !== "none" && Number(quantityByAsset.get(a.id) ?? 0) > 0)
          .map(a => a.id),
      );
      const metas = [...priceableAssetIds].map(id => priceMeta.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
      const lastSyncedAt = metas.map(m => m.priceAt).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
      const allLive = metas.length > 0 && metas.every(m => m.dataQuality === "market");
      return {
        id: account.id, name: account.name, accountType: account.account_type, gbpValue: Math.round(gbpValue * 100) / 100, returnGbp, returnPercent,
        lastSyncedAt, allLive, hasPriceableAssets: priceableAssetIds.size > 0,
      };
    });

    const holdingsWithMeta = portfolio.holdings.map(h => {
      const asset = assetRows.find(a => a.id === h.assetId)!;
      const meta = priceMeta.get(h.assetId);
      return {
        ...h, nativeCurrency: asset.native_currency, pricingProvider: asset.pricing_provider,
        imageUrl: asset.image_url, sourceUrl: asset.source_url,
        currentNativePrice: portfolioAssets.find(a => a.id === h.assetId)?.currentNativePrice ?? null,
        priceAt: meta?.priceAt ?? null, dataQuality: meta?.dataQuality ?? null,
        sparkline: sparklineByAsset.get(h.assetId) ?? [],
      };
    });

    return NextResponse.json({
      totals: {
        totalGbpValue: portfolio.totalGbpValue, totalInvestedGbp: portfolio.totalInvestedGbp,
        allTimeReturnGbp: portfolio.allTimeReturnGbp, allTimeReturnPercent: portfolio.allTimeReturnPercent,
        marketGrowthGbp: portfolio.marketGrowthGbp, currencyEffectGbp: portfolio.currencyEffectGbp,
        cashGbp: portfolio.cashGbp, todaysChangeGbp, todaysChangePercent,
      },
      bestPerformer: portfolio.bestPerformer,
      allocation: portfolio.allocation,
      holdings: holdingsWithMeta,
      accounts,
      chartSeries: fullSeries,
      cashFlowEvents,
      fallbackHoldingsCount: holdingsWithMeta.filter(h => h.dataQuality === "purchase_price_fallback").length,
    });
  } catch (error) { return safeApiError(error, "Could not load your portfolio."); }
}
