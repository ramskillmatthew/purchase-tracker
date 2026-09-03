import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { returnsLossesListQuerySchema } from "@/lib/validation/returns-losses";
import { parseDateRangePreset, resolveDateFilter } from "@/lib/sales/report-date-range";
import { netProfitAdjustmentBreakdown, breakdownTotalPence } from "@/lib/returns/net-profit";
import { apiError } from "@/lib/returns/route-helpers";
import type { LossRecordRow, ReturnRecordRow } from "@/lib/returns/types";

export const runtime = "nodejs";

/**
 * GET /api/returns-losses/net-profit-adjustment — the ONE endpoint the Home
 * dashboard folds into its Net Profit card:
 *
 *   netProfitPence = validSalesProfitPence - operatingExpensePence + adjustmentPence
 *
 * `adjustmentPence` is a SIGNED value the dashboard ADDS as-is (never clamped):
 * usually <= 0, but > 0 when the period's returns reverse loss-making sales
 * (reversing a -£5 sale profit is a +£5 adjustment). `breakdown` gives the
 * per-component pence so Stage 2 can show the reasons without recomputing.
 * Excludes: cancelled / soft-deleted returns, soft-deleted losses, records
 * outside the range, stock-value restoration (never a profit credit). An
 * active return is recognised in its started month; a completed one in
 * recognition_month; a loss on its event date.
 *
 * Accepts the same preset/start/end query shape as every other period-scoped
 * endpoint. Owner-scoped. Never leaks DB detail.
 */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const query = returnsLossesListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const preset = parseDateRangePreset(query.preset);
    const filterResult = resolveDateFilter({ preset, customStart: query.start, customEnd: query.end });
    if (!filterResult.ok) return apiError("validation", filterResult.error);

    const [returns, losses] = await Promise.all([
      supabaseRequestAll<ReturnRecordRow>(`return_records?owner_id=eq.${user.id}&deleted_at=is.null&select=*`),
      supabaseRequestAll<LossRecordRow>(`loss_records?owner_id=eq.${user.id}&deleted_at=is.null&select=*`),
    ]);
    const breakdown = netProfitAdjustmentBreakdown({ returns, losses, range: filterResult.range });
    return NextResponse.json({
      adjustmentPence: breakdownTotalPence(breakdown),
      range: filterResult.range,
      breakdown: {
        profitReversedPence: breakdown.profitReversedPence,
        returnPostagePence: breakdown.returnPostagePence,
        unrecoveredReturnCostsPence: breakdown.unrecoveredReturnCostsPence,
        inventoryWriteOffPence: breakdown.inventoryWriteOffPence,
        lostInventoryPence: breakdown.lostInventoryPence,
        unsellableStockPence: breakdown.unsellableStockPence,
        otherWriteOffPence: breakdown.otherWriteOffPence,
        refundWithoutReturnPence: breakdown.refundWithoutReturnPence,
      },
    });
  } catch (error) { return safeApiError(error, "Could not load the returns/losses net-profit adjustment."); }
}
