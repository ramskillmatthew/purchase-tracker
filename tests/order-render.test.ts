import { describe, expect, it } from "vitest";
import { formatRefundTotalsSummary, renderOrdersForSynthesis } from "@/lib/orders/render";
import type { OrderSourceEmail, ReconstructedOrder } from "@/lib/orders/model";

const email = (id: string, sender: string, subject: string, date: string, text = ""): OrderSourceEmail => ({ id, sender, subject, date, text, html: "" });

const baseOrder: ReconstructedOrder = {
  orderId: "MC-1001", merchant: "meaco", purchaseDate: "2026-07-01T10:00:00Z", status: "delivered",
  items: ["Dimplex Heater"], trackingNumbers: ["ABC123XYZ9"], purchaseAmount: null, refundAmount: null, currency: null,
  timeline: [
    { type: "ordered", date: "2026-07-01T10:00:00Z", sourceEmailId: "1" },
    { type: "dispatched", date: "2026-07-02T10:00:00Z", sourceEmailId: "2" },
    { type: "delivered", date: "2026-07-04T10:00:00Z", sourceEmailId: "3" },
  ],
  sourceEmails: ["1", "2", "3"], confidence: 0.95,
};

describe("renderOrdersForSynthesis", () => {
  it("includes the merchant, status, timeline, items, tracking, and order reference", () => {
    const rendered = renderOrdersForSynthesis([baseOrder], new Map());
    expect(rendered).toContain("meaco");
    expect(rendered).toContain("MC-1001");
    expect(rendered).toContain("Delivered");
    expect(rendered).toContain("Ordered");
    expect(rendered).toContain("Dispatched");
    expect(rendered).toContain("Dimplex Heater");
    expect(rendered).toContain("ABC123XYZ9");
  });

  it("never includes the internal confidence score", () => {
    const rendered = renderOrdersForSynthesis([baseOrder], new Map());
    expect(rendered).not.toMatch(/confidence/i);
    expect(rendered).not.toContain("0.95");
  });

  it("includes the refund amount only when present", () => {
    const withRefund = { ...baseOrder, refundAmount: 45, currency: "GBP" as const };
    expect(renderOrdersForSynthesis([withRefund], new Map())).toContain("£45.00");
    expect(renderOrdersForSynthesis([baseOrder], new Map())).not.toContain("Refund amount");
  });

  it("labels purchase price and refund amount as two distinct fields, never merging them", () => {
    const both = { ...baseOrder, purchaseAmount: 629.99, refundAmount: 629.99, currency: "GBP" as const };
    const rendered = renderOrdersForSynthesis([both], new Map());
    expect(rendered).toContain("Purchase price: £629.99");
    expect(rendered).toContain("Refund amount: £629.99");
  });

  it("shows only the refund amount, with no purchase price line, when the purchase price is unknown", () => {
    const refundOnly = { ...baseOrder, purchaseAmount: null, refundAmount: 539.99, currency: "GBP" as const };
    const rendered = renderOrdersForSynthesis([refundOnly], new Map());
    expect(rendered).toContain("Refund amount: £539.99");
    expect(rendered).not.toContain("Purchase price");
  });

  it("includes raw source-email content beneath the order structure", () => {
    const emailsById = new Map([["1", email("1", "Meaco <orders@meaco.com>", "Your Meaco order MC-1001 confirmed", "2026-07-01T10:00:00Z", "Order details here")]]);
    const order = { ...baseOrder, sourceEmails: ["1"], timeline: [baseOrder.timeline[0]] };
    const rendered = renderOrdersForSynthesis([order], emailsById);
    expect(rendered).toContain("Your Meaco order MC-1001 confirmed");
    expect(rendered).toContain("Order details here");
  });

  it("separates multiple orders clearly", () => {
    const second: ReconstructedOrder = { ...baseOrder, orderId: "MC-2002", merchant: "meaco", timeline: [{ type: "ordered", date: "2026-07-05T10:00:00Z", sourceEmailId: "4" }], sourceEmails: ["4"] };
    const rendered = renderOrdersForSynthesis([baseOrder, second], new Map());
    expect(rendered).toContain("Order 1");
    expect(rendered).toContain("Order 2");
    expect(rendered.indexOf("MC-1001")).toBeLessThan(rendered.indexOf("MC-2002"));
  });

  it("handles an order with no timeline events and no order reference gracefully", () => {
    const empty: ReconstructedOrder = { orderId: null, merchant: "unknown", purchaseDate: null, status: "unknown", items: [], trackingNumbers: [], purchaseAmount: null, refundAmount: null, currency: null, timeline: [], sourceEmails: [], confidence: 0.4 };
    expect(() => renderOrdersForSynthesis([empty], new Map())).not.toThrow();
    expect(renderOrdersForSynthesis([empty], new Map())).toContain("Unknown");
  });

  it("returns an empty string for no orders", () => {
    expect(renderOrdersForSynthesis([], new Map())).toBe("");
  });

  describe("computed refund totals", () => {
    const refundedOrders: ReconstructedOrder[] = [
      { ...baseOrder, orderId: "MC-1", refundAmount: 539.99, currency: "GBP", sourceEmails: ["1"] },
      { ...baseOrder, orderId: "MC-2", refundAmount: 629.99, currency: "GBP", sourceEmails: ["2"] },
      { ...baseOrder, orderId: "MC-3", refundAmount: 629.99, currency: "GBP", sourceEmails: ["3"] },
      { ...baseOrder, orderId: "MC-4", refundAmount: 629.99, currency: "GBP", sourceEmails: ["4"] },
      { ...baseOrder, orderId: "MC-5", refundAmount: 629.99, currency: "GBP", sourceEmails: ["5"] },
    ];

    it("appends the deterministically computed total, matching the exact reported values", () => {
      const rendered = renderOrdersForSynthesis(refundedOrders, new Map());
      expect(rendered).toContain("£3,059.95");
      expect(rendered).toContain("across 5 orders");
    });

    it("instructs synthesis to report the total exactly rather than recompute it", () => {
      const rendered = renderOrdersForSynthesis(refundedOrders, new Map());
      expect(rendered).toMatch(/report these exactly/i);
      expect(rendered).toMatch(/never recompute/i);
    });

    it("omits the totals block entirely when no order has a refund amount", () => {
      const rendered = renderOrdersForSynthesis([baseOrder], new Map());
      expect(rendered).not.toContain("Computed totals");
    });

    it("keeps different currencies on separate total lines, never combined", () => {
      const mixed: ReconstructedOrder[] = [
        { ...baseOrder, orderId: "MC-1", refundAmount: 100, currency: "GBP", sourceEmails: ["1"] },
        { ...baseOrder, orderId: "MC-2", refundAmount: 50, currency: "USD", sourceEmails: ["2"] },
      ];
      const rendered = renderOrdersForSynthesis(mixed, new Map());
      expect(rendered).toContain("£100.00");
      expect(rendered).toContain("USD 50.00");
      expect(rendered).not.toContain("150");
    });
  });
});

describe("formatRefundTotalsSummary", () => {
  const baseOrder: ReconstructedOrder = {
    orderId: null, merchant: "meaco", purchaseDate: null, status: "refund_processed", items: [], trackingNumbers: [],
    purchaseAmount: null, refundAmount: null, currency: null, timeline: [], sourceEmails: [], confidence: 0.95,
  };

  it("produces the exact expected user-facing line for the reported Meaco figures", () => {
    const orders: ReconstructedOrder[] = [
      { ...baseOrder, refundAmount: 539.99, currency: "GBP", sourceEmails: ["1"] },
      { ...baseOrder, refundAmount: 629.99, currency: "GBP", sourceEmails: ["2"] },
      { ...baseOrder, refundAmount: 629.99, currency: "GBP", sourceEmails: ["3"] },
      { ...baseOrder, refundAmount: 629.99, currency: "GBP", sourceEmails: ["4"] },
      { ...baseOrder, refundAmount: 629.99, currency: "GBP", sourceEmails: ["5"] },
    ];
    expect(formatRefundTotalsSummary(orders)).toBe("Total refunded: £3,059.95");
  });

  it("returns null when no order has a refund amount", () => {
    expect(formatRefundTotalsSummary([{ ...baseOrder, status: "delivered" }])).toBeNull();
    expect(formatRefundTotalsSummary([])).toBeNull();
  });

  it("emits one line per currency, never combined", () => {
    const orders: ReconstructedOrder[] = [
      { ...baseOrder, refundAmount: 100, currency: "GBP", sourceEmails: ["1"] },
      { ...baseOrder, refundAmount: 50, currency: "USD", sourceEmails: ["2"] },
    ];
    const summary = formatRefundTotalsSummary(orders);
    expect(summary).toContain("Total refunded: £100.00");
    expect(summary).toContain("Total refunded: USD 50.00");
    expect(summary).not.toContain("150");
  });
});
