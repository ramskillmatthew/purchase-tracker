import { z } from "zod";
import { salesProcessStatuses } from "@/lib/validation/sales";

export const uuidSchema = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD).");
const datePrecision = z.enum(["exact", "month"]);
const nonNegativePounds = z.number().finite().min(0);

export const createReturnInputSchema = z.object({
  salesOrderId: uuidSchema,
  quantity: z.number().int().min(1),
  startedOn: isoDate,
  startedPrecision: datePrecision.default("exact"),
  notes: z.string().trim().max(2000).optional(),
}).strict();

export const advanceReturnStageInputSchema = z.object({
  stage: z.enum(["item_sent", "return_delivered"]),
  date: isoDate,
  precision: datePrecision.default("exact"),
}).strict();

export const completeReturnInputSchema = z.object({
  outcome: z.enum(["returned_safely", "buyer_refunded_no_return"]),
  completedOn: isoDate,
  completedPrecision: datePrecision.default("exact"),
  refundMode: z.enum(["full", "partial"]).default("full"),
  partialRefundAmount: nonNegativePounds.optional(),
  returnPostage: nonNegativePounds.default(0),
  unrecoveredCosts: nonNegativePounds.default(0),
  notes: z.string().trim().max(2000).optional(),
}).strict().refine(v => v.refundMode !== "partial" || v.partialRefundAmount !== undefined, {
  message: "partialRefundAmount is required when refundMode is 'partial'.",
  path: ["partialRefundAmount"],
});

export const cancelReturnInputSchema = z.object({
  restoreSaleStatus: z.enum(salesProcessStatuses).optional(),
}).strict();

/** Only genuinely editable fields; anything absent is left unchanged. A
 * quantity / linked-sale change also requires saleItemIds (the exact units). */
export const editReturnInputSchema = z.object({
  salesOrderId: uuidSchema.optional(),
  quantity: z.number().int().min(1).optional(),
  saleItemIds: z.array(uuidSchema).min(1).max(500).optional(),
  outcome: z.enum(["returned_safely", "buyer_refunded_no_return"]).optional(),
  startedOn: isoDate.optional(),
  startedPrecision: datePrecision.optional(),
  itemSentOn: isoDate.nullable().optional(),
  itemSentPrecision: datePrecision.optional(),
  deliveredOn: isoDate.nullable().optional(),
  deliveredPrecision: datePrecision.optional(),
  completedOn: isoDate.optional(),
  completedPrecision: datePrecision.optional(),
  refundMode: z.enum(["full", "partial"]).optional(),
  partialRefundAmount: nonNegativePounds.nullable().optional(),
  returnPostage: nonNegativePounds.optional(),
  unrecoveredCosts: nonNegativePounds.optional(),
  otherCosts: nonNegativePounds.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const deleteReturnInputSchema = z.object({
  confirm: z.literal(true),
  restoreSaleStatus: z.enum(salesProcessStatuses).optional(),
}).strict();

export const editLossInputSchema = z.object({
  lossType: z.enum(["lost_inventory", "unsellable_purchase", "refund_without_return", "other_write_off"]).optional(),
  purchaseIds: z.array(uuidSchema).max(500).optional(),
  salesOrderId: uuidSchema.nullable().optional(),
  customerRefund: nonNegativePounds.optional(),
  otherCosts: nonNegativePounds.optional(),
  eventDate: isoDate.optional(),
  eventPrecision: datePrecision.optional(),
  loggedDate: isoDate.optional(),
  loggedPrecision: datePrecision.optional(),
  stockAction: z.enum(["remove_from_stock", "keep_in_stock"]).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const deleteLossInputSchema = z.object({
  confirm: z.literal(true),
}).strict();

export const createLossInputSchema = z.object({
  lossType: z.enum(["lost_inventory", "unsellable_purchase", "refund_without_return", "other_write_off"]),
  /** Stable per-attempt request key (a UUID the "Log loss" dialog mints once).
   * A retry / double-submit reuses it and the DB returns the already-created
   * row instead of inserting a duplicate. Optional: omitted → no dedup. */
  idempotencyKey: uuidSchema.optional(),
  purchaseIds: z.array(uuidSchema).max(500).default([]),
  /** refund_without_return only — the exact sale units this refund covers,
   * used for duplicate-event protection against a completed return. */
  saleItemIds: z.array(uuidSchema).max(500).default([]),
  salesOrderId: uuidSchema.optional(),
  customerRefund: nonNegativePounds.default(0),
  otherCosts: nonNegativePounds.default(0),
  eventDate: isoDate,
  eventPrecision: datePrecision.default("exact"),
  loggedDate: isoDate.optional(),
  loggedPrecision: datePrecision.default("exact"),
  stockAction: z.enum(["remove_from_stock", "keep_in_stock"]).default("remove_from_stock"),
  notes: z.string().trim().max(2000).optional(),
}).strict().refine(v => (v.lossType !== "lost_inventory" && v.lossType !== "unsellable_purchase") || v.purchaseIds.length > 0, {
  message: "At least one purchase must be matched for a lost-inventory or unsellable-purchase record.",
  path: ["purchaseIds"],
});

export const returnsLossesListQuerySchema = z.object({
  preset: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  platform: z.string().optional(),
  type: z.enum(["all", "returns", "losses"]).optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  sort: z.enum(["event_date", "financial_impact", "created_at"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
