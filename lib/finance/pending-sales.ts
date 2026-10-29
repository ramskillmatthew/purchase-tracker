import { effectiveSalesProcessStatus } from "@/lib/sales/process-status";
import type { FinanceMarketplace } from "@/lib/finance/types";
import type { SalesOrder, SalesProcessStatus } from "@/lib/types";

export type FinanceSaleInput = Pick<SalesOrder,
  "id" | "platform" | "custom_platform_name" | "total_revenue" | "status" | "process_status" | "cancellation_stock_action"
> & {
  refundedPence?: number;
};

export type FinancePendingSale = {
  salesOrderId: string;
  marketplace: FinanceMarketplace;
  sourceLabel: string;
  processStatus: SalesProcessStatus | null;
  originalRevenuePence: number;
  refundedPence: number;
  pendingRevenuePence: number;
  crossedOutForReturn: boolean;
  includedInPendingTotal: boolean;
};

export type MarketplacePendingSummary = Record<FinanceMarketplace, {
  marketplace: FinanceMarketplace;
  saleCount: number;
  pendingRevenuePence: number;
}>;

const FINANCE_PENDING_STATUSES = new Set<SalesProcessStatus>([
  "awaiting_dispatch",
  "sent",
  "delivered_awaiting_payout",
]);

export function financeMarketplace(order: Pick<SalesOrder, "platform" | "custom_platform_name">): { marketplace: FinanceMarketplace; sourceLabel: string } {
  if (order.platform === "vinted") return { marketplace: "vinted", sourceLabel: "Vinted" };
  if (order.platform === "ebay") return { marketplace: "ebay", sourceLabel: "eBay" };
  return { marketplace: "other", sourceLabel: order.custom_platform_name?.trim() || (order.platform === "depop" ? "Depop" : "Other") };
}

/**
 * Converts the existing Sales source of truth into Finance Hub presentation.
 * Return-in-process rows remain visible (crossed out and linked to Returns)
 * but contribute zero. Completed/cancelled rows are history, not pending.
 */
export function toFinancePendingSale(order: FinanceSaleInput): FinancePendingSale | null {
  const processStatus = effectiveSalesProcessStatus(order);
  if (processStatus === "completed" || processStatus === "cancelled" || processStatus === "returned_cancelled" || processStatus === null) return null;

  const originalRevenuePence = Math.round(Number(order.total_revenue) * 100);
  const refundedPence = Math.max(0, Math.min(originalRevenuePence, order.refundedPence ?? 0));
  const crossedOutForReturn = processStatus === "return_in_process";
  const includedInPendingTotal = FINANCE_PENDING_STATUSES.has(processStatus);
  const { marketplace, sourceLabel } = financeMarketplace(order);

  return {
    salesOrderId: order.id,
    marketplace,
    sourceLabel,
    processStatus,
    originalRevenuePence,
    refundedPence,
    pendingRevenuePence: includedInPendingTotal ? Math.max(0, originalRevenuePence - refundedPence) : 0,
    crossedOutForReturn,
    includedInPendingTotal,
  };
}

export function summariseMarketplacePending(rows: FinancePendingSale[]): MarketplacePendingSummary {
  const result: MarketplacePendingSummary = {
    vinted: { marketplace: "vinted", saleCount: 0, pendingRevenuePence: 0 },
    ebay: { marketplace: "ebay", saleCount: 0, pendingRevenuePence: 0 },
    other: { marketplace: "other", saleCount: 0, pendingRevenuePence: 0 },
  };
  for (const row of rows) {
    if (!row.includedInPendingTotal) continue;
    result[row.marketplace].saleCount += 1;
    result[row.marketplace].pendingRevenuePence += row.pendingRevenuePence;
  }
  return result;
}

/** Adds unlinked/manual receipts to the same marketplace headline totals. */
export function addManualIncomingToMarketplaceSummary(
  summary: MarketplacePendingSummary,
  rows: Array<{ marketplace: FinanceMarketplace; amountPence: number; receivedPence: number; refundedPence: number }>,
): MarketplacePendingSummary {
  const result: MarketplacePendingSummary = {
    vinted: { ...summary.vinted },
    ebay: { ...summary.ebay },
    other: { ...summary.other },
  };
  for (const row of rows) {
    const remaining = Math.max(0, row.amountPence - row.receivedPence - row.refundedPence);
    if (remaining === 0) continue;
    // Marketplace totals contain linked sales only. Every manually recorded
    // amount is unlinked incoming money and therefore belongs only in Other,
    // even when its source happens to be eBay or Vinted.
    result.other.pendingRevenuePence += remaining;
    result.other.saleCount += 1;
  }
  return result;
}

export function summariseAllMarketplacePending(
  sales: FinancePendingSale[],
  manualIncoming: Array<{ marketplace: FinanceMarketplace; remainingPence: number }>,
): MarketplacePendingSummary {
  return addManualIncomingToMarketplaceSummary(
    summariseMarketplacePending(sales),
    manualIncoming.map(row => ({ marketplace: row.marketplace, amountPence: row.remainingPence, receivedPence: 0, refundedPence: 0 })),
  );
}
