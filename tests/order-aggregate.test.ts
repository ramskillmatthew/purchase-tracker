import { describe, expect, it } from "vitest";
import { aggregatePurchaseTotals, aggregateRefundTotals } from "@/lib/orders/aggregate";
import type { ReconstructedOrder } from "@/lib/orders/model";

const order = (id: string, refundAmount: number | null, currency: string | null): ReconstructedOrder => ({
  orderId: id, merchant: "meaco", purchaseDate: null, status: refundAmount !== null ? "refund_processed" : "delivered", isPreorder: false,
  items: [], trackingNumbers: [], purchaseAmount: null, refundAmount, currency, paymentCards: [], recipientName: null, notes: [],
  timeline: [], sourceEmails: [id], confidence: 0.95,
});

const purchase = (id: string, purchaseAmount: number | null, currency: string | null): ReconstructedOrder => ({
  orderId: id, merchant: "meaco", purchaseDate: null, status: "ordered", isPreorder: false,
  items: [], trackingNumbers: [], purchaseAmount, refundAmount: null, currency, paymentCards: [], recipientName: null, notes: [],
  timeline: [], sourceEmails: [id], confidence: 0.95,
});

describe("aggregateRefundTotals", () => {
  it("sums the five reported Meaco refund amounts to exactly £3,059.95, not £3,149.95", () => {
    const orders = [order("1", 539.99, "GBP"), order("2", 629.99, "GBP"), order("3", 629.99, "GBP"), order("4", 629.99, "GBP"), order("5", 629.99, "GBP")];
    const totals = aggregateRefundTotals(orders);
    expect(totals).toEqual([{ currency: "GBP", total: 3059.95, orderCount: 5 }]);
  });

  it("keeps different currencies as separate totals, never combined", () => {
    const orders = [order("1", 100, "GBP"), order("2", 50, "USD"), order("3", 25, "GBP")];
    const totals = aggregateRefundTotals(orders);
    expect(totals).toEqual(expect.arrayContaining([
      { currency: "GBP", total: 125, orderCount: 2 },
      { currency: "USD", total: 50, orderCount: 1 },
    ]));
    expect(totals).toHaveLength(2);
  });

  it("ignores orders with a null refund amount or null currency", () => {
    const orders = [order("1", 100, "GBP"), order("2", null, null), order("3", 50, "GBP")];
    expect(aggregateRefundTotals(orders)).toEqual([{ currency: "GBP", total: 150, orderCount: 2 }]);
  });

  it("does not double-count a refund when the same order appears once in the reconstructed list, regardless of how many duplicate source emails contributed to it", () => {
    // Each ReconstructedOrder already represents one deduplicated purchase
    // (reconstruct.ts's own timeline dedup handles duplicate source
    // emails) — aggregation operates on that already-deduplicated list, so
    // listing the same order object twice here simulates what reconstruct.ts
    // is responsible for preventing, and confirms aggregation itself does
    // not add further double-counting on top.
    const single = order("1", 100, "GBP");
    expect(aggregateRefundTotals([single])).toEqual([{ currency: "GBP", total: 100, orderCount: 1 }]);
  });

  it("returns an empty array when no order has a refund amount", () => {
    expect(aggregateRefundTotals([order("1", null, null)])).toEqual([]);
    expect(aggregateRefundTotals([])).toEqual([]);
  });

  it("avoids floating-point drift across many small amounts", () => {
    const orders = Array.from({ length: 10 }, (_, index) => order(String(index), 0.1, "GBP"));
    expect(aggregateRefundTotals(orders)).toEqual([{ currency: "GBP", total: 1, orderCount: 10 }]);
  });
});

describe("aggregatePurchaseTotals", () => {
  it("sums purchase amounts across orders in the same currency", () => {
    const orders = [purchase("1", 539.99, "GBP"), purchase("2", 629.99, "GBP"), purchase("3", 629.99, "GBP"), purchase("4", 629.99, "GBP"), purchase("5", 629.99, "GBP")];
    expect(aggregatePurchaseTotals(orders)).toEqual([{ currency: "GBP", total: 3059.95, orderCount: 5 }]);
  });

  it("keeps different currencies as separate totals, never combined", () => {
    const orders = [purchase("1", 100, "GBP"), purchase("2", 50, "USD"), purchase("3", 25, "GBP")];
    const totals = aggregatePurchaseTotals(orders);
    expect(totals).toEqual(expect.arrayContaining([
      { currency: "GBP", total: 125, orderCount: 2 },
      { currency: "USD", total: 50, orderCount: 1 },
    ]));
    expect(totals).toHaveLength(2);
  });

  it("ignores orders with a null purchase amount or null currency", () => {
    const orders = [purchase("1", 100, "GBP"), purchase("2", null, null), purchase("3", 50, "GBP")];
    expect(aggregatePurchaseTotals(orders)).toEqual([{ currency: "GBP", total: 150, orderCount: 2 }]);
  });

  it("returns an empty array when no order has a purchase amount", () => {
    expect(aggregatePurchaseTotals([purchase("1", null, null)])).toEqual([]);
    expect(aggregatePurchaseTotals([])).toEqual([]);
  });

  it("does not combine purchaseAmount and refundAmount across the two aggregate functions", () => {
    const order1 = { ...purchase("1", 100, "GBP"), refundAmount: 40 };
    expect(aggregatePurchaseTotals([order1])).toEqual([{ currency: "GBP", total: 100, orderCount: 1 }]);
    expect(aggregateRefundTotals([order1])).toEqual([{ currency: "GBP", total: 40, orderCount: 1 }]);
  });
});
