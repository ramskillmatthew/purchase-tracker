import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import type { FinanceOverviewResponse } from "@/lib/finance/api-contract";
import { summariseAllMarketplacePending, toFinancePendingSale } from "@/lib/finance/pending-sales";
import { calculateFinancePosition } from "@/lib/finance/position";
import { resolveFinanceRange } from "@/lib/finance/range";
import type { FinanceDateKind, FinanceMarketplace, ForecastIncoming, ForecastOutgoing } from "@/lib/finance/types";
import { isMissingSchemaError, supabaseRequestAll } from "@/lib/supabase";
import type { SalesOrder } from "@/lib/types";

export const runtime = "nodejs";

type AccountRow = { id: string; name: string; provider: string; current_balance_pence: number | string; last_reconciled_at: string | null };
type CardRow = { id: string; name: string; provider: string; current_balance_pence: number | string; business_balance_pence: number | string; personal_balance_pence: number | string; credit_limit_pence: number | string; statement_balance_pence: number | string; statement_date: string | null; payment_due_date: string | null };
type AllocationRow = { id: string; account_id: string; name: string; balance_pence: number | string; target_pence: number | string | null; deadline: string | null };
type IncomingRow = { id: string; marketplace: FinanceMarketplace; source_name: string | null; description: string; category:string|null; payment_reference:string|null; amount_pence: number | string; received_pence: number | string; refunded_pence: number | string; confidence: "confirmed" | "estimated"; date_kind: FinanceDateKind; expected_date: string | null; range_start: string | null; range_end: string | null; status: string };
type OutgoingRow = { id: string; kind: ForecastOutgoing["kind"] | "card_payment"; description: string; payee: string | null; total_pence: number | string; paid_pence: number | string; date_kind: FinanceDateKind; due_date: string | null; range_start: string | null; range_end: string | null; status: ForecastOutgoing["status"] };
type SaleDetailsRow = { sales_order_id: string; refunded_pence: number | string; date_kind: FinanceDateKind; expected_date: string | null; range_start: string | null; range_end: string | null };
type SaleItemSummaryRow = { sales_order_id: string; item_description_snapshot: string };

function pence(value: number | string | null): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new Error("Finance data contained a non-integer pence value.");
  return parsed;
}

export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const rangeResult = resolveFinanceRange({ preset: url.searchParams.get("preset"), start: url.searchParams.get("start"), end: url.searchParams.get("end") });
    if (!rangeResult.ok) return NextResponse.json({ error: rangeResult.error }, { status: 400 });

    let accounts: AccountRow[], cards: CardRow[], allocations: AllocationRow[], manualIncoming: IncomingRow[], outgoings: OutgoingRow[], saleDetails: SaleDetailsRow[];
    try {
      [accounts, cards, allocations, manualIncoming, outgoings, saleDetails] = await Promise.all([
        supabaseRequestAll<AccountRow>(`finance_accounts?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,provider,current_balance_pence,last_reconciled_at&order=created_at.asc,id.asc`),
        supabaseRequestAll<CardRow>(`finance_cards?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,provider,current_balance_pence,business_balance_pence,personal_balance_pence,credit_limit_pence,statement_balance_pence,statement_date,payment_due_date&order=created_at.asc,id.asc`),
        supabaseRequestAll<AllocationRow>(`finance_allocations?owner_id=eq.${user.id}&archived_at=is.null&select=id,account_id,name,balance_pence,target_pence,deadline&order=created_at.asc,id.asc`),
        supabaseRequestAll<IncomingRow>(`finance_incoming?owner_id=eq.${user.id}&deleted_at=is.null&status=in.(pending,partially_received)&select=id,marketplace,source_name,description,category,payment_reference,amount_pence,received_pence,refunded_pence,confidence,date_kind,expected_date,range_start,range_end,status&order=created_at.asc,id.asc`),
        supabaseRequestAll<OutgoingRow>(`finance_planned_outgoings?owner_id=eq.${user.id}&deleted_at=is.null&status=in.(planned,partially_paid)&select=id,kind,description,payee,total_pence,paid_pence,date_kind,due_date,range_start,range_end,status&order=created_at.asc,id.asc`),
        supabaseRequestAll<SaleDetailsRow>(`finance_sale_payment_details?owner_id=eq.${user.id}&select=sales_order_id,refunded_pence,date_kind,expected_date,range_start,range_end&order=created_at.asc,id.asc`),
      ]);
    } catch (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ error: "The Finance Hub database migration has not been installed." }, { status: 503 });
      throw error;
    }

    const orders = await supabaseRequestAll<SalesOrder>(`sales_orders?owner_id=eq.${user.id}&status=eq.completed&select=id,platform,custom_platform_name,total_revenue,status,process_status,cancellation_stock_action&order=created_at.asc,id.asc`);
    const detailBySale = new Map(saleDetails.map(detail => [detail.sales_order_id, detail]));
    const pendingSales = orders.map(order => toFinancePendingSale({ ...order, refundedPence: pence(detailBySale.get(order.id)?.refunded_pence ?? 0) })).filter((row): row is NonNullable<typeof row> => row !== null);
    const marketplacePending = summariseAllMarketplacePending(pendingSales, manualIncoming.map(row => ({
      marketplace: row.marketplace,
      remainingPence: Math.max(0, pence(row.amount_pence) - pence(row.received_pence) - pence(row.refunded_pence)),
    })));
    const pendingIds = pendingSales.map(row => row.salesOrderId);
    const saleItems = pendingIds.length
      ? await supabaseRequestAll<SaleItemSummaryRow>(`sale_items?sales_order_id=in.(${pendingIds.join(",")})&select=sales_order_id,item_description_snapshot&order=sales_order_id.asc,created_at.asc`)
      : [];
    const itemNamesBySale = new Map<string,string[]>();
    for (const item of saleItems) itemNamesBySale.set(item.sales_order_id, [...(itemNamesBySale.get(item.sales_order_id) ?? []), item.item_description_snapshot]);

    const saleIncoming: ForecastIncoming[] = pendingSales.filter(row => row.includedInPendingTotal).map(row => {
      const detail = detailBySale.get(row.salesOrderId);
      return { id: row.salesOrderId, amountPence: row.pendingRevenuePence, confidence: "confirmed", dateKind: detail?.date_kind ?? "unknown", exactDate: detail?.expected_date, rangeStart: detail?.range_start, rangeEnd: detail?.range_end };
    });
    const otherIncoming: ForecastIncoming[] = manualIncoming.map(row => ({
      id: row.id, amountPence: Math.max(0, pence(row.amount_pence) - pence(row.received_pence) - pence(row.refunded_pence)), confidence: row.confidence,
      dateKind: row.date_kind, exactDate: row.expected_date, rangeStart: row.range_start, rangeEnd: row.range_end,
    }));
    const forecastOutgoings: ForecastOutgoing[] = outgoings.filter(row => row.kind !== "card_payment").map(row => ({
      id: row.id, kind: row.kind as ForecastOutgoing["kind"], totalPence: pence(row.total_pence), paidPence: pence(row.paid_pence), status: row.status,
      dateKind: row.date_kind, exactDate: row.due_date, rangeStart: row.range_start, rangeEnd: row.range_end,
    }));
    const cardAmountDue = (card: CardRow) => Math.max(0, pence(card.statement_balance_pence) || pence(card.current_balance_pence));
    const statements = cards.filter(card => card.payment_due_date).map(card => ({ id: card.id, amountPence: cardAmountDue(card), dueDate: card.payment_due_date! }));
    const position = calculateFinancePosition({
      accountBalancesPence: accounts.map(row => pence(row.current_balance_pence)),
      allocationBalancesPence: allocations.map(row => pence(row.balance_pence)),
      cardBalancesPence: cards.map(row => pence(row.current_balance_pence)),
      incoming: [...saleIncoming, ...otherIncoming], outgoings: forecastOutgoings, statements,
      rangeStart: rangeResult.range.start, rangeEnd: rangeResult.range.end,
    });

    const today = new Date().toISOString().slice(0, 10);
    const eventDate = (kind: FinanceDateKind, exact: string | null, start: string | null) => kind === "exact" ? exact : kind === "range" ? start : null;
    const allEvents: FinanceOverviewResponse["events"] = [
      ...pendingSales.flatMap(row => {
        const detail = detailBySale.get(row.salesOrderId);
        const date = eventDate(detail?.date_kind ?? "unknown", detail?.expected_date ?? null, detail?.range_start ?? null);
        return date && row.includedInPendingTotal ? [{ id: `sale-${row.salesOrderId}`, kind: "incoming" as const, title: `${row.sourceLabel} payout expected`, detail: `Sale ${row.salesOrderId.slice(0, 8)} · ${(row.processStatus ?? "pending").replaceAll("_", " ")}`, amountPence: row.pendingRevenuePence, date, rangeEnd: detail?.range_end ?? null, overdue: date < today }] : [];
      }),
      ...manualIncoming.flatMap(row => {
        const date = eventDate(row.date_kind, row.expected_date, row.range_start);
        return date ? [{ id: `incoming-${row.id}`, kind: "incoming" as const, title: row.description, detail: row.source_name ?? row.marketplace, amountPence: Math.max(0, pence(row.amount_pence) - pence(row.received_pence) - pence(row.refunded_pence)), date, rangeEnd: row.range_end, overdue: date < today }] : [];
      }),
      ...outgoings.flatMap(row => {
        const date = eventDate(row.date_kind, row.due_date, row.range_start);
        return date ? [{ id: `outgoing-${row.id}`, kind: "outgoing" as const, title: row.description, detail: row.payee ?? row.kind.replaceAll("_", " "), amountPence: -(pence(row.total_pence) - pence(row.paid_pence)), date, rangeEnd: row.range_end, overdue: date < today }] : [];
      }),
      ...cards.flatMap(card => card.payment_due_date ? [{ id: `card-${card.id}`, kind: "card_due" as const, title: `${card.name} payment due`, detail: "Credit card payment", amountPence: -cardAmountDue(card), date: card.payment_due_date, rangeEnd: null, overdue: card.payment_due_date < today }] : []),
      ...allocations.flatMap(row => row.deadline ? [{ id: `allocation-${row.id}`, kind: "allocation_deadline" as const, title: `${row.name} allocation deadline`, detail: "Allocation pot", amountPence: -pence(row.balance_pence), date: row.deadline, rangeEnd: null, overdue: row.deadline < today }] : []),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    const events = allEvents.filter(event=>event.date>=rangeResult.range.start&&event.date<=rangeResult.range.end);
    const overdueReminders = allEvents.filter((event): event is FinanceOverviewResponse["overdueReminders"][number] =>
      event.overdue && (event.kind === "incoming" || event.kind === "outgoing" || event.kind === "card_due")
    );

    const response: FinanceOverviewResponse = {
      range: rangeResult.range, position, marketplacePending,
      pendingSales: pendingSales.map(row => {
        const detail = detailBySale.get(row.salesOrderId);
        const names = itemNamesBySale.get(row.salesOrderId) ?? [];
        const uniqueNames = [...new Set(names)];
        return {
          ...row,
          itemSummary: uniqueNames.length ? `${uniqueNames[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : "Sale",
          expectedDateKind: detail?.date_kind ?? "unknown",
          expectedDate: detail?.expected_date ?? null,
          expectedRangeStart: detail?.range_start ?? null,
          expectedRangeEnd: detail?.range_end ?? null,
        };
      }),
      manualIncoming: manualIncoming.map(row=>({id:row.id,marketplace:row.marketplace,sourceName:row.source_name,description:row.description,category:row.category,paymentReference:row.payment_reference,amountPence:pence(row.amount_pence),receivedPence:pence(row.received_pence),remainingPence:Math.max(0,pence(row.amount_pence)-pence(row.received_pence)-pence(row.refunded_pence)),confidence:row.confidence,dateKind:row.date_kind,expectedDate:row.expected_date,rangeStart:row.range_start,rangeEnd:row.range_end,status:row.status})),
      accounts: accounts.map(row => ({ id: row.id, name: row.name, provider: row.provider, balancePence: pence(row.current_balance_pence), lastReconciledAt: row.last_reconciled_at })).sort((a,b)=>b.balancePence-a.balancePence||a.name.localeCompare(b.name)),
      cards: cards.map(row => ({ id: row.id, name: row.name, provider: row.provider, currentBalancePence: pence(row.current_balance_pence), businessBalancePence: pence(row.business_balance_pence), personalBalancePence: pence(row.personal_balance_pence), creditLimitPence: pence(row.credit_limit_pence), availableCreditPence: pence(row.credit_limit_pence) - pence(row.current_balance_pence), statementBalancePence: pence(row.statement_balance_pence), statementDate: row.statement_date, paymentDueDate: row.payment_due_date })),
      allocations: allocations.map(row => ({ id: row.id, name: row.name, accountId: row.account_id, balancePence: pence(row.balance_pence), targetPence: row.target_pence === null ? null : pence(row.target_pence), deadline: row.deadline })),
      events,
      overdueReminders,
    };
    return NextResponse.json(response);
  } catch (error) {
    return safeApiError(error, "Could not load Finance Hub.");
  }
}
