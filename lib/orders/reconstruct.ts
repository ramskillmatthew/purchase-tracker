import { classifySubject, type EmailType } from "@/lib/email/classify";
import { matchesLifecycleEvidence } from "@/lib/email/lifecycle-evidence";
import { extractAmount, extractItems, extractMerchant, extractOrderReference, extractTrackingNumbers } from "./extract";
import type { OrderEvent, OrderEventType, OrderSourceEmail, OrderStatus, ReconstructedOrder } from "./model";

// How long, in days, a reference-less lifecycle email (dispatch/delivery/
// cancellation/refund/return) may attach to the most recently opened,
// still-open order from the same merchant. Not a behavioral tuning value in
// itself — a named constant purely so it can be adjusted later without
// touching the reconstruction logic that uses it.
const ORDER_ASSOCIATION_WINDOW_DAYS = 45;

const EVENT_TYPE_BY_EMAIL_TYPE: Record<Exclude<EmailType, "other">, OrderEventType> = {
  confirmation: "ordered",
  shipping: "dispatched",
  delivery: "delivered",
  cancellation: "cancelled",
  refund: "refund_processed",
  sold: "sold",
};

// A plausible *forward* dispatch/delivery progression. Cancellation, return,
// and refund are reversals and are always a valid continuation of any open
// order regardless of its current stage; nothing else is a valid
// continuation of an already-reversed order (a "dispatched" notice arriving
// after a cancellation almost certainly belongs to a different order).
const FORWARD_STAGE: Partial<Record<OrderEventType, number>> = { ordered: 0, dispatched: 1, out_for_delivery: 2, delivered: 3 };
const REVERSAL_EVENTS: OrderEventType[] = ["cancelled", "returned", "refund_processed"];

function canContinue(lastType: OrderEventType, newType: OrderEventType): boolean {
  if (REVERSAL_EVENTS.includes(newType)) return true;
  if (REVERSAL_EVENTS.includes(lastType)) return false;
  return (FORWARD_STAGE[newType] ?? -1) >= (FORWARD_STAGE[lastType] ?? -1);
}

// classifySubject's own cancellation/refund detection is a bare keyword
// match ("cancellation", "refund") and can false-positive on standard
// policy/rights boilerplate present in an ordinary confirmation or shipping
// email (the exact bug fixed for count verification — see
// lib/email/lifecycle-evidence.ts). Action-based evidence is checked first,
// across subject+body together, and — since matched genuine action evidence
// is unambiguous — takes priority over subject-based classification.
// Everything else (sold/delivery/shipping/confirmation) reuses
// classifySubject directly: subject is authoritative when it fires (a
// subject that clearly says "order confirmed" is not also a cancellation
// notice), body is only consulted when the subject alone is too generic to
// classify, and a cancellation/refund verdict from classifySubject alone
// (without action evidence already having matched above) is not trusted —
// it falls through instead of being reported as a false positive.
function classifyEmail(subject: string, body: string): EmailType {
  const content = `${subject} ${body}`;
  if (matchesLifecycleEvidence("cancellation", content)) return "cancellation";
  if (matchesLifecycleEvidence("refund", content)) return "refund";
  const trustedType = (text: string): EmailType | null => {
    const type = classifySubject(text);
    return type === "cancellation" || type === "refund" || type === "other" ? null : type;
  };
  return trustedType(subject) ?? trustedType(body) ?? "other";
}

type Signals = {
  email: OrderSourceEmail;
  type: EmailType;
  eventType: OrderEventType | null;
  orderReference: string | null;
  merchant: string;
  amount: number | null;
  currency: string | null;
  trackingNumbers: string[];
  items: string[];
};

function extractSignals(email: OrderSourceEmail): Signals {
  const body = email.text || email.html || "";
  const content = `${email.subject} ${body}`;
  const type = classifyEmail(email.subject, body);
  const rawReference = extractOrderReference(email.subject, body);
  const { amount, currency } = extractAmount(content);
  return {
    email, type,
    eventType: type === "other" ? null : EVENT_TYPE_BY_EMAIL_TYPE[type],
    orderReference: rawReference ? rawReference.toUpperCase() : null,
    merchant: extractMerchant(email.sender) || "unknown",
    amount, currency,
    trackingNumbers: extractTrackingNumbers(content),
    items: extractItems(content),
  };
}

function dedupeTimeline(events: OrderEvent[]): OrderEvent[] {
  const seen = new Set<string>();
  const deduped: OrderEvent[] = [];
  for (const event of events) {
    const key = `${event.type}|${event.date || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped.sort((a, b) => Date.parse(a.date || "") - Date.parse(b.date || ""));
}

function buildOrder(group: Signals[], orderId: string | null, confidence: number): ReconstructedOrder {
  const events = group.filter((signal): signal is Signals & { eventType: OrderEventType } => Boolean(signal.eventType))
    .map(signal => ({ type: signal.eventType, date: signal.email.date, sourceEmailId: signal.email.id }));
  const timeline = dedupeTimeline(events);
  const fallbackDates = group.map(signal => signal.email.date).filter((date): date is string => Boolean(date)).sort();
  const purchaseDate = timeline[0]?.date ?? fallbackDates[0] ?? null;
  const status: OrderStatus = timeline.length ? timeline[timeline.length - 1].type : "unknown";
  const items = [...new Set(group.flatMap(signal => signal.items))];
  const trackingNumbers = [...new Set(group.flatMap(signal => signal.trackingNumbers))];
  const refundSignal = group.find(signal => signal.type === "refund" && signal.amount !== null);
  const confirmationSignal = group.find(signal => signal.type === "confirmation" && signal.amount !== null);
  const sourceEmails = [...new Set(group.map(signal => signal.email.id))];
  return {
    orderId, merchant: group[0].merchant, purchaseDate, status, items, trackingNumbers,
    purchaseAmount: confirmationSignal?.amount ?? null,
    refundAmount: refundSignal?.amount ?? null,
    currency: confirmationSignal?.currency ?? refundSignal?.currency ?? null,
    timeline, sourceEmails, confidence,
  };
}

function withinAssociationWindow(openLastDate: string | null, candidateDate: string | null): boolean {
  if (!openLastDate || !candidateDate) return false;
  const diffMs = Math.abs(Date.parse(candidateDate) - Date.parse(openLastDate));
  return Number.isFinite(diffMs) && diffMs <= ORDER_ASSOCIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Groups already-retrieved emails into reconstructed orders. Deterministic
 * and pure — no LLM call, no persistence. Emails sharing an explicit order
 * reference are always grouped together (high confidence). Reference-less
 * emails are grouped per-merchant by a simple, documented heuristic:
 * confirmations always start a new order (never merged with another
 * confirmation — this is what keeps two real, separate orders from the same
 * retailer from bleeding into one), and other lifecycle emails attach to the
 * most recently opened still-open order from that merchant within
 * ORDER_ASSOCIATION_WINDOW_DAYS, or become their own partial-evidence order
 * if none qualifies. This heuristic is a best-effort approximation — without
 * a shared reference number, no purely date-based heuristic can be
 * guaranteed correct if two same-merchant orders' events are adversarially
 * interleaved; it is designed for the realistic case where separate orders'
 * lifecycles don't overlap in time.
 */
export function reconstructOrders(emails: OrderSourceEmail[]): ReconstructedOrder[] {
  const signals = emails.map(extractSignals);
  const orders: ReconstructedOrder[] = [];

  // "sold" emails (Vinted items the user sold, not bought) aren't purchase
  // orders — each becomes its own standalone single-event pseudo-order
  // rather than being forced through the grouping logic below.
  for (const signal of signals.filter(signal => signal.type === "sold")) orders.push(buildOrder([signal], null, 1));

  const referenceGroups = new Map<string, Signals[]>();
  for (const signal of signals.filter(signal => signal.type !== "sold" && signal.orderReference)) {
    const key = `${signal.merchant}|${signal.orderReference}`;
    if (!referenceGroups.has(key)) referenceGroups.set(key, []);
    referenceGroups.get(key)!.push(signal);
  }
  for (const group of referenceGroups.values()) orders.push(buildOrder(group, group[0].orderReference, 0.95));

  const byMerchant = new Map<string, Signals[]>();
  for (const signal of signals.filter(signal => signal.type !== "sold" && signal.type !== "other" && !signal.orderReference)) {
    if (!byMerchant.has(signal.merchant)) byMerchant.set(signal.merchant, []);
    byMerchant.get(signal.merchant)!.push(signal);
  }
  type OpenSlot = { group: Signals[]; lastDate: string | null; lastType: OrderEventType };
  for (const merchantSignals of byMerchant.values()) {
    const sorted = [...merchantSignals].sort((a, b) => Date.parse(a.email.date || "") - Date.parse(b.email.date || ""));
    const openOrders: OpenSlot[] = [];
    for (const signal of sorted) {
      if (!signal.eventType) continue;
      if (signal.type === "confirmation") {
        openOrders.push({ group: [signal], lastDate: signal.email.date, lastType: signal.eventType });
        continue;
      }
      let attachedTo: OpenSlot | null = null;
      for (let index = openOrders.length - 1; index >= 0; index -= 1) {
        const open = openOrders[index];
        if (withinAssociationWindow(open.lastDate, signal.email.date) && canContinue(open.lastType, signal.eventType)) { attachedTo = open; break; }
      }
      if (attachedTo) { attachedTo.group.push(signal); attachedTo.lastDate = signal.email.date; attachedTo.lastType = signal.eventType; }
      else openOrders.push({ group: [signal], lastDate: signal.email.date, lastType: signal.eventType });
    }
    for (const open of openOrders) {
      const isOrphanedSingleReversal = open.group.length === 1 && open.group[0].type !== "confirmation";
      orders.push(buildOrder(open.group, null, isOrphanedSingleReversal ? 0.4 : open.group.length > 1 ? 0.6 : 1));
    }
  }

  return orders;
}
