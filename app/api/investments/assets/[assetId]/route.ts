import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { reduceLedger, type LedgerTransaction } from "@/lib/investments/cost-basis";
import { computeHolding, deriveFallbackPrice, type AssetTransactionInput } from "@/lib/investments/holding-aggregate";
import { collapseToLatestPerObservation } from "@/lib/investments/price-revisions";

export const runtime = "nodejs";

const updateAssetSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  archived: z.boolean().optional(),
}).strict();

type TransactionRow = { id: string; transaction_type: string; trade_at: string; quantity: string | null };
type FullTransactionRow = {
  id: string; account_id: string; transaction_type: string; trade_at: string; quantity: string | null;
  native_unit_price: string | null; native_currency: string; gbp_total: string; fx_rate_at_trade: string | null; gbp_fees: string; notes: string | null;
};
type FullAssetRow = {
  id: string; category: string; display_name: string; ticker: string | null; exchange: string | null; native_currency: string;
  pricing_provider: string; source_url: string | null; image_url: string | null; lego_set_number: string | null; archived_at: string | null;
};
type SnapshotRow = { id: string; native_unit_price: string; gbp_unit_price: string; fx_rate: string | null; price_at: string; created_at: string; provider: string; data_quality: string };

const LEDGER_TYPE_MAP: Record<string, "buy" | "sell" | "adjustment" | null> = {
  buy: "buy", sell: "sell", adjustment: "adjustment", deposit: "buy", withdrawal: "sell", fee: null,
};

/**
 * Holding detail — current position, price history, and full transaction
 * history for ONE investment, backing the dashboard's row-click drawer.
 * Reuses the exact same holding-aggregate.ts computation the portfolio
 * view-model uses, so a holding's detail figures can never disagree with
 * what the dashboard already showed for it.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const user = await requireOwner();
    const { assetId } = await params;
    if (!uuidSchema.safeParse(assetId).success) return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });

    const assets = await supabaseRequestAll<FullAssetRow>(
      `investment_assets?id=eq.${assetId}&owner_id=eq.${user.id}&select=id,category,display_name,ticker,exchange,native_currency,pricing_provider,source_url,image_url,lego_set_number,archived_at`,
    );
    const asset = assets[0];
    if (!asset) return NextResponse.json({ error: "Investment not found." }, { status: 404 });

    const [transactionRows, snapshotRows] = await Promise.all([
      supabaseRequestAll<FullTransactionRow>(`investment_transactions?asset_id=eq.${assetId}&owner_id=eq.${user.id}&reversed_at=is.null&select=id,account_id,transaction_type,trade_at,quantity,native_unit_price,native_currency,gbp_total,fx_rate_at_trade,gbp_fees,notes&order=trade_at.asc`),
      // See lib/investments/price-revisions.ts — deterministic ordering so
      // a same-day revision's true latest wins, and priceHistory below can
      // be collapsed to one point per observation for the drawer's chart.
      supabaseRequestAll<SnapshotRow>(`investment_price_snapshots?asset_id=eq.${assetId}&owner_id=eq.${user.id}&select=id,native_unit_price,gbp_unit_price,fx_rate,price_at,created_at,provider,data_quality&order=price_at.asc,created_at.asc,id.asc`),
    ]);

    const ledgerInputs: AssetTransactionInput[] = transactionRows
      .filter(t => LEDGER_TYPE_MAP[t.transaction_type] !== null)
      .map(t => ({
        id: t.id, type: LEDGER_TYPE_MAP[t.transaction_type]!, tradeAt: t.trade_at, quantity: t.quantity ?? 0,
        gbpTotal: Number(t.gbp_total), gbpFees: Number(t.gbp_fees),
        nativeUnitPrice: t.native_unit_price !== null ? Number(t.native_unit_price) : null,
        fxRateAtTrade: t.fx_rate_at_trade !== null ? Number(t.fx_rate_at_trade) : null,
      }));

    const latestSnapshot = snapshotRows[snapshotRows.length - 1] ?? null;
    const firstBuy = ledgerInputs.find(t => t.type === "buy");
    // See lib/investments/holding-aggregate.ts's deriveFallbackPrice — never
    // trusts the frequently-null fx_rate_at_trade directly; a non-GBP asset
    // with no genuine snapshot yet must derive its fallback rate from real
    // recorded amounts, never silently assume 1:1.
    const { fallbackNativePrice, fallbackFxRate } = deriveFallbackPrice(firstBuy, asset.native_currency);
    const currentNativePrice = latestSnapshot ? Number(latestSnapshot.native_unit_price) : (fallbackNativePrice ?? 0);
    const currentFxRate = latestSnapshot ? Number(latestSnapshot.fx_rate ?? 1) : (fallbackFxRate ?? 1);

    const holding = computeHolding(ledgerInputs, currentNativePrice, currentFxRate);

    return NextResponse.json({
      asset: {
        id: asset.id, category: asset.category, displayName: asset.display_name, ticker: asset.ticker, exchange: asset.exchange,
        nativeCurrency: asset.native_currency, pricingProvider: asset.pricing_provider, sourceUrl: asset.source_url,
        imageUrl: asset.image_url, legoSetNumber: asset.lego_set_number, archivedAt: asset.archived_at,
      },
      holding: {
        quantity: holding.quantity.toString(), averageCostGbp: holding.quantity.gt(0) ? holding.costBasisGbp.div(holding.quantity).toDecimalPlaces(4).toNumber() : null,
        currentNativePrice, currentFxRate, currentGbpValue: holding.currentGbpValue.toDecimalPlaces(2).toNumber(),
        costBasisGbp: holding.costBasisGbp.toDecimalPlaces(2).toNumber(), unrealizedGbp: holding.unrealizedGbp.toDecimalPlaces(2).toNumber(),
        unrealizedPercent: holding.unrealizedPercent ? holding.unrealizedPercent.toDecimalPlaces(1).toNumber() : null,
        // Matches the portfolio route's identical fallback rule (see its
        // own priceMeta construction) — without this, a never-priced
        // holding reported dataQuality as bare `null` instead of
        // "purchase_price_fallback", which silently suppressed the
        // drawer's own fallback note next to the (already-fixed) neutral
        // source label.
        lastPriceAt: latestSnapshot?.price_at ?? null, lastProvider: latestSnapshot?.provider ?? null,
        dataQuality: latestSnapshot?.data_quality ?? (firstBuy?.nativeUnitPrice != null ? "purchase_price_fallback" : null),
      },
      realizedSales: holding.realizedSales.map(s => ({
        transactionId: s.transactionId, quantity: s.quantity.toString(), proceedsGbp: s.proceedsGbp.toDecimalPlaces(2).toNumber(),
        costBasisRemoved: s.costBasisRemoved.toDecimalPlaces(2).toNumber(), feesGbp: s.feesGbp.toDecimalPlaces(2).toNumber(),
        realizedPnlGbp: s.realizedPnlGbp.toDecimalPlaces(2).toNumber(),
      })),
      priceHistory: collapseToLatestPerObservation(
        snapshotRows.map(s => ({ provider: s.provider, priceAt: s.price_at, createdAt: s.created_at, id: s.id, source: s })),
      ).map(r => ({ priceAt: r.source.price_at, nativeUnitPrice: Number(r.source.native_unit_price), gbpUnitPrice: Number(r.source.gbp_unit_price), provider: r.source.provider, dataQuality: r.source.data_quality })),
      transactions: transactionRows.map(t => ({
        id: t.id, accountId: t.account_id, transactionType: t.transaction_type, tradeAt: t.trade_at, quantity: t.quantity,
        nativeUnitPrice: t.native_unit_price, nativeCurrency: t.native_currency, gbpTotal: t.gbp_total,
        fxRateAtTrade: t.fx_rate_at_trade, gbpFees: t.gbp_fees, notes: t.notes,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not load this investment."); }
}

/**
 * Archiving is refused for an asset with a non-zero current holding unless
 * `confirmNonZeroHolding` is explicitly passed — matching the requirement
 * "prevent archiving an asset with a non-zero holding unless the user
 * explicitly confirms the consequences". Archiving never touches
 * transaction history; it only sets archived_at, which excludes the asset
 * from active dashboard totals going forward.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const user = await requireOwner();
    const { assetId } = await params;
    if (!uuidSchema.safeParse(assetId).success) return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
    const url = new URL(request.url);
    const confirmNonZeroHolding = url.searchParams.get("confirmNonZeroHolding") === "true";
    const body = updateAssetSchema.parse(await request.json());

    const existing = await supabaseRequestAll<{ id: string }>(`investment_assets?id=eq.${assetId}&owner_id=eq.${user.id}&select=id`);
    if (!existing[0]) return NextResponse.json({ error: "Investment not found." }, { status: 404 });

    if (body.archived === true && !confirmNonZeroHolding) {
      const txRows = await supabaseRequestAll<TransactionRow>(
        `investment_transactions?asset_id=eq.${assetId}&reversed_at=is.null&select=id,transaction_type,trade_at,quantity&order=trade_at.asc`,
      );
      const ledgerTx: LedgerTransaction[] = txRows
        .filter(t => t.transaction_type === "buy" || t.transaction_type === "sell" || t.transaction_type === "adjustment")
        .map(t => ({ id: t.id, type: t.transaction_type as "buy" | "sell" | "adjustment", tradeAt: t.trade_at, quantity: t.quantity ?? 0 }));
      const { state } = reduceLedger(ledgerTx);
      if (state.quantity.gt(0)) {
        return NextResponse.json({
          error: `This investment still has a holding of ${state.quantity.toString()} — archiving it will hide it from active totals. Confirm to continue.`,
          requiresConfirmation: true, currentQuantity: state.quantity.toString(),
        }, { status: 409 });
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.displayName !== undefined) patch.display_name = body.displayName;
    if (body.archived !== undefined) patch.archived_at = body.archived ? new Date().toISOString() : null;

    await supabaseRequest(`investment_assets?id=eq.${assetId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    return NextResponse.json({ assetId, archived: body.archived ?? null });
  } catch (error) { return safeApiError(error, "Could not update this investment."); }
}
