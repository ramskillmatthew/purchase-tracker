import { describe, expect, it } from "vitest";
import type { ReconstructedOrder } from "@/lib/orders/model";
import { toPublicOrder } from "@/lib/orders/public";

const fullOrder: ReconstructedOrder = {
  orderId: "MC-1001",
  merchant: "meaco",
  purchaseDate: "2026-07-01T10:00:00Z",
  status: "refund_processed",
  isPreorder: false,
  items: [{ name: "Dimplex Heater", quantity: 1 }],
  trackingNumbers: ["ABC123XYZ9"],
  purchaseAmount: 539.99,
  refundAmount: 539.99,
  currency: "GBP",
  paymentCards: ["0428"],
  recipientName: "John Smith",
  notes: ["Grouped by timing, not a shared order reference — this pairing is inferred, not certain."],
  timeline: [
    { type: "ordered", date: "2026-07-01T10:00:00Z", sourceEmailId: "email-1" },
    { type: "refund_processed", date: "2026-07-05T10:00:00Z", sourceEmailId: "email-2" },
  ],
  sourceEmails: ["email-1", "email-2"],
  confidence: 0.6,
};

describe("toPublicOrder", () => {
  it("never includes confidence anywhere in its output", () => {
    const publicOrder = toPublicOrder(fullOrder);
    expect(JSON.stringify(publicOrder)).not.toContain("confidence");
    expect(publicOrder).not.toHaveProperty("confidence");
  });

  it("never includes sourceEmails or any timeline event's sourceEmailId", () => {
    const publicOrder = toPublicOrder(fullOrder);
    expect(JSON.stringify(publicOrder)).not.toContain("sourceEmail");
    expect(publicOrder).not.toHaveProperty("sourceEmails");
    for (const event of publicOrder.timeline) expect(event).not.toHaveProperty("sourceEmailId");
  });

  it("carries over every other field unchanged", () => {
    const publicOrder = toPublicOrder(fullOrder);
    expect(publicOrder).toEqual({
      orderId: "MC-1001",
      merchant: "meaco",
      purchaseDate: "2026-07-01T10:00:00Z",
      status: "refund_processed",
      isPreorder: false,
      items: [{ name: "Dimplex Heater", quantity: 1 }],
      trackingNumbers: ["ABC123XYZ9"],
      purchaseAmount: 539.99,
      refundAmount: 539.99,
      currency: "GBP",
      paymentCards: ["0428"],
      recipientName: "John Smith",
      notes: ["Grouped by timing, not a shared order reference — this pairing is inferred, not certain."],
      timeline: [
        { type: "ordered", date: "2026-07-01T10:00:00Z" },
        { type: "refund_processed", date: "2026-07-05T10:00:00Z" },
      ],
    });
  });
});
