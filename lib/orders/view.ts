import { aggregatePurchaseTotals, aggregateRefundTotals, type CurrencyTotal } from "./aggregate";
import type { OrderEventType, OrderItem, OrderStatus } from "./model";
import type { PublicOrder, PublicOrderEvent } from "./public";

/**
 * View-layer helpers for reconstructed orders — pure, no `server-only`, safe
 * to import both in `lib/anthropic/assistant.ts` (server) and directly in
 * client components (browser). Operates on `PublicOrder`, the DTO that
 * actually crosses the API boundary, so the exact same functions produce
 * identical results wherever they're called instead of duplicating logic
 * between a server-side summary and a client-side one.
 */

/** The date of the first timeline event of the given type, or null if the
 * order has no such event. Derives "Dispatch date"/"Delivery date"/
 * "Cancellation date" from the single `timeline` source of truth rather
 * than storing them as separate fields that could drift out of sync. */
export function eventDate(events: PublicOrderEvent[], type: OrderEventType): string | null {
  return events.find(event => event.type === type)?.date ?? null;
}

/**
 * Newest purchase date first, matching this app's existing "newest first"
 * convention for email results. Orders with no known purchase date sort
 * last. Generic over any order-shaped object with a `purchaseDate` (not
 * hardcoded to `PublicOrder`) so the exact same sort can run server-side
 * over the internal `ReconstructedOrder[]` — see lib/orders/select.ts's
 * selectRelevantOrders, which needs to select on the internal model
 * (before it's narrowed down to the public DTO) so the caller can still
 * recover which source emails the selected orders came from.
 */
export function sortOrdersChronologically<T extends { purchaseDate: string | null }>(orders: T[]): T[] {
  return [...orders].sort((a, b) => {
    const aTime = a.purchaseDate ? Date.parse(a.purchaseDate) : -Infinity;
    const bTime = b.purchaseDate ? Date.parse(b.purchaseDate) : -Infinity;
    return bTime - aTime;
  });
}

export type DateRange = { earliest: string; latest: string };
export type CurrencyAverage = { currency: string; average: number; orderCount: number };
export type OrderSummary = {
  merchant: string | null; // null when the orders span more than one merchant
  orderCount: number;
  purchasedRange: DateRange | null;
  cancelledRange: DateRange | null;
  purchaseTotals: CurrencyTotal[];
  refundTotals: CurrencyTotal[];
  deliveredCount: number;
  activeCount: number; // still in flight: ordered/confirmed/dispatched/out_for_delivery — not yet delivered, and not reversed
  averageOrderValue: CurrencyAverage[];
};

function dateRangeFor(orders: PublicOrder[], type: OrderEventType): DateRange | null {
  const dates = orders.map(order => eventDate(order.timeline, type)).filter((date): date is string => Boolean(date)).sort();
  if (!dates.length) return null;
  return { earliest: dates[0], latest: dates[dates.length - 1] };
}

// A "resolved" order has reached some final outcome (received, or reversed)
// — anything not in this list is still in flight and counts toward
// activeCount instead.
const RESOLVED_STATUSES: OrderStatus[] = ["delivered", "cancelled", "returned", "refund_processed", "sold", "unknown"];

function averageAmounts(totals: CurrencyTotal[]): CurrencyAverage[] {
  return totals.map(total => ({ currency: total.currency, average: Math.round((total.total / total.orderCount) * 100) / 100, orderCount: total.orderCount }));
}

export function summarizeOrders(orders: PublicOrder[]): OrderSummary {
  const merchants = new Set(orders.map(order => order.merchant));
  const purchaseTotals = aggregatePurchaseTotals(orders);
  return {
    merchant: merchants.size === 1 ? [...merchants][0] : null,
    orderCount: orders.length,
    purchasedRange: dateRangeFor(orders, "ordered"),
    cancelledRange: dateRangeFor(orders, "cancelled"),
    purchaseTotals,
    refundTotals: aggregateRefundTotals(orders),
    deliveredCount: orders.filter(order => order.status === "delivered").length,
    activeCount: orders.filter(order => !RESOLVED_STATUSES.includes(order.status)).length,
    averageOrderValue: averageAmounts(purchaseTotals),
  };
}

export type StatusTone = "ordered" | "dispatched" | "delivered" | "cancelled" | "refunded" | "returned" | "preorder" | "sold" | "unknown";
export type StatusBadge = { label: string; tone: StatusTone };

const STATUS_BADGE: Record<OrderStatus, StatusBadge> = {
  ordered: { label: "Ordered", tone: "ordered" },
  confirmed: { label: "Ordered", tone: "ordered" }, // reserved in the model, not currently emitted — kept for exhaustiveness
  dispatched: { label: "Dispatched", tone: "dispatched" },
  out_for_delivery: { label: "Dispatched", tone: "dispatched" },
  delivered: { label: "Delivered", tone: "delivered" },
  cancelled: { label: "Cancelled", tone: "cancelled" },
  returned: { label: "Returned", tone: "returned" },
  refund_processed: { label: "Refunded", tone: "refunded" },
  sold: { label: "Sold", tone: "sold" },
  unknown: { label: "Unknown", tone: "unknown" },
};

/** Human-readable label for a single timeline event's type — same label
 * vocabulary as statusBadge, reused so a card's event list and its overall
 * status badge never disagree on what to call the same event type. */
export function eventLabel(type: OrderEventType): string {
  return STATUS_BADGE[type].label;
}

/** The colour tone for a single timeline event's type — same tone
 * vocabulary as statusBadge (minus the order-level pre-order override,
 * which only ever applies to the overall badge, not to an individual past
 * event), so a timeline dot's colour always matches what that event type
 * means elsewhere in the UI. */
export function eventTone(type: OrderEventType): StatusTone {
  return STATUS_BADGE[type].tone;
}

/**
 * Per-event display labels for a timeline — identical to eventLabel()
 * except that when an order has more than one event of the same type (a
 * multi-parcel order can genuinely have two separate "dispatched" emails),
 * each is numbered ("Dispatched (1)", "Dispatched (2)") instead of two
 * indistinguishable entries. Presentation only: never changes which events
 * exist, their order, or their dates — see lib/orders/reconstruct.ts, which
 * alone decides that. Generic over every event type, not hardcoded to
 * "dispatched" specifically, since any type could in principle repeat.
 */
export function timelineEventLabels(events: PublicOrderEvent[]): string[] {
  const totalByType = new Map<OrderEventType, number>();
  for (const event of events) totalByType.set(event.type, (totalByType.get(event.type) ?? 0) + 1);
  const seenByType = new Map<OrderEventType, number>();
  return events.map(event => {
    const total = totalByType.get(event.type) ?? 1;
    if (total <= 1) return eventLabel(event.type);
    const seen = (seenByType.get(event.type) ?? 0) + 1;
    seenByType.set(event.type, seen);
    return `${eventLabel(event.type)} (${seen})`;
  });
}

/** Pre-order overrides the "Ordered" badge specifically — it never changes
 * `status` itself (see lib/orders/model.ts), only how it's displayed. */
export function statusBadge(order: PublicOrder): StatusBadge {
  if (order.status === "ordered" && order.isPreorder) return { label: "Pre-order", tone: "preorder" };
  return STATUS_BADGE[order.status];
}

/**
 * Display-only formatting helpers below — deliberately not using
 * `toLocaleString`, whose output depends on the runtime's locale/timezone
 * (unstable across environments and untestable deterministically). Dates
 * throughout this app are stored as UTC ISO strings, so formatting reads UTC
 * components directly, giving every viewer (and every test run) the same
 * output regardless of local timezone.
 */
const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDisplayDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "10 Jul 2026" */
export function formatDisplayDate(value: string | null): string | null {
  const date = parseDisplayDate(value);
  return date ? `${date.getUTCDate()} ${MONTH_ABBREVIATIONS[date.getUTCMonth()]} ${date.getUTCFullYear()}` : null;
}

/** "09:08" */
export function formatDisplayTime(value: string | null): string | null {
  const date = parseDisplayDate(value);
  return date ? `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}` : null;
}

/** "10 Jul 2026, 09:08" */
export function formatDisplayDateTime(value: string | null): string | null {
  const date = formatDisplayDate(value);
  const time = formatDisplayTime(value);
  return date && time ? `${date}, ${time}` : date;
}

export type FormattedRange = { date: string; time: string | null };

/**
 * Collapses a same-calendar-day range down to one date plus a time range
 * (e.g. "10 Jul 2026" / "09:08–09:09") instead of repeating the identical
 * date twice either side of a dash. A range spanning more than one day
 * shows both dates and no time, since a time-of-day comparison across
 * different days isn't meaningful here.
 */
export function formatSummaryRange(range: DateRange | null): FormattedRange | null {
  if (!range) return null;
  const earliestDate = formatDisplayDate(range.earliest);
  if (!earliestDate) return null;
  const latestDate = formatDisplayDate(range.latest);
  if (earliestDate !== latestDate) return { date: `${earliestDate} – ${latestDate}`, time: null };
  const earliestTime = formatDisplayTime(range.earliest);
  const latestTime = formatDisplayTime(range.latest);
  if (!earliestTime || !latestTime) return { date: earliestDate, time: null };
  return { date: earliestDate, time: earliestTime === latestTime ? earliestTime : `${earliestTime}–${latestTime}` };
}

/** "Nike Air Max 95" for quantity 1, "Pokémon Elite Trainer Box ×2" for
 * quantity greater than 1 — a bare "×1" suffix reads as noise, so it's
 * only ever shown once there's a genuine multiple to distinguish. */
export function formatItemLabel(item: OrderItem): string {
  return item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name;
}

export type CappedItemList = { shown: string[]; moreCount: number };

/**
 * Caps a reconstructed order's item list to `limit` entries for display,
 * reporting how many were left out — e.g. three items shown plus
 * "+2 more" for a five-item order — instead of an unbounded list that can
 * dominate the card. Operates purely on already-reconstructed
 * `order.items`, never on raw email text.
 */
export function capItemList(items: OrderItem[], limit: number): CappedItemList {
  return { shown: items.slice(0, limit).map(formatItemLabel), moreCount: Math.max(0, items.length - limit) };
}

/**
 * Title-cases a merchant name for display — the stored `merchant` field is
 * always lowercase (see lib/email/classify.ts's normalizeEntity), which
 * reads poorly for a card heading ("meaco (u.k.) limited"). Capitalizes the
 * first letter of every letter-run (a run being broken by anything that
 * isn't a letter — spaces, parentheses, periods), so both ordinary words
 * ("Meaco", "Limited") and dotted abbreviations ("U.K.") come out correctly
 * without needing a maintained list of known abbreviations.
 */
export function titleCaseMerchant(merchant: string): string {
  let result = "";
  let previousWasLetter = false;
  for (const char of merchant) {
    if (/[a-z]/i.test(char)) {
      result += previousWasLetter ? char.toLowerCase() : char.toUpperCase();
      previousWasLetter = true;
    } else {
      result += char;
      previousWasLetter = false;
    }
  }
  return result;
}
