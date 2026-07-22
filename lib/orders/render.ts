import { excerpt } from "@/lib/yahoo/sanitize";
import { aggregateRefundTotals } from "./aggregate";
import type { OrderEventType, OrderSourceEmail, OrderStatus, ReconstructedOrder } from "./model";

const EVENT_LABELS: Record<OrderEventType, string> = {
  ordered: "Ordered", confirmed: "Confirmed", dispatched: "Dispatched", out_for_delivery: "Out for delivery",
  delivered: "Delivered", cancelled: "Cancelled", returned: "Returned", refund_processed: "Refund processed", sold: "Sold",
};
const STATUS_LABELS: Record<OrderStatus, string> = { ...EVENT_LABELS, unknown: "Unknown" };

export function formatMoney(amount: number, currency: string): string {
  const formatted = amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "GBP" ? `£${formatted}` : `${currency} ${formatted}`;
}

/**
 * A short, deterministic "Total refunded: £X" line per currency, computed
 * from aggregateRefundTotals — meant to be appended directly to the
 * user-facing answer (not just left as prompt evidence for Claude to
 * optionally restate), so the exact figure is guaranteed to reach the
 * response rather than depending on the model choosing to repeat it.
 * Returns null when no order has a refund amount.
 */
export function formatRefundTotalsSummary(orders: ReconstructedOrder[]): string | null {
  const totals = aggregateRefundTotals(orders);
  if (!totals.length) return null;
  return totals.map(t => `Total refunded: ${formatMoney(t.total, t.currency)}`).join("\n");
}

/**
 * Formats reconstructed orders for the synthesis prompt: each order's
 * derived structure (merchant, status, timeline, items, tracking, refund)
 * first, followed by its raw source-email content, so Claude reasons from
 * pre-grouped orders but can still cross-check anything the regex-based
 * extraction missed. `confidence` is deliberately never included here — it
 * is an internal signal (see lib/orders/model.ts), not something synthesis
 * should reason from.
 *
 * A deterministically computed refund-total block is appended when any
 * order has a refund amount, grouped by currency (see
 * lib/orders/aggregate.ts) — presented as already-calculated evidence so
 * synthesis reports it rather than re-deriving it via free-text arithmetic.
 */
export function renderOrdersForSynthesis(orders: ReconstructedOrder[], emailsById: Map<string, OrderSourceEmail>, rawExcerptLength = 700): string {
  const orderBlocks = orders.map((order, index) => {
    const header = [
      `Order ${index + 1}${order.orderId ? ` (Ref: ${order.orderId})` : ""}`,
      `Merchant: ${order.merchant}`,
      `Status: ${STATUS_LABELS[order.status]}`,
      order.purchaseDate ? `Purchase date: ${order.purchaseDate}` : null,
    ].filter(Boolean).join("\n");
    const timeline = order.timeline.length
      ? `Timeline:\n${order.timeline.map(event => `- ${EVENT_LABELS[event.type]}${event.date ? ` (${event.date})` : ""}`).join("\n")}`
      : "Timeline: no dated lifecycle events found.";
    const meta = [
      // Kept in sync with the card badge (see lib/orders/view.ts's
      // statusBadge, which shows "Pre-order" instead of "Ordered" from this
      // same flag) so Claude's narrative never contradicts what the
      // structured card displays.
      order.isPreorder ? "Pre-order: yes" : null,
      order.items.length ? `Items: ${order.items.map(item => `${item.quantity} x ${item.name}`).join(", ")}` : null,
      order.trackingNumbers.length ? `Tracking: ${order.trackingNumbers.join(", ")}` : null,
      order.paymentCards.length ? `Payment card${order.paymentCards.length === 1 ? "" : "s"}: ${order.paymentCards.map(card => `ending ${card}`).join(", ")}` : null,
      order.recipientName ? `Recipient: ${order.recipientName}` : null,
      // Kept as two distinct, separately labelled fields — never merge them
      // into one generic "amount". A refund being known does not mean the
      // purchase price is known, and vice versa; conflating them is exactly
      // what previously led to answers claiming "no pricing information
      // exists" when a refund amount was in fact known.
      order.purchaseAmount !== null && order.currency !== null ? `Purchase price: ${formatMoney(order.purchaseAmount, order.currency)}` : null,
      order.refundAmount !== null && order.currency !== null ? `Refund amount: ${formatMoney(order.refundAmount, order.currency)}` : null,
      order.notes.length ? `Notes: ${order.notes.join(" ")}` : null,
    ].filter(Boolean).join("\n");
    const rawEmails = order.sourceEmails
      .map(id => emailsById.get(id))
      .filter((email): email is OrderSourceEmail => Boolean(email))
      .map((email, emailIndex) => `  Source email ${emailIndex + 1}:\n  From: ${email.sender}\n  Date: ${email.date || "Unknown"}\n  Subject: ${email.subject}\n  Content: ${excerpt(email.text || email.html, rawExcerptLength)}`)
      .join("\n\n");
    return [header, timeline, meta, rawEmails].filter(Boolean).join("\n");
  });

  const totals = aggregateRefundTotals(orders);
  const totalsBlock = totals.length
    ? `Computed totals (already calculated deterministically from the orders above — report these exactly; never recompute or combine amounts across different currencies):\n${totals.map(t => `- Total refunded (${t.currency}): ${formatMoney(t.total, t.currency)} across ${t.orderCount} order${t.orderCount === 1 ? "" : "s"}`).join("\n")}`
    : null;

  return [...orderBlocks, totalsBlock].filter((block): block is string => Boolean(block)).join("\n\n---\n\n");
}
