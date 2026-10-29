import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase-finance-hub.sql", "utf8").toLowerCase();

describe("Finance Hub migration safety", () => {
  it("is additive and transaction wrapped", () => {
    expect(sql.trimStart().includes("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/drop\s+table/);
    expect(sql).not.toMatch(/truncate\s+/);
  });

  it("uses server-only tables and enables RLS everywhere", () => {
    const tables = [...sql.matchAll(/create table if not exists public\.(finance_[a-z_]+)/g)].map(match => match[1]);
    expect(tables.length).toBeGreaterThanOrEqual(13);
    for (const table of tables) expect(sql).toContain(`alter table public.${table} enable row level security`);
    expect(sql).toContain("from anon, authenticated");
  });
  it("provides private owner-scoped Finance attachments with the approved limits",()=>{expect(sql).toContain("'finance-files'");expect(sql).toContain("10485760");expect(sql).toContain("'application/pdf'");expect(sql).toContain("owner accesses finance files")});

  it("keeps transfers out of income/profit through a dedicated ledger type", () => {
    expect(sql).toContain("'transfer'");
    expect(sql).toContain("counterparty_account_id");
  });

  it("has idempotency protection for payouts and ledger entries", () => {
    expect(sql.match(/unique \(owner_id,\s*idempotency_key\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("confirms payouts atomically and restricts the RPC to service_role", () => {
    expect(sql).toContain("function public.fh_confirm_marketplace_payout");
    expect(sql).toContain("update public.sales_orders set process_status = 'completed'");
    expect(sql).toContain("update public.finance_accounts set current_balance_pence = current_balance_pence + p_received_pence");
    expect(sql).toContain("grant execute on function public.fh_confirm_marketplace_payout");
    expect(sql).toContain("to service_role");
  });

  it("creates planned outgoings atomically without creating purchases or expenses", () => {
    const start = sql.indexOf("function public.fh_create_planned_outgoing");
    const end = sql.indexOf("end $$", start);
    const body = sql.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("insert into public.finance_planned_outgoings");
    expect(body).toContain("insert into public.finance_payment_parts");
    expect(body).not.toContain("insert into public.purchases");
    expect(body).not.toContain("insert into public.expenses");
    expect(sql).toContain("grant execute on function public.fh_create_planned_outgoing");
  });

  it("converts stock and expenses only when the user confirms the final payment, using the actual total, and creates one next recurring row",()=>{
    expect(sql).toContain("function public.fh_pay_planned_outgoing");
    expect(sql).toContain("p_finalise boolean");
    expect(sql).toContain("if p_finalise then");
    expect(sql).toContain("actual_total_pence=case when p_finalise then v_new_paid else null end");
    expect(sql).toContain("insert into public.purchases");
    expect(sql).toContain("v_new_paid/v_quantity");
    expect(sql).toContain("from generate_series(1,v_quantity)");
    expect(sql).toContain("insert into public.expenses");
    expect(sql).toContain("v_new_paid/100.0");
    expect(sql).toContain("recurrence_parent_id=v_out.id");
    expect(sql).toContain("grant execute on function public.fh_pay_planned_outgoing");
  });

  it("keeps allocations inside account cash while tracking every movement",()=>{expect(sql).toContain("function public.fh_create_allocation");expect(sql).toContain("function public.fh_move_allocation");expect(sql).toContain("insert into public.finance_allocation_movements");expect(sql).toContain("different_backing_accounts");expect(sql).not.toMatch(/finance_accounts set current_balance_pence=current_balance_pence-p_starting_pence/)});
  it("closes allocation pots by releasing the reservation while preserving history",()=>{expect(sql).toContain("function public.fh_archive_allocation");expect(sql).toContain("'allocation_archived'");expect(sql).toContain("'released_pence'");expect(sql).toContain("grant execute on function public.fh_archive_allocation")});
  it("automatically releases a linked allocation as outgoing payments are made",()=>{expect(sql).toContain("least(balance_pence,p_amount_pence)");expect(sql).toContain("automatically released when linked outgoing was paid");expect(sql).toContain("'allocation_released_pence'")});
  it("makes transfers cash-neutral and requires a reconciliation reason",()=>{expect(sql).toContain("function public.fh_transfer_account");expect(sql).toContain("current_balance_pence=current_balance_pence-p_amount_pence");expect(sql).toContain("current_balance_pence=current_balance_pence+p_amount_pence");expect(sql).toContain("'transfer'");expect(sql).toContain("function public.fh_reconcile_account");expect(sql).toContain("raise exception 'reason_required'")});
  it("archives only settled accounts and cards and retains their history",()=>{expect(sql).toContain("function public.fh_archive_account");expect(sql).toContain("account_balance_must_be_zero");expect(sql).toContain("'account_archived'");expect(sql).toContain("function public.fh_archive_card");expect(sql).toContain("card_balance_must_be_zero");expect(sql).toContain("'card_archived'")});
  it("supports card credits and atomic payments from a chosen bank",()=>{expect(sql).toContain("function public.fh_update_card");expect(sql).toContain("function public.fh_pay_card");expect(sql).toContain("current_balance_pence=current_balance_pence-v_amount");expect(sql).toContain("business_balance_pence=business_balance_pence-v_business");expect(sql).toContain("personal_balance_pence=personal_balance_pence-v_personal")});
  it("adds completed card purchases to the correct card without prematurely changing a future statement",()=>{expect(sql).toContain("current_balance_pence=current_balance_pence+x.\"amountpence\"");expect(sql).toContain("coalesce(x.\"paymenton\",p_paid_on)<=statement_date");expect(sql).toContain("last_updated_at=now()")});
  it("keeps permanent before-and-after audit history for card changes",()=>{expect(sql).toContain("'card_created'");expect(sql).toContain("'card_reconciled'");expect(sql).toContain("'card_payment','card'");expect(sql).toContain("'credit card payment completed'")});
  it("records manual incoming atomically and only changes cash once confirmed",()=>{expect(sql).toContain("function public.fh_create_manual_incoming");expect(sql).toContain("case when v_confirmed then 'received' else 'pending' end");expect(sql).toContain("current_balance_pence=current_balance_pence+v_incoming.amount_pence");expect(sql).toContain("grant execute on function public.fh_create_manual_incoming")});
  it("supports partial and final receipts for estimated manual incoming",()=>{expect(sql).toContain("function public.fh_receive_manual_incoming");expect(sql).toContain("'partially_received'");expect(sql).toContain("receipt_exceeds_outstanding");expect(sql).toContain("'manual_incoming_receipt'");expect(sql).toContain("grant execute on function public.fh_receive_manual_incoming")});
  it("cancels only outstanding manual incoming while retaining received cash and audit history",()=>{expect(sql).toContain("function public.fh_cancel_manual_incoming");expect(sql).toContain("incoming_not_cancellable");expect(sql).toContain("'manual_incoming_cancelled'");expect(sql).toContain("'received_pence_retained'")});
  it("soft-deletes unpaid planned outgoings with a permanent reason",()=>{expect(sql).toContain("function public.fh_cancel_planned_outgoing");expect(sql).toContain("paid_outgoing_cannot_be_removed");expect(sql).toContain("event_type,source_type,source_id,summary,before_state,after_state,metadata");expect(sql).toContain("'planned_outgoing_cancelled'")});
});
