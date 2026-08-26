import type { OrderEventType, OrderItem, OrderStatus, ReconstructedOrder } from "./model";

/**
 * The browser-facing shape of a reconstructed order. Deliberately narrower
 * than ReconstructedOrder: `confidence` (an internal grouping-quality
 * signal) and `sourceEmails`/each timeline event's `sourceEmailId` (internal
 * linkage back to specific emails, not needed by this phase's UI) never
 * leave the server. If a future phase needs to let the UI jump from an
 * order card to its supporting emails, add that back deliberately then —
 * don't widen this DTO by accident.
 */
export type PublicOrderEvent = { type: OrderEventType; date: string | null };

export type PublicOrder = {
  orderId: string | null;
  merchant: string;
  purchaseDate: string | null;
  status: OrderStatus;
  isPreorder: boolean;
  items: OrderItem[];
  trackingNumbers: string[];
  purchaseAmount: number | null;
  refundAmount: number | null;
  currency: string | null;
  paymentCards: string[];
  recipientName: string | null;
  notes: string[];
  timeline: PublicOrderEvent[];
};

export function toPublicOrder(order: ReconstructedOrder): PublicOrder {
  return {
    orderId: order.orderId,
    merchant: order.merchant,
    purchaseDate: order.purchaseDate,
    status: order.status,
    isPreorder: order.isPreorder,
    items: order.items,
    trackingNumbers: order.trackingNumbers,
    purchaseAmount: order.purchaseAmount,
    refundAmount: order.refundAmount,
    currency: order.currency,
    paymentCards: order.paymentCards,
    recipientName: order.recipientName,
    notes: order.notes,
    timeline: order.timeline.map(event => ({ type: event.type, date: event.date })),
  };
}
