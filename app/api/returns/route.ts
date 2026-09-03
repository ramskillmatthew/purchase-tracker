import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { createReturnInputSchema, returnsLossesListQuerySchema } from "@/lib/validation/returns-losses";
import { parseDateRangePreset, resolveDateFilter } from "@/lib/sales/report-date-range";
import { computeReturnsLossesKpis, type ResolvedRange } from "@/lib/returns/kpi";
import { selectSaleItemIdsForReturn } from "@/lib/returns/eligibility";
import { RETURN_IN_PROGRESS_SALE_STATUS } from "@/lib/returns/status-sync";
import { returnNetProfitImpactPence } from "@/lib/returns/financial";
import { anchorDate } from "@/lib/returns/date-precision";
import { poundsToPence, penceToPounds } from "@/lib/sales/money";
import { apiError, auditEvent, callTransition, nextReference } from "@/lib/returns/route-helpers";
import type { LossRecordRow, ReturnRecordRow, SoldUnitCohortEntry } from "@/lib/returns/types";
import type { ReturnRecordView, LossRecordView } from "@/lib/returns/api-contract";
import type { SaleItem, SalesOrder, Purchase } from "@/lib/types";

export const runtime = "nodejs";

const BATCH_SIZE = 200;

async function fetchSoldUnitCohort(ownerId: string, range: ResolvedRange): Promise<SoldUnitCohortEntry[]> {
  const filters = [`owner_id=eq.${ownerId}`, "select=id,sale_date,status"];
  if (range.start) filters.push(`sale_date=gte.${range.start}`);
  if (range.end) filters.push(`sale_date=lte.${range.end}`);
  const orders = await supabaseRequestAll<Pick<SalesOrder, "id" | "sale_date" | "status">>(`sales_orders?${filters.join("&")}`);
  if (!orders.length) return [];
  const orderById = new Map(orders.map(order => [order.id, order]));
  const entries: SoldUnitCohortEntry[] = [];
  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const ids = orders.slice(i, i + BATCH_SIZE).map(order => order.id);
    const items = await supabaseRequestAll<Pick<SaleItem, "sales_order_id">>(`sale_items?sales_order_id=in.(${ids.join(",")})&select=sales_order_id`);
    for (const item of items) {
      const order = orderById.get(item.sales_order_id);
      if (order) entries.push({ saleDate: order.sale_date, saleStatus: order.status });
    }
  }
  return entries;
}

async function enrich(ownerId: string, returns: ReturnRecordRow[], losses: LossRecordRow[]): Promise<{ returnViews: ReturnRecordView[]; lossViews: LossRecordView[] }> {
  const saleIds = [...new Set([...returns.map(r => r.sales_order_id), ...losses.map(l => l.sales_order_id).filter((x): x is string => !!x)])];
  const purchaseIds = [...new Set(losses.map(l => l.purchase_id).filter((x): x is string => !!x))];
  const firstReturnItemIds = [...new Set(returns.map(r => r.sale_item_ids[0]).filter(Boolean))];

  const [sales, purchases, firstItems] = await Promise.all([
    saleIds.length ? supabaseRequestAll<SalesOrder>(`sales_orders?owner_id=eq.${ownerId}&id=in.(${saleIds.join(",")})&select=id,sale_date,platform,custom_platform_name`) : Promise.resolve([]),
    purchaseIds.length ? supabaseRequestAll<Purchase>(`purchases?id=in.(${purchaseIds.join(",")})&select=id,sku,item_description,purchased_from,order_date`) : Promise.resolve([]),
    firstReturnItemIds.length ? supabaseRequestAll<Pick<SaleItem, "id" | "sku_snapshot" | "item_description_snapshot">>(`sale_items?id=in.(${firstReturnItemIds.join(",")})&select=id,sku_snapshot,item_description_snapshot`) : Promise.resolve([]),
  ]);
  const saleById = new Map(sales.map(s => [s.id, s]));
  const purchaseById = new Map(purchases.map(p => [p.id, p]));
  const itemById = new Map(firstItems.map(i => [i.id, i]));

  const returnViews: ReturnRecordView[] = returns.map(r => {
    const s = saleById.get(r.sales_order_id);
    const item = itemById.get(r.sale_item_ids[0]);
    return {
      ...r,
      saleReference: s ? s.id : null,
      saleDate: s?.sale_date ?? null,
      salePlatform: s ? (s.platform === "other" ? s.custom_platform_name : s.platform) : null,
      itemTitle: item?.item_description_snapshot ?? null,
      sku: item?.sku_snapshot ?? null,
    };
  });
  const lossViews: LossRecordView[] = losses.map(l => {
    const p = l.purchase_id ? purchaseById.get(l.purchase_id) : undefined;
    return {
      ...l,
      purchaseReference: p ? p.id : null,
      supplier: p?.purchased_from ?? null,
      purchaseDate: p?.order_date ?? null,
      itemTitle: p?.item_description ?? null,
      sku: p?.sku ?? null,
      saleReference: l.sales_order_id ?? null,
    };
  });
  return { returnViews, lossViews };
}

function financialImpactPence(row: { recordType: "return" | "loss"; net_profit_impact: number | string }): number {
  return poundsToPence(Number(row.net_profit_impact));
}

/**
 * GET — the page's list + KPI source. KPIs are ALWAYS computed from the full
 * filtered dataset; pagination/sorting is applied only to the returned
 * `rows` for the table. Filters: preset/custom range, platform, type
 * (all/returns/losses), status, search (SKU / item title / reference /
 * supplier). Soft-deleted records are excluded everywhere.
 */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const query = returnsLossesListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const preset = parseDateRangePreset(query.preset);
    const filterResult = resolveDateFilter({ preset, customStart: query.start, customEnd: query.end });
    if (!filterResult.ok) return apiError("validation", filterResult.error);
    const range: ResolvedRange = filterResult.range;

    const [allReturns, allLosses, soldUnitCohort] = await Promise.all([
      supabaseRequestAll<ReturnRecordRow>(`return_records?owner_id=eq.${user.id}&deleted_at=is.null&select=*&order=created_at.desc`),
      supabaseRequestAll<LossRecordRow>(`loss_records?owner_id=eq.${user.id}&deleted_at=is.null&select=*&order=created_at.desc`),
      fetchSoldUnitCohort(user.id, range),
    ]);

    // KPIs: full filtered dataset (before any pagination).
    const kpis = computeReturnsLossesKpis({ returns: allReturns, losses: allLosses, soldUnitCohort, range });

    const { returnViews, lossViews } = await enrich(user.id, allReturns, allLosses);

    const search = (query.search ?? "").trim().toLowerCase();
    const matchesSearch = (haystack: (string | null | undefined)[]) => !search || haystack.some(v => (v ?? "").toLowerCase().includes(search));

    let rows: (({ recordType: "return" } & ReturnRecordView) | ({ recordType: "loss" } & LossRecordView))[] = [];
    if (query.type !== "losses") {
      rows.push(...returnViews
        .filter(r => (!query.status || r.workflow_status === query.status))
        .filter(r => (!query.platform || (r.salePlatform ?? "").toLowerCase() === query.platform.toLowerCase()))
        .filter(r => matchesSearch([r.sku, r.itemTitle, r.saleReference]))
        .map(r => ({ recordType: "return" as const, ...r })));
    }
    if (query.type !== "returns") {
      rows.push(...lossViews
        .filter(l => (!query.status || l.loss_type === query.status))
        .filter(l => matchesSearch([l.sku, l.itemTitle, l.purchaseReference, l.supplier, l.saleReference]))
        .map(l => ({ recordType: "loss" as const, ...l })));
    }

    const sort = query.sort ?? "event_date";
    const dir = (query.direction ?? "desc") === "asc" ? 1 : -1;
    rows = rows.sort((a, b) => {
      if (sort === "financial_impact") return (financialImpactPence(a) - financialImpactPence(b)) * dir;
      if (sort === "created_at") return a.created_at.localeCompare(b.created_at) * dir;
      const da = a.recordType === "return" ? (a.completed_on ?? a.started_on) : a.event_date;
      const db = b.recordType === "return" ? (b.completed_on ?? b.started_on) : b.event_date;
      return da.localeCompare(db) * dir || a.created_at.localeCompare(b.created_at) * dir;
    });

    const total = rows.length;
    const pageSize = query.pageSize ?? 25;
    const page = Math.min(Math.max(1, query.page ?? 1), Math.max(1, Math.ceil(total / pageSize)));
    const paged = rows.slice((page - 1) * pageSize, page * pageSize);

    return NextResponse.json({
      returns: returnViews, losses: lossViews, rows: paged,
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      kpis, range,
    });
  } catch (error) { return safeApiError(error, "Could not load returns, losses and write-offs."); }
}

/**
 * POST — "Log a return" (Match sale + Return details). Atomic via
 * rl_create_return: the return row, the linked-sale move to
 * 'return_in_process', and the audit event either all commit or none do.
 * The exact sale_items covered are chosen and stored now (never "first N
 * rows" at completion time), and validated against every other
 * active/completed return on this sale so no unit is returned twice.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = createReturnInputSchema.parse(await request.json());

    const [order] = await (await supabaseRequest(`sales_orders?id=eq.${input.salesOrderId}&owner_id=eq.${user.id}&select=*`)).json() as SalesOrder[];
    if (!order) return apiError("not_found", "Sale not found.");
    if (order.status !== "completed") return apiError("conflict", "Only a completed sale can have a return logged against it.");

    const items = await supabaseRequestAll<SaleItem>(`sale_items?sales_order_id=eq.${order.id}&is_active=eq.true&order=created_at.asc,id.asc`);
    const existingReturns = await supabaseRequestAll<Pick<ReturnRecordRow, "workflow_status" | "sale_item_ids">>(
      `return_records?owner_id=eq.${user.id}&sales_order_id=eq.${order.id}&deleted_at=is.null&select=workflow_status,sale_item_ids`,
    );
    const CONSUMING = new Set(["return_started", "item_sent", "return_delivered", "return_completed"]);
    const alreadyClaimedIds = existingReturns.filter(r => CONSUMING.has(r.workflow_status)).flatMap(r => r.sale_item_ids ?? []);
    const selection = selectSaleItemIdsForReturn({ allActiveSaleItemIds: items.map(item => item.id), alreadyClaimedIds, quantity: input.quantity });
    if (!selection.ok) return apiError("conflict", selection.error);

    // Historical figures of the EXACT selected units — stored on the return NOW
    // so its net-profit impact is authoritative from `return_started` onward
    // (an active return immediately reverses the sale profit it covers; the
    // sale row keeps its own history untouched). Postage / other costs are 0
    // at creation, so the base impact is exactly -(selected units' profit).
    const selectedIds = new Set(selection.saleItemIds);
    const selectedItems = items.filter(item => selectedIds.has(item.id));
    const originalRevenuePence = selectedItems.reduce((s, i) => s + poundsToPence(Number(i.allocated_revenue)), 0);
    const originalProfitPence = selectedItems.reduce((s, i) => s + poundsToPence(Number(i.profit)), 0);
    const originalCostPence = selectedItems.reduce((s, i) => s + poundsToPence(Number(i.purchase_cost_snapshot)), 0);
    const netProfitImpactPence = returnNetProfitImpactPence({ profitReversedPence: originalProfitPence });

    const reference = await nextReference(user.id, "return");
    const startedPd = input.startedPrecision === "month"
      ? { precision: "month" as const, month: input.startedOn.slice(0, 7) }
      : { precision: "exact" as const, date: input.startedOn };

    const outcome = await callTransition<{ record: ReturnRecordRow }>("rl_create_return", {
      p_owner_id: user.id,
      p_return: {
        reference, sales_order_id: order.id, quantity: input.quantity, sale_item_ids: selection.saleItemIds,
        started_on: anchorDate(startedPd), started_precision: input.startedPrecision,
        prev_process_status: order.process_status ?? "", notes: input.notes ?? null, created_by: user.email ?? null,
        // Provisional full-reversal figures for an active return (numeric(10,2)
        // strings). Completion re-evaluates them for the final refund mode.
        original_sale_revenue: penceToPounds(originalRevenuePence),
        original_sale_profit: penceToPounds(originalProfitPence),
        original_stock_cost: penceToPounds(originalCostPence),
        revenue_reversed: penceToPounds(originalRevenuePence),
        profit_reversed: penceToPounds(originalProfitPence),
        net_profit_impact: penceToPounds(netProfitImpactPence),
      },
      p_sale_process_status: RETURN_IN_PROGRESS_SALE_STATUS,
      p_audit: [
        auditEvent("record_created", user.email ?? null, { salesOrderId: order.id, quantity: input.quantity, saleItemIds: selection.saleItemIds }),
        auditEvent("sale_linked", user.email ?? null, { salesOrderId: order.id }),
        auditEvent("sales_status_changed", user.email ?? null, { from: order.process_status ?? null, to: RETURN_IN_PROGRESS_SALE_STATUS }),
      ],
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });

    return NextResponse.json({ record: outcome.data.record }, { status: 201 });
  } catch (error) { return safeApiError(error, "Could not log this return."); }
}
