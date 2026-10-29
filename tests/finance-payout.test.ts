import { describe, expect, it } from "vitest";
import { planMarketplacePayout } from "@/lib/finance/payout";
import type { FinancePendingSale } from "@/lib/finance/pending-sales";

const accountId = "11111111-1111-4111-8111-111111111111";
const pending = (id: string, marketplace: FinancePendingSale["marketplace"] = "vinted", amount = 1500): FinancePendingSale => ({
  salesOrderId: id, marketplace, sourceLabel: marketplace, processStatus: "delivered_awaiting_payout",
  originalRevenuePence: amount, refundedPence: 0, pendingRevenuePence: amount, crossedOutForReturn: false, includedInPendingTotal: true,
});

describe("Finance Hub marketplace payout planning", () => {
  it("combines selected sales into one exact payout", () => {
    const result = planMarketplacePayout({ salesOrderIds: ["a","b"], receivedPence: 3000, accountId, receivedOn: "2026-09-03", paymentReference: "VNT-123" }, [pending("a"), pending("b")]);
    expect(result).toEqual({ ok: true, plan: { marketplace: "vinted", salesOrderIds: ["a","b"], expectedPence: 3000, receivedPence: 3000, variancePence: 0, accountId, receivedOn: "2026-09-03", paymentReference: "VNT-123", varianceExplanation: null } });
  });
  it("requires a permanent explanation for a variance", () => {
    expect(planMarketplacePayout({ salesOrderIds: ["a"], receivedPence: 1470, accountId, receivedOn: "2026-09-03" }, [pending("a")])).toEqual({ ok: false, error: "Explain why the received amount differs from the selected sales total." });
    expect(planMarketplacePayout({ salesOrderIds: ["a"], receivedPence: 1470, accountId, receivedOn: "2026-09-03", varianceExplanation: "Buyer refund" }, [pending("a")])).toMatchObject({ ok: true, plan: { variancePence: -30, varianceExplanation: "Buyer refund" } });
  });
  it("rejects cross-marketplace, duplicate and stale selections", () => {
    expect(planMarketplacePayout({ salesOrderIds: ["a","b"], receivedPence: 3000, accountId, receivedOn: "2026-09-03" }, [pending("a"), pending("b","ebay")])).toMatchObject({ ok: false });
    expect(planMarketplacePayout({ salesOrderIds: ["a","a"], receivedPence: 3000, accountId, receivedOn: "2026-09-03" }, [pending("a")])).toMatchObject({ ok: false });
    expect(planMarketplacePayout({ salesOrderIds: ["missing"], receivedPence: 1500, accountId, receivedOn: "2026-09-03" }, [pending("a")])).toMatchObject({ ok: false });
  });
});

