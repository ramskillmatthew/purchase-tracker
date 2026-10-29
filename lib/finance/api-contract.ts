import type { FinancePendingSale, MarketplacePendingSummary } from "@/lib/finance/pending-sales";
import type { FinancePosition } from "@/lib/finance/types";
import type { FinanceRangePreset } from "@/lib/finance/range";

export type FinanceOverviewResponse = {
  range: { preset: FinanceRangePreset; start: string; end: string };
  position: FinancePosition;
  marketplacePending: MarketplacePendingSummary;
  pendingSales: Array<FinancePendingSale & {
    itemSummary: string;
    expectedDateKind: "exact" | "range" | "unknown";
    expectedDate: string | null;
    expectedRangeStart: string | null;
    expectedRangeEnd: string | null;
  }>;
  manualIncoming: Array<{
    id: string; marketplace: "vinted" | "ebay" | "other"; sourceName: string | null; description: string;
    category: string | null; paymentReference: string | null; amountPence: number; receivedPence: number;
    remainingPence: number; confidence: "confirmed" | "estimated"; dateKind: "exact" | "range" | "unknown";
    expectedDate: string | null; rangeStart: string | null; rangeEnd: string | null; status: string;
  }>;
  accounts: Array<{ id: string; name: string; provider: string; balancePence: number; lastReconciledAt: string | null }>;
  cards: Array<{
    id: string; name: string; provider: string; currentBalancePence: number; businessBalancePence: number;
    personalBalancePence: number; creditLimitPence: number; availableCreditPence: number;
    statementBalancePence: number; statementDate: string | null; paymentDueDate: string | null;
  }>;
  allocations: Array<{ id: string; name: string; accountId: string; balancePence: number; targetPence: number | null; deadline: string | null }>;
  events: Array<{
    id: string;
    kind: "incoming" | "outgoing" | "card_due" | "allocation_deadline";
    title: string;
    detail: string;
    amountPence: number;
    date: string;
    rangeEnd: string | null;
    overdue: boolean;
  }>;
  overdueReminders: Array<{
    id: string;
    kind: "incoming" | "outgoing" | "card_due";
    title: string;
    detail: string;
    amountPence: number;
    date: string;
    rangeEnd: string | null;
    overdue: true;
  }>;
};
