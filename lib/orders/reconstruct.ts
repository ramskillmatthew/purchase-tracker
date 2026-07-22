import { classifySubject, type EmailType } from "@/lib/email/classify";
import { matchesLifecycleEvidence } from "@/lib/email/lifecycle-evidence";
import { extractAmount, extractItems, extractMerchant, extractOrderReference, extractPaymentCards, extractRecipientName, extractTrackingNumbers, looksLikePreorder, normalizeItemName } from "./extract";
import type { OrderEvent, OrderEventType, OrderItem, OrderSourceEmail, OrderStatus, ReconstructedOrder } from "./model";

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
  return: "returned",
  sold: "sold",
};

// Which lifecycle type's item evidence to trust when no confirmation-typed
// signal has usable items — checked in this order, first non-empty wins.
const ITEM_FALLBACK_PRIORITY: EmailType[] = ["shipping", "delivery", "cancellation", "return", "refund", "sold", "other"];

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
  if (matchesLifecycleEvidence("return", content)) return "return";
  const trustedType = (text: string): EmailType | null => {
    const type = classifySubject(text);
    return type === "cancellation" || type === "refund" || type === "return" || type === "other" ? null : type;
  };
  return trustedType(subject) ?? trustedType(body) ?? "other";
}

type Signals = {
  email: OrderSourceEmail;
  type: EmailType;
  content: string;
  eventType: OrderEventType | null;
  orderReference: string | null;
  merchant: string;
  amount: number | null;
  currency: string | null;
  trackingNumbers: string[];
  items: OrderItem[];
  paymentCards: string[];
  recipientName: string | null;
};

function extractSignals(email: OrderSourceEmail): Signals {
  const body = email.text || email.html || "";
  const content = `${email.subject} ${body}`;
  const type = classifyEmail(email.subject, body);
  const rawReference = extractOrderReference(email.subject, body);
  const { amount, currency } = extractAmount(content);
  return {
    email, type, content,
    eventType: type === "other" ? null : EVENT_TYPE_BY_EMAIL_TYPE[type],
    orderReference: rawReference ? rawReference.toUpperCase() : null,
    merchant: extractMerchant(email.sender) || "unknown",
    amount, currency,
    trackingNumbers: extractTrackingNumbers(content),
    items: extractItems(content),
    paymentCards: extractPaymentCards(content),
    recipientName: extractRecipientName(content),
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

// Merges item evidence from a set of signals ALREADY judged to be the sole
// authoritative source (see selectItems) — across those signals, the max
// quantity per item name wins, never the sum, so e.g. two confirmation
// emails both saying "1 x Product A" read as quantity 1, not 2.
function mergeSignalItems(signals: Signals[]): OrderItem[] {
  const byName = new Map<string, OrderItem>();
  for (const signal of signals) {
    for (const item of signal.items) {
      const key = normalizeItemName(item.name);
      const existing = byName.get(key);
      if (!existing || item.quantity > existing.quantity) byName.set(key, item);
    }
  }
  return [...byName.values()];
}

/**
 * Evidence-priority item selection: confirmation-typed signals are always
 * preferred; only when NONE of them have usable items does it fall through
 * a fixed priority of other lifecycle types, stopping at the first type
 * that has any. Emails of a type that was never selected as authoritative
 * contribute no items at all — this is what prevents the same "1 x Product
 * A" line repeated in a confirmation, its cancellation, and its refund
 * notice from being counted three times: only the confirmation's items are
 * ever used here, in this example.
 */
function selectItems(group: Signals[]): OrderItem[] {
  const confirmationSignals = group.filter(signal => signal.type === "confirmation" && signal.items.length);
  if (confirmationSignals.length) return mergeSignalItems(confirmationSignals);
  for (const type of ITEM_FALLBACK_PRIORITY) {
    const matches = group.filter(signal => signal.type === type && signal.items.length);
    if (matches.length) return mergeSignalItems(matches);
  }
  return [];
}

function buildNotes(confidence: number, purchaseAmount: number | null, refundAmount: number | null): string[] {
  const notes: string[] = [];
  if (confidence < 0.95) notes.push("Grouped by timing, not a shared order reference — this pairing is inferred, not certain.");
  if (confidence <= 0.4) notes.push("No order confirmation was found for this order — evidence is partial.");
  if (purchaseAmount === null && refundAmount !== null) notes.push("Purchase price could not be determined.");
  return notes;
}

function buildOrder(group: Signals[], orderId: string | null, confidence: number): ReconstructedOrder {
  const events = group.filter((signal): signal is Signals & { eventType: OrderEventType } => Boolean(signal.eventType))
    .map(signal => ({ type: signal.eventType, date: signal.email.date, sourceEmailId: signal.email.id }));
  const timeline = dedupeTimeline(events);
  const fallbackDates = group.map(signal => signal.email.date).filter((date): date is string => Boolean(date)).sort();
  const purchaseDate = timeline[0]?.date ?? fallbackDates[0] ?? null;
  const status: OrderStatus = timeline.length ? timeline[timeline.length - 1].type : "unknown";
  const items = selectItems(group);
  const trackingNumbers = [...new Set(group.flatMap(signal => signal.trackingNumbers))];
  const paymentCards = [...new Set(group.flatMap(signal => signal.paymentCards))];
  const recipientName = group.find(signal => signal.recipientName)?.recipientName ?? null;
  const isPreorder = group.some(signal => signal.type === "confirmation" && looksLikePreorder(signal.content));
  const refundSignal = group.find(signal => signal.type === "refund" && signal.amount !== null);
  const confirmationSignal = group.find(signal => signal.type === "confirmation" && signal.amount !== null);
  const sourceEmails = [...new Set(group.map(signal => signal.email.id))];
  const purchaseAmount = confirmationSignal?.amount ?? null;
  const refundAmount = refundSignal?.amount ?? null;
  return {
    orderId, merchant: group[0].merchant, purchaseDate, status, isPreorder, items, trackingNumbers,
    purchaseAmount, refundAmount,
    currency: confirmationSignal?.currency ?? refundSignal?.currency ?? null,
    paymentCards, recipientName,
    notes: buildNotes(confidence, purchaseAmount, refundAmount),
    timeline, sourceEmails, confidence,
  };
}

function withinAssociationWindow(openLastDate: string | null, candidateDate: string | null): boolean {
  if (!openLastDate || !candidateDate) return false;
  const diffMs = Math.abs(Date.parse(candidateDate) - Date.parse(openLastDate));
  return Number.isFinite(diffMs) && diffMs <= ORDER_ASSOCIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

type OpenSlot = { group: Signals[]; lastDate: string | null; lastType: OrderEventType | null; reference: string | null };

// Scans from the most recently active slot backward, matching the same
// "most recently active, still-compatible" preference used throughout this
// heuristic. Shared by the reference-less attachment path and (see
// REVERSAL_EVENTS below) the unmatched-reference reversal fallback, so both
// use exactly the same compatibility rule rather than two copies drifting
// apart.
function findAttachableSlot(openSlots: OpenSlot[], signal: Signals): OpenSlot | null {
  for (let index = openSlots.length - 1; index >= 0; index -= 1) {
    const open = openSlots[index];
    if (open.lastType && signal.eventType && withinAssociationWindow(open.lastDate, signal.email.date) && canContinue(open.lastType, signal.eventType)) return open;
  }
  return null;
}

/**
 * Groups already-retrieved emails into reconstructed orders. Deterministic
 * and pure — no LLM call, no persistence. A single chronological per-merchant
 * pass decides grouping:
 *
 * - A signal carrying an explicit order reference always joins the
 *   already-open slot for that exact reference if one exists (regardless of
 *   date/stage — an unambiguous reference match overrides everything else),
 *   or opens a new referenced slot (confidence 0.95) otherwise.
 * - A reference-less confirmation always starts a new slot (never merges
 *   with another confirmation — this is what keeps two real, separate
 *   orders from the same retailer from bleeding into one).
 * - Any other reference-less lifecycle email (shipment, delivery,
 *   cancellation, refund, return) attaches to the most recently active,
 *   still-compatible open slot from that merchant within
 *   ORDER_ASSOCIATION_WINDOW_DAYS — critically, this includes a slot that
 *   was itself opened by a REFERENCED confirmation, not only reference-less
 *   ones. Without this, a retailer whose shipment/delivery/cancellation
 *   notices don't repeat the order number their confirmation carries (a
 *   very common real-world pattern) would always reconstruct as two
 *   disconnected partial orders — one with item/price detail and no
 *   tracking, the other with tracking and nothing else — even though every
 *   email was fetched. Falls back to its own partial-evidence slot if no
 *   open slot qualifies.
 *
 * This heuristic is a best-effort approximation — without a shared
 * reference number on every email, no purely date-based heuristic can be
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

  const byMerchant = new Map<string, Signals[]>();
  for (const signal of signals.filter(signal => signal.type !== "sold")) {
    if (!byMerchant.has(signal.merchant)) byMerchant.set(signal.merchant, []);
    byMerchant.get(signal.merchant)!.push(signal);
  }

  for (const merchantSignals of byMerchant.values()) {
    const sorted = [...merchantSignals].sort((a, b) => Date.parse(a.email.date || "") - Date.parse(b.email.date || ""));
    const openSlots: OpenSlot[] = [];

    for (const signal of sorted) {
      if (signal.orderReference) {
        const existing = openSlots.find(slot => slot.reference === signal.orderReference);
        if (existing) {
          existing.group.push(signal);
          if (signal.eventType) { existing.lastDate = signal.email.date; existing.lastType = signal.eventType; }
          continue;
        }

        // A reversal-type signal (cancellation/refund/return) carrying a
        // reference that doesn't match any order already open for this
        // merchant is often not the ORIGINAL order number at all —
        // retailers frequently mint a separate refund/case/RMA reference
        // for the reversal itself, and reference extraction has no way to
        // tell that apart from a genuine second order's number. Rather
        // than trust it blindly and split off a disconnected order (a
        // cancelled order's own refund ending up as a second, orphaned
        // "order" with no items, dates, or real status of its own — losing
        // the refund event from the original order's timeline entirely),
        // prefer attaching to whichever already-open, still-compatible
        // order from this merchant is the best match — the same
        // "most recently active, compatible" heuristic reference-less
        // reversal signals already use — and only open a new referenced
        // slot as a last resort. A confirmation, or a forward-stage signal
        // (shipped/delivered), never takes this fallback: an unmatched
        // reference on those is far more likely to be a genuine second
        // order, not a reversal-specific ID.
        if (signal.eventType && REVERSAL_EVENTS.includes(signal.eventType)) {
          const attachedTo = findAttachableSlot(openSlots, signal);
          if (attachedTo) { attachedTo.group.push(signal); attachedTo.lastDate = signal.email.date; attachedTo.lastType = signal.eventType; continue; }
        }

        // An unclassifiable ("other") signal that still carries a reference
        // is grouped too, matching this codebase's existing best-effort
        // philosophy elsewhere — it just never seeds lastType, so it can't
        // itself justify a future reference-less attachment.
        openSlots.push({ group: [signal], lastDate: signal.email.date, lastType: signal.eventType, reference: signal.orderReference });
        continue;
      }

      if (!signal.eventType) continue; // unclassifiable and reference-less — no reliable anchor to attach anywhere

      if (signal.type === "confirmation") {
        openSlots.push({ group: [signal], lastDate: signal.email.date, lastType: signal.eventType, reference: null });
        continue;
      }

      const attachedTo = findAttachableSlot(openSlots, signal);
      if (attachedTo) { attachedTo.group.push(signal); attachedTo.lastDate = signal.email.date; attachedTo.lastType = signal.eventType; }
      else openSlots.push({ group: [signal], lastDate: signal.email.date, lastType: signal.eventType, reference: null });
    }

    for (const slot of openSlots) {
      const isOrphanedSingleReversal = !slot.reference && slot.group.length === 1 && slot.group[0].type !== "confirmation";
      const confidence = slot.reference ? 0.95 : isOrphanedSingleReversal ? 0.4 : slot.group.length > 1 ? 0.6 : 1;
      orders.push(buildOrder(slot.group, slot.reference, confidence));
    }
  }

  return orders;
}
