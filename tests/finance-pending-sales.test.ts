import { describe, expect, it } from "vitest";
import { addManualIncomingToMarketplaceSummary, summariseAllMarketplacePending, summariseMarketplacePending, toFinancePendingSale } from "@/lib/finance/pending-sales";
import type { FinanceSaleInput } from "@/lib/finance/pending-sales";

function sale(overrides: Partial<FinanceSaleInput> = {}): FinanceSaleInput {
  return {
    id: "sale-1", platform: "vinted", custom_platform_name: null, total_revenue: 15,
    status: "completed", process_status: "awaiting_dispatch", cancellation_stock_action: null,
    ...overrides,
  };
}

describe("Finance Hub pending Sales bridge", () => {
  it.each(["awaiting_dispatch", "sent", "delivered_awaiting_payout"] as const)("counts %s using gross Sales revenue", status => {
    expect(toFinancePendingSale(sale({ process_status: status }))).toMatchObject({
      processStatus: status, pendingRevenuePence: 1500, includedInPendingTotal: true, crossedOutForReturn: false,
    });
  });

  it("keeps an active return visible but crossed out and worth zero", () => {
    expect(toFinancePendingSale(sale({ process_status: "return_in_process" }))).toMatchObject({
      pendingRevenuePence: 0, includedInPendingTotal: false, crossedOutForReturn: true,
    });
  });

  it.each(["completed", "cancelled", "returned_cancelled"] as const)("removes %s from the pending surface", status => {
    expect(toFinancePendingSale(sale({ process_status: status, status: status === "completed" ? "completed" : "cancelled" }))).toBeNull();
  });

  it("leaves the unrefunded portion pending", () => {
    expect(toFinancePendingSale(sale({ total_revenue: 100, refundedPence: 2500 }))?.pendingRevenuePence).toBe(7500);
  });

  it("groups Vinted and eBay, while retaining Other source names", () => {
    const rows = [
      toFinancePendingSale(sale()),
      toFinancePendingSale(sale({ id: "sale-2", platform: "vinted" })),
      toFinancePendingSale(sale({ id: "sale-3", platform: "ebay", total_revenue: 20 })),
      toFinancePendingSale(sale({ id: "sale-4", platform: "depop", total_revenue: 30 })),
      toFinancePendingSale(sale({ id: "sale-5", platform: "other", custom_platform_name: "Trade buyer", total_revenue: 40 })),
    ].filter((row): row is NonNullable<typeof row> => row !== null);
    expect(rows[3].sourceLabel).toBe("Depop");
    expect(rows[4].sourceLabel).toBe("Trade buyer");
    expect(summariseMarketplacePending(rows)).toEqual({
      vinted: { marketplace: "vinted", saleCount: 2, pendingRevenuePence: 3000 },
      ebay: { marketplace: "ebay", saleCount: 1, pendingRevenuePence: 2000 },
      other: { marketplace: "other", saleCount: 2, pendingRevenuePence: 7000 },
    });
  });

  it("keeps all unlinked manual amounts exclusively in Other", () => {
    const result = addManualIncomingToMarketplaceSummary(summariseMarketplacePending([]), [
      { marketplace: "other", amountPence: 532_500, receivedPence: 0, refundedPence: 0 },
      { marketplace: "ebay", amountPence: 210_000, receivedPence: 0, refundedPence: 0 },
      { marketplace: "ebay", amountPence: 90_040, receivedPence: 0, refundedPence: 0 },
      { marketplace: "ebay", amountPence: 100_000, receivedPence: 25_000, refundedPence: 5_000 },
    ]);
    expect(result.other).toMatchObject({ pendingRevenuePence: 902_540, saleCount: 4 });
    expect(result.ebay).toMatchObject({ pendingRevenuePence: 0, saleCount: 0 });
  });

  it("uses the same combined total exposed to both Overview and Money In", () => {
    const result = summariseAllMarketplacePending([], [
      { marketplace: "other", remainingPence: 532_500 },
      { marketplace: "ebay", remainingPence: 210_000 },
      { marketplace: "ebay", remainingPence: 90_040 },
    ]);
    expect(result.other).toEqual({ marketplace: "other", pendingRevenuePence: 832_540, saleCount: 3 });
  });
});
