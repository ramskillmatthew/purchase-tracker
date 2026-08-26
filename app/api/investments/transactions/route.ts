import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { OversellError, reduceLedger, type LedgerTransaction } from "@/lib/investments/cost-basis";

export const runtime = "nodejs";

const TRANSACTION_TYPES = ["buy", "sell", "fee", "deposit", "withdrawal", "adjustment"] as const;

/**
 * Record transaction — the form adapts per type, but every type flows
 * through this ONE route. `gbpTotal`, when supplied, is authoritative for
 * cost-basis/proceeds (see cost-basis.ts's own doc comment); when a
 * native-currency buy/sell omits it, this route estimates it from
 * `nativeUnitPrice × quantity × fxRateAtTrade` and marks the response
 * `gbpTotalEstimated: true` so the UI can show "(calculated)" rather than
 * implying the broker's own statement figure.
 */
const recordTransactionSchema = z.object({
  accountId: z.string().uuid(),
  assetId: z.string().uuid().nullable().optional(),
  transactionType: z.enum(TRANSACTION_TYPES),
  tradeAt: z.string().min(1),
  quantity: z.number().min(0).optional(),
  nativeUnitPrice: z.number().min(0).optional(),
  nativeCurrency: z.string().trim().length(3).optional().default("GBP"),
  gbpTotal: z.number().optional(),
  fxRateAtTrade: z.number().positive().optional(),
  gbpFees: z.number().min(0).optional().default(0),
  notes: z.string().trim().max(2000).nullable().optional(),
  importReference: z.string().trim().max(200).nullable().optional(),
}).strict();

type TransactionRow = { id: string; transaction_type: string; trade_at: string; quantity: string | null; gbp_total: string; gbp_fees: string };

export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const { searchParams } = new URL(request.url);
    const assetId = searchParams.get("assetId");
    const accountId = searchParams.get("accountId");
    let path = `investment_transactions?owner_id=eq.${user.id}&reversed_at=is.null`;
    if (assetId) path += `&asset_id=eq.${assetId}`;
    if (accountId) path += `&account_id=eq.${accountId}`;
    path += "&select=id,account_id,asset_id,transaction_type,trade_at,quantity,native_unit_price,native_currency,gbp_total,fx_rate_at_trade,gbp_fees,notes,created_at&order=trade_at.desc";
    const rows = await supabaseRequestAll<Record<string, unknown>>(path);
    return NextResponse.json({
      transactions: rows.map(r => ({
        id: r.id, accountId: r.account_id, assetId: r.asset_id, transactionType: r.transaction_type, tradeAt: r.trade_at,
        quantity: r.quantity, nativeUnitPrice: r.native_unit_price, nativeCurrency: r.native_currency,
        gbpTotal: r.gbp_total, fxRateAtTrade: r.fx_rate_at_trade, gbpFees: r.gbp_fees, notes: r.notes, createdAt: r.created_at,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not load transactions."); }
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const body = recordTransactionSchema.parse(await request.json());

    const accounts = await supabaseRequestAll<{ id: string }>(`investment_accounts?id=eq.${body.accountId}&owner_id=eq.${user.id}&select=id`);
    if (!accounts[0]) return NextResponse.json({ error: "That account was not found." }, { status: 400 });

    const needsAsset = body.transactionType !== "deposit" && body.transactionType !== "withdrawal";
    if (needsAsset) {
      if (!body.assetId) return NextResponse.json({ error: "Select an investment for this transaction type." }, { status: 400 });
      const assets = await supabaseRequestAll<{ id: string }>(`investment_assets?id=eq.${body.assetId}&owner_id=eq.${user.id}&select=id`);
      if (!assets[0]) return NextResponse.json({ error: "That investment was not found." }, { status: 400 });
    }

    // Server-side oversell guard — never trust a client-computed
    // "quantity currently owned". Re-derives the real current position
    // from every existing transaction before allowing a sell/adjustment.
    if ((body.transactionType === "sell") && body.assetId && body.quantity) {
      const existingRows = await supabaseRequestAll<TransactionRow>(
        `investment_transactions?asset_id=eq.${body.assetId}&owner_id=eq.${user.id}&reversed_at=is.null&select=id,transaction_type,trade_at,quantity&order=trade_at.asc`,
      );
      const ledgerTx: LedgerTransaction[] = existingRows
        .filter(t => t.transaction_type === "buy" || t.transaction_type === "sell" || t.transaction_type === "adjustment")
        .map(t => ({ id: t.id, type: t.transaction_type as "buy" | "sell" | "adjustment", tradeAt: t.trade_at, quantity: t.quantity ?? 0 }));
      try {
        reduceLedger([...ledgerTx, { id: "pending", type: "sell", tradeAt: body.tradeAt, quantity: body.quantity }]);
      } catch (error) {
        if (error instanceof OversellError) return NextResponse.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }

    let gbpTotal = body.gbpTotal;
    let gbpTotalEstimated = false;
    if (gbpTotal === undefined) {
      if (body.transactionType === "fee") {
        gbpTotal = 0; // fee amount is carried in gbpFees, not gbpTotal
      } else if (body.quantity !== undefined && body.nativeUnitPrice !== undefined) {
        const fxRate = body.nativeCurrency === "GBP" ? 1 : body.fxRateAtTrade;
        if (fxRate === undefined) return NextResponse.json({ error: "Provide either the actual GBP total or an FX rate to estimate it from." }, { status: 400 });
        gbpTotal = body.nativeUnitPrice * body.quantity * fxRate;
        gbpTotalEstimated = true;
      } else {
        return NextResponse.json({ error: "Provide a GBP total for this transaction." }, { status: 400 });
      }
    }

    const response = await supabaseRequest("investment_transactions", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: user.id, account_id: body.accountId, asset_id: body.assetId ?? null, transaction_type: body.transactionType,
        trade_at: body.tradeAt, quantity: body.quantity ?? null, native_unit_price: body.nativeUnitPrice ?? null,
        native_currency: body.nativeCurrency, gbp_total: gbpTotal, fx_rate_at_trade: body.nativeCurrency === "GBP" ? null : (body.fxRateAtTrade ?? null),
        gbp_fees: body.gbpFees, notes: body.notes ?? null, import_reference: body.importReference ?? null,
      }),
    });
    const [row] = await response.json() as TransactionRow[];
    return NextResponse.json({ transactionId: row.id, gbpTotal, gbpTotalEstimated });
  } catch (error) { return safeApiError(error, "Could not record this transaction."); }
}
