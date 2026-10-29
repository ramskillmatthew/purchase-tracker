import type { FinancePendingSale } from "@/lib/finance/pending-sales";
import type { FinanceMarketplace } from "@/lib/finance/types";

export type ConfirmPayoutInput = {
  salesOrderIds: string[];
  receivedPence: number;
  accountId: string;
  receivedOn: string;
  paymentReference?: string | null;
  varianceExplanation?: string | null;
};

export type PayoutPlan = {
  marketplace: FinanceMarketplace;
  salesOrderIds: string[];
  expectedPence: number;
  receivedPence: number;
  variancePence: number;
  accountId: string;
  receivedOn: string;
  paymentReference: string | null;
  varianceExplanation: string | null;
};

export type PayoutPlanResult = { ok: true; plan: PayoutPlan } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function planMarketplacePayout(input: ConfirmPayoutInput, availableSales: FinancePendingSale[]): PayoutPlanResult {
  const ids = [...new Set(input.salesOrderIds)];
  if (ids.length === 0) return { ok: false, error: "Select at least one pending sale." };
  if (ids.length !== input.salesOrderIds.length) return { ok: false, error: "The same sale was selected more than once." };
  if (!Number.isSafeInteger(input.receivedPence) || input.receivedPence < 0) return { ok: false, error: "Enter a valid received amount." };
  if (!UUID.test(input.accountId)) return { ok: false, error: "Choose the bank account that received this payout." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) return { ok: false, error: "Choose the date the payout arrived." };

  const byId = new Map(availableSales.map(sale => [sale.salesOrderId, sale]));
  const selected = ids.map(id => byId.get(id));
  if (selected.some(sale => !sale || !sale.includedInPendingTotal)) return { ok: false, error: "One or more selected sales are no longer awaiting payout." };
  const sales = selected as FinancePendingSale[];
  const marketplace = sales[0].marketplace;
  if (sales.some(sale => sale.marketplace !== marketplace)) return { ok: false, error: "A combined payout can only contain sales from one marketplace." };

  const expectedPence = sales.reduce((sum, sale) => sum + sale.pendingRevenuePence, 0);
  const variancePence = input.receivedPence - expectedPence;
  const explanation = input.varianceExplanation?.trim() || null;
  if (variancePence !== 0 && !explanation) return { ok: false, error: "Explain why the received amount differs from the selected sales total." };

  return { ok: true, plan: {
    marketplace, salesOrderIds: ids, expectedPence, receivedPence: input.receivedPence, variancePence,
    accountId: input.accountId, receivedOn: input.receivedOn,
    paymentReference: input.paymentReference?.trim() || null, varianceExplanation: explanation,
  } };
}
