import type { ReturnRecordRow, LossRecordRow, ReturnLossAuditEventRow } from "@/lib/returns/types";
import type { ReturnReversal, LossImpact } from "@/lib/returns/financial";
import type { ReturnsLossesKpis } from "@/lib/returns/kpi";
import type { SalesProcessStatus } from "@/lib/types";

/**
 * Returns, Losses & Write-offs — the stable API contract Stage 2's React UI
 * builds against. Every endpoint returns exactly one of the shapes below.
 * Success responses carry fully-resolved data (no id-only references the UI
 * must re-fetch); every money field on a record is the rounded 2dp string/
 * number PostgREST returns and must be `Number(...)`ed before display.
 */

// --- Error envelope (identical across every endpoint) ----------------------
export type ApiErrorKind = "validation" | "auth" | "not_found" | "conflict" | "server";
export type ApiError = {
  error: string;
  kind: ApiErrorKind;
  /** validation only */ issues?: { path: string; message: string }[];
  /** conflict only — the units that block a reversal/edit */ conflictingPurchaseIds?: string[];
};
export const API_ERROR_STATUS: Record<ApiErrorKind, number> = {
  validation: 400, auth: 401, not_found: 404, conflict: 409, server: 500,
};

// --- Enriched rows the list/detail views use -----------------------------
export type ReturnRecordView = ReturnRecordRow & {
  saleReference: string | null;
  saleDate: string | null;
  salePlatform: string | null;
  itemTitle: string | null;
  sku: string | null;
};
export type LossRecordView = LossRecordRow & {
  purchaseReference: string | null;
  supplier: string | null;
  purchaseDate: string | null;
  itemTitle: string | null;
  sku: string | null;
  saleReference: string | null;
};

export type ResolvedRangeContract = { start: string | null; end: string | null };

// --- GET list ------------------------------------------------------------
export type ReturnsLossesListRequest = {
  preset?: string;
  start?: string;
  end?: string;
  platform?: string;
  type?: "all" | "returns" | "losses";
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: "event_date" | "financial_impact" | "created_at";
  direction?: "asc" | "desc";
};
export type ReturnsLossesListResponse = {
  returns: ReturnRecordView[];
  losses: LossRecordView[];
  /** Combined, sorted, PAGINATED rows for the table — `returns`/`losses` above are the unpaged sets. */
  rows: (({ recordType: "return" } & ReturnRecordView) | ({ recordType: "loss" } & LossRecordView))[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  kpis: ReturnsLossesKpis;
  range: ResolvedRangeContract;
};

// --- Match search ------------------------------------------------------------
export type SaleMatchResult = {
  salesOrderId: string;
  saleReference: string | null;
  saleDate: string;
  platform: string;
  status: string;
  processStatus: string | null;
  revenuePence: number;
  profitPence: number;
  soldUnitCount: number;
  eligibleReturnQuantity: number;
  items: { saleItemId: string; sku: string; title: string; costPence: number; revenuePence: number; profitPence: number }[];
};
export type PurchaseMatchResult = {
  /** One synthetic "group" per (sku + unit cost) of eligible in-stock units. */
  groupKey: string;
  sku: string;
  itemTitle: string;
  supplier: string | null;
  purchaseDate: string | null;
  unitCostPence: number;
  /** The exact purchases-table row ids that are in_stock and not already
   * written off — the caller picks `quantity` of these. */
  inStockUnitIds: string[];
  eligibleQuantity: number;
};

export type SaleSearchResponse = {
  results: SaleMatchResult[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
export type PurchaseSearchResponse = {
  results: PurchaseMatchResult[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Honest disclosure of the Stage 1 limitation (purchases has no owner_id). */
  ownershipNote: string;
};

// --- Preview (non-mutating) ------------------------------------------------
export type CompleteReturnPreviewResponse = {
  impact: ReturnReversal;
  recognitionMonth: string;
  unitsAffected: number;
  resultingStockAction: "restore_to_stock" | "keep_out_of_stock";
  resultingSaleStatus: SalesProcessStatus;
  accountingNote: string;
};
export type LossPreviewResponse = {
  impact: LossImpact;
  eventMonth: string;
  unitsAffected: number;
  resultingStockAction: "remove_from_stock" | "no_stock_change";
  accountingNote: string;
};
export type EditPreviewLine = { label: string; beforePence: number | null; afterPence: number | null };
export type ReturnEditPreviewResponse = {
  before: Record<string, number>;
  after: Record<string, number>;
  lines: EditPreviewLine[];
  netProfitImpactDeltaPence: number;
  recognitionMonthChange: { from: string | null; to: string | null } | null;
  movementsToApply: number;
  movementsToReverse: number;
  stockConflicts: string[];
};
export type LossEditPreviewResponse = ReturnEditPreviewResponse;

// --- Mutations ------------------------------------------------------------
export type ReturnCreateResponse = { record: ReturnRecordRow };
export type ReturnStatusUpdateResponse = { record: ReturnRecordRow; alreadyApplied?: boolean };
export type ReturnCompletionPreview = {
  impact: ReturnReversal;
  recognitionMonth: string;
  accountingNote: string;
};
export type ReturnCompleteResponse = { record: ReturnRecordRow; impact: ReturnReversal; alreadyApplied?: boolean };
export type ReturnEditResponse = { record: ReturnRecordRow; impact: ReturnReversal | null; movementsAdded: number; movementsReversed: number };
export type ReturnCancelResponse = { record: ReturnRecordRow; restoredSaleStatus: SalesProcessStatus; alreadyApplied?: boolean };
export type ReturnDeleteResponse = { record: ReturnRecordRow; restoredSaleStatus: SalesProcessStatus | null; alreadyDeleted?: boolean };

export type LossCreateResponse = { record: LossRecordRow; impact: LossImpact; alreadyApplied?: boolean };
export type LossEditResponse = { record: LossRecordRow; impact: LossImpact; movementsAdded: number; movementsReversed: number };
export type LossDeleteResponse = { record: LossRecordRow; alreadyDeleted?: boolean };

export type AuditTrailResponse = { events: ReturnLossAuditEventRow[] };

// --- Home dashboard contract ------------------------------------------------
export type NetProfitAdjustmentResponse = {
  /** <= 0. Fold into net profit as `netProfit + adjustmentPence`. */
  adjustmentPence: number;
  range: ResolvedRangeContract;
  /** Component breakdown so Stage 2 can show it without recalculating. */
  breakdown: {
    profitReversedPence: number;
    returnPostagePence: number;
    unrecoveredReturnCostsPence: number;
    inventoryWriteOffPence: number;
    lostInventoryPence: number;
    unsellableStockPence: number;
    otherWriteOffPence: number;
    refundWithoutReturnPence: number;
  };
};
