import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import { planMarketplacePayout } from "@/lib/finance/payout";
import { toFinancePendingSale } from "@/lib/finance/pending-sales";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { confirmMarketplacePayoutSchema } from "@/lib/validation/finance";
import type { SalesOrder } from "@/lib/types";

type Detail = { sales_order_id: string; refunded_pence: number | string };

const errors: Record<string,string> = {
  account_not_found: "Choose a valid receiving account.", sale_not_pending: "One or more selected sales are no longer awaiting payout.",
  mixed_marketplaces: "A combined payout can only contain sales from one marketplace.", variance_explanation_required: "Explain why the received amount differs from the selected sales total.",
  duplicate_sales: "The same sale was selected more than once.", no_sales: "Select at least one pending sale.", invalid_received_amount: "Enter a valid received amount.",
};

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = confirmMarketplacePayoutSchema.parse(await request.json());
    const ids = input.salesOrderIds.join(",");
    const [orders, details] = await Promise.all([
      supabaseRequestAll<SalesOrder>(`sales_orders?owner_id=eq.${user.id}&id=in.(${ids})&select=id,platform,custom_platform_name,total_revenue,status,process_status,cancellation_stock_action&order=id.asc`),
      supabaseRequestAll<Detail>(`finance_sale_payment_details?owner_id=eq.${user.id}&sales_order_id=in.(${ids})&select=sales_order_id,refunded_pence&order=sales_order_id.asc`),
    ]);
    const detailById = new Map(details.map(detail => [detail.sales_order_id, Number(detail.refunded_pence)]));
    const pending = orders.map(order => toFinancePendingSale({ ...order, refundedPence: detailById.get(order.id) ?? 0 })).filter((row): row is NonNullable<typeof row> => row !== null);
    const plan = planMarketplacePayout(input, pending);
    if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 409 });
    try {
      const response = await supabaseRequest("rpc/fh_confirm_marketplace_payout", { method: "POST", body: JSON.stringify({
        p_owner_id: user.id, p_sale_ids: plan.plan.salesOrderIds, p_received_pence: plan.plan.receivedPence,
        p_account_id: plan.plan.accountId, p_received_on: plan.plan.receivedOn, p_payment_reference: plan.plan.paymentReference,
        p_variance_explanation: plan.plan.varianceExplanation, p_idempotency_key: input.idempotencyKey, p_actor: user.email ?? null,
      }) });
      return NextResponse.json({ payout: await response.json() }, { status: 201 });
    } catch (error) {
      if (error instanceof Error) {
        const reason = Object.keys(errors).find(key => error.message.includes(key));
        if (reason) return NextResponse.json({ error: errors[reason], reason }, { status: 409 });
      }
      throw error;
    }
  } catch (error) { return safeApiError(error, "Could not confirm this marketplace payout."); }
}

