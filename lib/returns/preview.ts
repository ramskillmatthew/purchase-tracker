import { computeReturnReversal, computeLossImpact, type ReturnOutcome, type LossType } from "@/lib/returns/financial";
import { poundsToPence } from "@/lib/sales/money";
import { canonicalMonth } from "@/lib/returns/date-precision";
import { RETURN_COMPLETED_SALE_STATUS } from "@/lib/returns/status-sync";
import type { CompleteReturnPreviewResponse, LossPreviewResponse } from "@/lib/returns/api-contract";
import type { SaleItem } from "@/lib/types";

/**
 * Read-only impact preview — the SAME authoritative domain functions the
 * final mutations use (computeReturnReversal / computeLossImpact), just
 * without any DB write, inventory movement, audit row or sale-status change.
 * Every value is exact integer pence. The routes that call these ALSO
 * revalidate on the real mutation, so previewing never bypasses concurrency
 * protection.
 */

export type SaleProcessSums = { revenuePence: number; feesPence: number; costPence: number; profitPence: number };

export function sumSaleItems(items: SaleItem[]): SaleProcessSums {
  return {
    revenuePence: items.reduce((s, i) => s + poundsToPence(Number(i.allocated_revenue)), 0),
    feesPence: items.reduce((s, i) => s + poundsToPence(Number(i.allocated_platform_fee)) + poundsToPence(Number(i.allocated_postage)), 0),
    costPence: items.reduce((s, i) => s + poundsToPence(Number(i.purchase_cost_snapshot)), 0),
    profitPence: items.reduce((s, i) => s + poundsToPence(Number(i.profit)), 0),
  };
}

export function buildCompleteReturnPreview(params: {
  saleSums: SaleProcessSums;
  quantity: number;
  outcome: ReturnOutcome;
  completedOn: string;
  completedPrecision: "exact" | "month";
  refundMode: "full" | "partial";
  partialRefundPounds?: number;
  returnPostagePounds: number;
  unrecoveredCostsPounds: number;
  otherCostsPounds?: number;
}): CompleteReturnPreviewResponse {
  const pd = params.completedPrecision === "month"
    ? { precision: "month" as const, month: params.completedOn.slice(0, 7) }
    : { precision: "exact" as const, date: params.completedOn };
  const otherPence = poundsToPence(params.otherCostsPounds ?? 0);

  const impact = computeReturnReversal({
    saleRevenuePence: params.saleSums.revenuePence,
    saleFeesPence: params.saleSums.feesPence,
    saleCostPence: params.saleSums.costPence,
    saleProfitPence: params.saleSums.profitPence,
    saleQty: params.quantity, returnedQty: params.quantity,
    refundMode: params.refundMode,
    partialRefundPence: params.partialRefundPounds != null ? poundsToPence(params.partialRefundPounds) : undefined,
    returnPostagePence: poundsToPence(params.returnPostagePounds),
    unrecoveredCostsPence: poundsToPence(params.unrecoveredCostsPounds) + otherPence,
    outcome: params.outcome,
  });

  return {
    impact,
    recognitionMonth: canonicalMonth(pd),
    unitsAffected: params.quantity,
    resultingStockAction: params.outcome === "returned_safely" ? "restore_to_stock" : "keep_out_of_stock",
    resultingSaleStatus: RETURN_COMPLETED_SALE_STATUS,
    accountingNote: "The original sale stays in its own month; this reversal and its costs are recognised in the completion month. Stock value restored is an inventory movement, never a profit credit.",
  };
}

export function buildLossPreview(params: {
  lossType: LossType;
  quantity: number;
  unitCostPence: number;
  customerRefundPounds: number;
  otherCostsPounds: number;
  stockRemoved: boolean;
  eventDate: string;
  eventPrecision: "exact" | "month";
}): LossPreviewResponse {
  const impact = computeLossImpact({
    lossType: params.lossType, quantity: params.quantity, unitCostPence: params.unitCostPence,
    customerRefundPence: poundsToPence(params.customerRefundPounds),
    otherCostsPence: poundsToPence(params.otherCostsPounds),
    stockRemoved: params.stockRemoved,
  });
  const pd = params.eventPrecision === "month"
    ? { precision: "month" as const, month: params.eventDate.slice(0, 7) }
    : { precision: "exact" as const, date: params.eventDate };
  return {
    impact,
    eventMonth: canonicalMonth(pd),
    unitsAffected: params.quantity,
    resultingStockAction: params.stockRemoved ? "remove_from_stock" : "no_stock_change",
    accountingNote: "The loss reduces net profit in the event month (not the logged date). Customer refund, stock-cost write-off and other costs are separate components.",
  };
}
