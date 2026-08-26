import { entityFromSender } from "@/lib/email/classify";
import type { OrderItem } from "./model";

// Best-effort, regex-based extraction — real-world HTML-table-heavy retailer
// emails will often yield empty results for tracking/items/cards/recipient,
// which is expected and fine; reconstruction degrades gracefully to fewer
// known fields rather than guessing.

// Derived from classify.ts's extractMetadata, with two fixes needed once
// body prose (not just subjects) is scanned:
// 1. A `\b` right after the (order|ref(erence)?) label — without it, the
//    label can prefix-match into an unrelated longer word (e.g. "ref"
//    matching the start of "refunded", capturing "unded").
// 2. The caller requires the captured value to contain a digit (see
//    findReference below) — without that, an ordinary English word right
//    after "order" (e.g. "Order Confirmation") satisfies the character
//    class just as well as a real reference code and gets captured instead.
const ORDER_REFERENCE_PATTERN = /\b(?:order|ref(?:erence)?)\b\s*(?:number|no\.?|#|:|-)?\s*([A-Z0-9][A-Z0-9-]{3,})\b/gi;

function findReference(text: string): string | null {
  for (const match of text.matchAll(ORDER_REFERENCE_PATTERN)) if (/\d/.test(match[1])) return match[1];
  return null;
}
const MONEY_PATTERN = /(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i;
// Label-anchored on purpose: requiring "tracking" nearby avoids matching
// arbitrary alphanumeric substrings (order refs, promo codes) that happen to
// be the right length but have nothing to do with a courier tracking number.
const TRACKING_PATTERN = /\btracking\s*(?:number|no\.?|#|reference|ref)?\s*:?\s*([A-Z0-9]{6,20})\b/i;
const ITEM_LABEL_PATTERN = /(?:^|\n)\s*(?:item|product)s?\s*:\s*(.+)$/im;
const ITEM_QUANTITY_PATTERN = /\b(\d+)\s*x\s+([A-Za-z][\w'’.-]*(?:\s+[A-Za-z][\w'’.-]*){0,6})/g;
// Requires "ending [in]" immediately after the card-type word, mirroring the
// exact phrasing retailers use ("card ending 0428") — retailers never
// include full card numbers, only the last 4, so nothing more sensitive
// than what the retailer itself already chose to display is ever captured.
const PAYMENT_CARD_PATTERN = /\b(?:card|visa|mastercard|amex)\w*\s+ending(?:\s+in)?\s*:?\s*(\d{4})\b/gi;
const RECIPIENT_PATTERN = /\b(?:deliver(?:ing)?\s+to|ship(?:ping)?\s+to|recipient)\s*:?\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})\b/i;
// Phrase-based, not a bare "preorder"/"pre-order" keyword match — a bare
// keyword fires on marketing copy, footer links, and unrelated promotional
// mentions. Every alternative here specifically states that *this order/
// item* is a pre-order, or names a future dispatch/release condition.
const PREORDER_PATTERN = /\byour order is a\s*pre-?order\b|\bthis item is a\s*pre-?order\b|\bpre-?ordered item\b|\bships after\b|\bavailable for dispatch after\b|\brelease date\b/i;

/** Tries the subject first (more reliable — retailers put the order number
 * in the subject far more often than not), falling back to the body. Not
 * normalized for comparison here — callers that group by reference should
 * upper-case/trim themselves. */
export function extractOrderReference(subject: string, body: string): string | null {
  return findReference(subject) || findReference(body);
}

export function extractAmount(content: string): { amount: number | null; currency: string | null } {
  const money = content.match(MONEY_PATTERN);
  return { amount: money ? Number(money[1]) : null, currency: money ? "GBP" : null };
}

/**
 * The captured group can be "eaten" by the label word itself when no real
 * tracking code follows — e.g. a template heading "Tracking Number" or
 * "Tracking information" with no actual number nearby can backtrack into
 * matching "Number"/"information" as if it were the value (the optional
 * label alternation and the value's character class overlap: both accept
 * a bare word). A genuine courier tracking code always contains a digit; a
 * leftover label word never does — same guard already used by
 * extractOrderReference below, for the identical reason.
 */
export function extractTrackingNumbers(content: string): string[] {
  const match = content.match(TRACKING_PATTERN);
  return match && /\d/.test(match[1]) ? [match[1]] : [];
}

export function normalizeItemName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Extracted from a single email's content only — same-named lines found
 * within this one email are summed (a single authoritative email's own
 * separate lines can genuinely be additive), but combining items *across*
 * different emails of the same order is deliberately NOT this function's
 * job — see lib/orders/reconstruct.ts's evidence-priority selection, which
 * decides which email(s) are authoritative and takes the max (never the
 * sum) across them, so the same item mentioned in a confirmation, its
 * cancellation, and its refund notice doesn't triple-count.
 */
export function extractItems(content: string): OrderItem[] {
  const byName = new Map<string, OrderItem>();
  const addItem = (rawName: string, quantity: number) => {
    const name = rawName.trim().slice(0, 200);
    if (!name) return;
    const key = normalizeItemName(name);
    const existing = byName.get(key);
    if (existing) existing.quantity += quantity;
    else byName.set(key, { name, quantity });
  };
  const labelled = content.match(ITEM_LABEL_PATTERN);
  if (labelled) addItem(labelled[1], 1);
  for (const match of content.matchAll(ITEM_QUANTITY_PATTERN)) addItem(match[2], Number(match[1]) || 1);
  return [...byName.values()].slice(0, 5);
}

/** Every distinct card-ending mention, deduped, in order of first
 * appearance — a refund destination differing from the original payment
 * card is real evidence, not noise, so this never stops at the first
 * match. */
export function extractPaymentCards(content: string): string[] {
  const cards = new Set<string>();
  for (const match of content.matchAll(PAYMENT_CARD_PATTERN)) cards.add(match[1]);
  return [...cards];
}

export function extractRecipientName(content: string): string | null {
  return content.match(RECIPIENT_PATTERN)?.[1]?.trim() || null;
}

/** Restricted to confirmation-typed content by the caller (reconstruct.ts)
 * — this function itself just tests whatever text it's given. */
export function looksLikePreorder(content: string): boolean {
  return PREORDER_PATTERN.test(content);
}

/** Splits a display-form sender ("Name <address@example.com>") back into the
 * separate name/address parts entityFromSender expects. */
export function parseSenderDisplay(sender: string): { name: string | null; email: string | null } {
  const match = sender.match(/^(.*?)\s*<([^>]*)>\s*$/);
  if (match) return { name: match[1].trim() || null, email: match[2].trim() || null };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.trim())) return { name: null, email: sender.trim() };
  return { name: sender.trim() || null, email: null };
}

export function extractMerchant(sender: string): string | null {
  const { name, email } = parseSenderDisplay(sender);
  return entityFromSender(name, email);
}
