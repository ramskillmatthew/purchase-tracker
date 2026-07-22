"use client";
import type { ReactNode } from "react";
import { formatMoney } from "@/lib/orders/render";
import { capItemList, eventDate, eventTone, formatDisplayDateTime, formatItemLabel, formatSummaryRange, sortOrdersChronologically, statusBadge, summarizeOrders, timelineEventLabels, titleCaseMerchant } from "@/lib/orders/view";
import type { PublicOrder, PublicOrderEvent } from "@/lib/orders/public";

// Minimal, monochrome (currentColor) 16x16 stroke icons — no icon library
// dependency for a handful of glyphs. Purely decorative labelling; every
// field still degrades to plain text if the icon is ever removed.
const ICONS = {
  calendar: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>,
  truck: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.5h11v10h-11z" /><path d="M13.5 10.5h4l3 3v3h-7z" /><circle cx="7" cy="18.5" r="1.8" /><circle cx="17" cy="18.5" r="1.8" /></svg>,
  card: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="5.5" width="19" height="13" rx="2.2" /><path d="M2.5 9.5h19" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c1.4-3.8 4.4-5.8 7.5-5.8s6.1 2 7.5 5.8" /></svg>,
} as const;

function Field({ label, value, icon }: { label: string; value: string | null; icon?: keyof typeof ICONS }) {
  if (!value) return null;
  return (
    <div className="order-field">
      <span>{icon && <i className="order-field-icon" aria-hidden="true">{ICONS[icon]}</i>}{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadgeChip({ order }: { order: PublicOrder }) {
  const { label, tone } = statusBadge(order);
  return <span className={`status-badge order-status-${tone}`}><i />{label}</span>;
}

/** Multiple tracking numbers (a multi-parcel order) each get their own
 * line — never comma-joined into one run-on string, which reads as a
 * single garbled value rather than N distinct numbers. */
function TrackingField({ trackingNumbers }: { trackingNumbers: string[] }) {
  if (!trackingNumbers.length) return null;
  if (trackingNumbers.length === 1) return <Field icon="truck" label="Tracking" value={trackingNumbers[0]} />;
  return (
    <div className="order-field order-field-tracking">
      <span><i className="order-field-icon" aria-hidden="true">{ICONS.truck}</i>Tracking</span>
      <ul className="order-tracking-list">{trackingNumbers.map(number => <li key={number}>{number}</li>)}</ul>
    </div>
  );
}

/** Only ever renders events that actually occurred — never invents a
 * missing lifecycle stage to fill out the sequence. Repeated same-type
 * events (e.g. two separate "dispatched" notices for a multi-parcel order)
 * are numbered via timelineEventLabels so they read as distinct entries
 * instead of two indistinguishable "Dispatched" rows. */
function OrderTimeline({ events }: { events: PublicOrderEvent[] }) {
  if (events.length < 2) return null;
  const labels = timelineEventLabels(events);
  return (
    <ol className="order-timeline">
      {events.map((event, index) => (
        <li key={`${event.type}-${index}`}>
          <span className={`order-timeline-dot order-status-${eventTone(event.type)}`} />
          <div>
            <strong>{labels[index]}</strong>
            {formatDisplayDateTime(event.date) && <time>{formatDisplayDateTime(event.date)}</time>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const ITEMS_DISPLAY_LIMIT = 3;

export function OrderCard({ order }: { order: PublicOrder }) {
  const productName = order.items[0] ? formatItemLabel(order.items[0]) : titleCaseMerchant(order.merchant);
  const cappedItems = capItemList(order.items, ITEMS_DISPLAY_LIMIT);
  const purchasePrice = order.purchaseAmount !== null && order.currency ? formatMoney(order.purchaseAmount, order.currency) : null;
  const refundAmount = order.refundAmount !== null && order.currency ? formatMoney(order.refundAmount, order.currency) : null;
  const paymentCards = order.paymentCards.length ? order.paymentCards.map(card => `•••• ${card}`).join(", ") : null;

  return (
    <article className="card order-card">
      <div className="order-card-top">
        <h3 className="order-product-name" title={productName}>{productName}</h3>
        <StatusBadgeChip order={order} />
      </div>

      <div className="order-card-meta">
        <span className="order-merchant">{titleCaseMerchant(order.merchant)}</span>
        {order.orderId && <span className="order-ref">Order {order.orderId}</span>}
      </div>

      <div className="order-fields">
        <Field icon="calendar" label="Purchased" value={formatDisplayDateTime(order.purchaseDate)} />
        <Field icon="calendar" label="Dispatched" value={formatDisplayDateTime(eventDate(order.timeline, "dispatched"))} />
        <Field icon="calendar" label="Delivered" value={formatDisplayDateTime(eventDate(order.timeline, "delivered"))} />
        <Field icon="calendar" label="Cancelled" value={formatDisplayDateTime(eventDate(order.timeline, "cancelled"))} />
        <Field icon="calendar" label="Refunded" value={formatDisplayDateTime(eventDate(order.timeline, "refund_processed"))} />
        <Field icon="user" label="Recipient" value={order.recipientName} />
        <TrackingField trackingNumbers={order.trackingNumbers} />
        <Field label="Purchase price" value={purchasePrice} />
        <Field label="Refund amount" value={refundAmount} />
        <Field icon="card" label={order.paymentCards.length > 1 ? "Payment cards" : "Payment card"} value={paymentCards} />
      </div>

      {order.items.length > 1 && (
        <ul className="order-items">
          {cappedItems.shown.map(label => <li key={label}>{label}</li>)}
          {cappedItems.moreCount > 0 && <li className="order-items-more">+{cappedItems.moreCount} more</li>}
        </ul>
      )}

      {order.notes.length > 0 && (
        <div className="order-notes">{order.notes.map((note, index) => <p key={index}>{note}</p>)}</div>
      )}

      <OrderTimeline events={order.timeline} />
    </article>
  );
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function OrderSummaryPanel({ orders }: { orders: PublicOrder[] }) {
  const summary = summarizeOrders(orders);
  const purchased = formatSummaryRange(summary.purchasedRange);
  const cancelled = formatSummaryRange(summary.cancelledRange);
  // Delivered/active counts and an average order value are only genuinely
  // informative once there's more than one order to distinguish between —
  // for a single order they'd just restate the status badge or the
  // purchase price already shown on the card itself.
  const showCounts = summary.orderCount > 1;
  return (
    <div className="card order-summary">
      {summary.merchant && <SummaryStat label="Merchant" value={titleCaseMerchant(summary.merchant)} />}
      <SummaryStat label="Orders" value={String(summary.orderCount)} />
      {purchased && <SummaryStat label="Purchased" value={purchased.date} sub={purchased.time} />}
      {cancelled && <SummaryStat label="Cancelled" value={cancelled.date} sub={cancelled.time} />}
      {summary.purchaseTotals.map(total => <SummaryStat key={`purchase-${total.currency}`} label="Total purchase value" value={formatMoney(total.total, total.currency)} />)}
      {summary.refundTotals.map(total => <SummaryStat key={`refund-${total.currency}`} label="Total refunded" value={formatMoney(total.total, total.currency)} />)}
      {showCounts && summary.deliveredCount > 0 && <SummaryStat label="Delivered" value={String(summary.deliveredCount)} />}
      {showCounts && summary.activeCount > 0 && <SummaryStat label="Active orders" value={String(summary.activeCount)} />}
      {showCounts && summary.averageOrderValue.map(average => <SummaryStat key={`average-${average.currency}`} label="Average order value" value={formatMoney(average.average, average.currency)} />)}
    </div>
  );
}

/**
 * Always Summary → Cards, whichever number of orders were reconstructed
 * (including exactly one, once lib/orders/select.ts has already narrowed
 * the list down to the single order a query specifically identified) — the
 * caller places Claude's narrative below this (see
 * app/email-assistant/page.tsx).
 */
export function OrderExplorer({ orders }: { orders: PublicOrder[] }): ReactNode {
  if (!orders.length) return null;
  const sorted = sortOrdersChronologically(orders);
  return (
    <>
      <OrderSummaryPanel orders={sorted} />
      <div className="order-cards">
        {sorted.map((order, index) => <OrderCard key={order.orderId ?? `${order.merchant}-${index}`} order={order} />)}
      </div>
    </>
  );
}
