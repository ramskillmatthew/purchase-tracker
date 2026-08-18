import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { resolvePokePulseIdentity } from "@/lib/investments/providers/pokepulse";
import { getFxRate } from "@/lib/investments/providers/fx-provider";
import { refreshOneAsset, type RefreshResultEntry } from "@/lib/investments/refresh";
import { backfillOneAsset } from "@/lib/investments/history-backfill";

export const runtime = "nodejs";

/**
 * Add investment — creates ONE asset identity (see investment_assets' own
 * comment: one row per distinct holding identity, never per lot) plus an
 * OPTIONAL initial transaction in the same request. Two sequential REST
 * calls (asset insert, then transaction insert) rather than a single RPC —
 * unlike the extension-batch feature elsewhere in this app, there is no
 * concurrent-creation race to guard here (an owner adding one investment
 * at a time from their own single session), so the extra RPC machinery
 * isn't justified; if the transaction insert fails after the asset insert
 * succeeds, the asset simply has no transactions yet — a safe, recoverable
 * state (never a partial/corrupt asset row), not a silent data-loss risk.
 */
const baseFields = {
  accountId: z.string().uuid(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  quantity: z.number().positive().optional(),
  purchaseUnitPrice: z.number().positive().optional(),
  purchaseTotalGbp: z.number().positive().optional(),
  feesGbp: z.number().min(0).optional().default(0),
};

const stockSchema = z.object({
  category: z.literal("stock"),
  displayName: z.string().trim().min(1).max(160),
  ticker: z.string().trim().min(1).max(20),
  exchange: z.string().trim().max(40).nullable().optional(),
  nativeCurrency: z.string().trim().length(3).default("USD"),
  ...baseFields,
}).strict();

const pokemonSchema = z.object({
  category: z.literal("pokemon"),
  sourceUrl: z.string().trim().url().max(500),
  ...baseFields,
}).strict();

const legoSchema = z.object({
  category: z.literal("lego"),
  displayName: z.string().trim().min(1).max(160),
  legoSetNumber: z.string().trim().min(1).max(40),
  currentMarketPriceGbp: z.number().positive().optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  ...baseFields,
}).strict();

const cashSchema = z.object({
  category: z.literal("cash"),
  currency: z.string().trim().length(3).default("GBP"),
  openingAmount: z.number().min(0),
  accountId: z.string().uuid(),
}).strict();

const createAssetSchema = z.discriminatedUnion("category", [stockSchema, pokemonSchema, legoSchema, cashSchema]);

type AssetRow = {
  id: string; category: string; display_name: string; ticker: string | null; exchange: string | null;
  native_currency: string; pricing_provider: string; source_url: string | null; external_id: string | null;
  image_url: string | null; lego_set_number: string | null; metadata: Record<string, unknown>;
  created_at: string; updated_at: string; archived_at: string | null;
};

function serializeAsset(row: AssetRow) {
  return {
    id: row.id, category: row.category, displayName: row.display_name, ticker: row.ticker, exchange: row.exchange,
    nativeCurrency: row.native_currency, pricingProvider: row.pricing_provider, sourceUrl: row.source_url,
    externalId: row.external_id, imageUrl: row.image_url, legoSetNumber: row.lego_set_number, metadata: row.metadata,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at,
  };
}

export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    let path = `investment_assets?owner_id=eq.${user.id}&archived_at=is.null`;
    if (category) path += `&category=eq.${category}`;
    path += `&select=id,category,display_name,ticker,exchange,native_currency,pricing_provider,source_url,external_id,image_url,lego_set_number,metadata,created_at,updated_at,archived_at&order=created_at.asc`;
    const rows = await supabaseRequestAll<AssetRow>(path);
    return NextResponse.json({ assets: rows.map(serializeAsset) });
  } catch (error) { return safeApiError(error, "Could not load investments."); }
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const body = createAssetSchema.parse(await request.json());

    // Verify the account exists and belongs to this owner before creating
    // anything under it — never trust a client-supplied accountId blindly.
    const accounts = await supabaseRequestAll<{ id: string }>(`investment_accounts?id=eq.${body.accountId}&owner_id=eq.${user.id}&select=id`);
    if (!accounts[0]) return NextResponse.json({ error: "That account was not found." }, { status: 400 });

    let insertBody: Record<string, unknown>;
    let initialTransaction: Record<string, unknown> | null = null;

    if (body.category === "stock") {
      insertBody = {
        owner_id: user.id, category: "stock", display_name: body.displayName, ticker: body.ticker.toUpperCase(),
        exchange: body.exchange ?? null, native_currency: body.nativeCurrency, pricing_provider: "twelve_data",
        external_id: `${body.ticker.toUpperCase()}:${body.exchange ?? ""}`,
      };
    } else if (body.category === "pokemon") {
      const identity = await resolvePokePulseIdentity(body.sourceUrl);
      if (!identity.ok) return NextResponse.json({ error: identity.error }, { status: 400 });
      insertBody = {
        owner_id: user.id, category: "pokemon", display_name: identity.data.name, native_currency: "GBP",
        pricing_provider: "pokepulse", source_url: body.sourceUrl, external_id: identity.data.productId,
        image_url: identity.data.imageUrl,
      };
    } else if (body.category === "lego") {
      insertBody = {
        owner_id: user.id, category: "lego", display_name: body.displayName, native_currency: "GBP",
        pricing_provider: "manual", external_id: body.legoSetNumber, lego_set_number: body.legoSetNumber,
        image_url: body.imageUrl ?? null,
      };
    } else {
      insertBody = {
        owner_id: user.id, category: "cash", display_name: `${body.currency} cash`, native_currency: body.currency,
        pricing_provider: "none", external_id: `cash:${body.accountId}:${body.currency}`,
      };
    }

    const response = await supabaseRequest("investment_assets", {
      method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(insertBody),
    });
    const [asset] = await response.json() as AssetRow[];

    // Optional initial transaction (buy for stock/pokemon/lego, deposit for cash).
    //
    // REGRESSION (real confirmed bug): this used to compute gbp_total as
    // `purchaseUnitPrice * quantity` with NO currency conversion at all —
    // for a non-GBP asset (e.g. a USD stock), the native purchase price
    // was silently stored as if it were already GBP (an implied 1:1 "FX
    // rate"). That poisoned the cost basis permanently: holding-aggregate.ts's
    // currency-effect decomposition derives its purchase FX rate entirely
    // from gbp_total / native_cost_basis, so a wrong gbp_total here shows
    // up later as a wildly wrong "Currency effect" figure, even though the
    // decomposition formula itself is correct. Confirmed live: a real
    // stored Meta purchase had fx_rate_at_trade: null and gbp_total
    // exactly equal to nativeUnitPrice × quantity (implied rate 1.0)
    // against a real current USD→GBP rate of ~0.74.
    const nowIso = new Date().toISOString();
    if (body.category === "cash") {
      if (body.openingAmount > 0) {
        const fxRate = body.currency === "GBP" ? 1 : (await getFxRate(body.currency, nowIso.slice(0, 10))).rate;
        initialTransaction = {
          owner_id: user.id, account_id: body.accountId, asset_id: asset.id, transaction_type: "deposit",
          trade_at: nowIso, quantity: body.openingAmount, native_unit_price: 1, native_currency: body.currency,
          gbp_total: body.openingAmount * fxRate, fx_rate_at_trade: body.currency === "GBP" ? null : fxRate, gbp_fees: 0,
        };
      }
    } else if (body.quantity && (body.purchaseUnitPrice || body.purchaseTotalGbp)) {
      const tradeAt = body.purchaseDate ? `${body.purchaseDate}T00:00:00.000Z` : nowIso;
      let gbpTotal = body.purchaseTotalGbp ?? null;
      let fxRateAtTrade: number | null = null;
      if (gbpTotal === null) {
        if (asset.native_currency === "GBP") {
          gbpTotal = body.purchaseUnitPrice! * body.quantity;
        } else {
          const { rate } = await getFxRate(asset.native_currency, tradeAt.slice(0, 10));
          fxRateAtTrade = rate;
          gbpTotal = body.purchaseUnitPrice! * body.quantity * rate;
        }
      }
      initialTransaction = {
        owner_id: user.id, account_id: body.accountId, asset_id: asset.id, transaction_type: "buy",
        trade_at: tradeAt, quantity: body.quantity, native_unit_price: body.purchaseUnitPrice ?? null,
        native_currency: asset.native_currency, gbp_total: gbpTotal, fx_rate_at_trade: fxRateAtTrade, gbp_fees: body.feesGbp ?? 0,
      };
    }

    if (initialTransaction) {
      await supabaseRequest("investment_transactions", {
        method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(initialTransaction),
      }).catch(() => { /* asset itself is already safely created; the transaction can be added manually via Record transaction if this best-effort insert fails */ });
    }

    // Price it immediately rather than leaving a brand-new stock/PokePulse
    // holding permanently "never priced" until the next manual/auto
    // refresh — LEGO (manual) and cash (no provider) have nothing to fetch.
    let pricing: RefreshResultEntry | null = null;
    if (body.category === "stock" || body.category === "pokemon") {
      pricing = await refreshOneAsset(user.id, asset);
      // Full history backfill from this asset's own first buy — requires
      // the initial transaction above to have been written first (that's
      // what earliestBuyDate reads). Best-effort: the asset and today's
      // price are already safely saved either way; a chart with only
      // today's point is a lesser problem than losing the add entirely.
      await backfillOneAsset(user.id, asset).catch(() => {});
    }

    return NextResponse.json({ asset: serializeAsset(asset), pricing });
  } catch (error) { return safeApiError(error, "Could not add this investment."); }
}
