import { z } from "zod";

export const salesPlatforms = ["vinted", "ebay", "depop", "other"] as const;
// "itemised" — supabase-sales-v2.sql / lib/sales/allocation.ts's Stage 4
// addition: per-line revenue for mixed-product baskets, instead of an equal
// split across every selected purchase. "total"/"average" are the original
// Stage 2/3 modes and keep their exact original meaning and server-side
// behaviour (equal split) — nothing about them changed.
export const revenueInputModes = ["total", "average", "itemised"] as const;

/** Sensible maximum purchase UUIDs in one sale — matches the existing bulk-operation ceilings elsewhere in this app (Bulk Input, bulk-delete). */
export const MAX_SALE_ITEMS = 100;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.coerce.number().nonnegative().max(99999999);

const lineRevenueSchema = z.object({
  purchaseId: z.string().uuid(),
  revenue: money,
}).strict();

/**
 * POST /api/sales request validation. Every monetary field is a plain
 * non-negative number in POUNDS at this boundary (matching purchaseInputSchema's
 * own convention) — conversion to integer pence for the actual allocation
 * math happens server-side (see lib/sales/money.ts), never trusted from the
 * client as already-pence.
 *
 * Deliberately does NOT accept purchase cost, description, category, SKU,
 * or supplier — those are always loaded and snapshotted server-side from
 * the purchases table itself (see app/api/sales/route.ts and the
 * create_completed_sale RPC), never accepted as client-authoritative.
 *
 * `lineRevenues` is itemised-mode-only: one {purchaseId, revenue} entry per
 * selected purchase, reconciled here (client-side pre-check) AND again,
 * authoritatively, inside the RPC transaction itself — this schema is a
 * fast-fail convenience, never the sole enforcement point.
 */
export const createSaleInputSchema = z.object({
  purchaseIds: z.array(z.string().uuid()).min(1).max(MAX_SALE_ITEMS),
  saleDate: isoDate,
  platform: z.enum(salesPlatforms),
  customPlatformName: z.string().trim().min(1).max(100).nullable().optional(),
  revenueInputMode: z.enum(revenueInputModes),
  revenueInputValue: money,
  lineRevenues: z.array(lineRevenueSchema).max(MAX_SALE_ITEMS).optional(),
  platformFees: money.default(0),
  postage: money.default(0),
}).strict()
  .refine(data => new Set(data.purchaseIds).size === data.purchaseIds.length, {
    message: "Duplicate purchase IDs are not allowed in one sale.", path: ["purchaseIds"],
  })
  .refine(data => data.platform !== "other" || !!data.customPlatformName?.trim(), {
    message: "A custom platform name is required when platform is Other.", path: ["customPlatformName"],
  })
  .refine(data => data.platform === "other" || !data.customPlatformName?.trim(), {
    message: "Custom platform name must be left blank unless platform is Other.", path: ["customPlatformName"],
  })
  .refine(data => data.revenueInputMode !== "itemised" || !!data.lineRevenues?.length, {
    message: "Enter a revenue amount for every selected item.", path: ["lineRevenues"],
  })
  .refine(data => data.revenueInputMode === "itemised" || !data.lineRevenues, {
    message: "Line revenues can only be provided in itemised mode.", path: ["lineRevenues"],
  })
  .refine(data => {
    if (data.revenueInputMode !== "itemised" || !data.lineRevenues) return true;
    const ids = data.lineRevenues.map(line => line.purchaseId);
    return new Set(ids).size === ids.length;
  }, { message: "The same purchase appears more than once in the itemised revenue list.", path: ["lineRevenues"] })
  .refine(data => {
    if (data.revenueInputMode !== "itemised" || !data.lineRevenues) return true;
    const lineIds = new Set(data.lineRevenues.map(line => line.purchaseId));
    const selectedIds = new Set(data.purchaseIds);
    return lineIds.size === selectedIds.size && [...lineIds].every(id => selectedIds.has(id));
  }, { message: "Itemised revenue must be entered for exactly the selected purchases — no more, no fewer.", path: ["lineRevenues"] })
  .refine(data => {
    if (data.revenueInputMode !== "itemised" || !data.lineRevenues) return true;
    const sumPence = data.lineRevenues.reduce((sum, line) => sum + Math.round(line.revenue * 100), 0);
    return sumPence === Math.round(data.revenueInputValue * 100);
  }, { message: "Itemised revenue lines must add up to exactly the order's total revenue.", path: ["revenueInputValue"] });

export type CreateSaleInputParsed = z.infer<typeof createSaleInputSchema>;

/** Sensible maximum sales orders in one cancellation batch — coarser-grained than MAX_SALE_ITEMS (that caps units in ONE sale; this caps how many whole sales one bulk action can touch), but the same "sensible ceiling" convention as every other bulk operation in this app. */
export const MAX_CANCEL_SALES = 200;

/**
 * POST /api/sales/cancel request validation. `salesOrderIds` must be
 * non-empty, within the batch ceiling, and free of duplicates — the RPC
 * (cancel_completed_sales, supabase-sales-v3.sql) re-validates all of this
 * again itself, authoritatively; this schema is a fast-fail convenience,
 * never the sole enforcement point. `returnToStock` is one explicit,
 * required boolean — there is no default, so a caller can never cancel a
 * sale without deciding what happens to its stock.
 */
export const cancelSalesInputSchema = z.object({
  salesOrderIds: z.array(z.string().uuid()).min(1).max(MAX_CANCEL_SALES),
  returnToStock: z.boolean(),
}).strict()
  .refine(data => new Set(data.salesOrderIds).size === data.salesOrderIds.length, {
    message: "Duplicate sale IDs are not allowed in one cancellation.", path: ["salesOrderIds"],
  });

export type CancelSalesInputParsed = z.infer<typeof cancelSalesInputSchema>;

/**
 * GET /api/sales/reports query-string validation — a light shape check
 * only (every value here is necessarily a string from a URL). The actual
 * date semantics — which preset, whether a custom range is a valid
 * calendar range with start <= end — are validated authoritatively by
 * lib/sales/report-date-range.ts's resolveDateFilter, the single shared
 * source of truth the reports page also calls client-side for its own
 * "resolved range" preview. This schema exists only to reject a
 * structurally malformed request (missing/wrong-typed params) before that.
 */
export const reportFilterQuerySchema = z.object({
  preset: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
}).strict();
