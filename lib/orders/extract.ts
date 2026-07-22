import { entityFromSender } from "@/lib/email/classify";

// Best-effort, regex-based extraction — real-world HTML-table-heavy retailer
// emails will often yield empty results for tracking/items, which is
// expected and fine; reconstruction degrades gracefully to fewer known
// fields rather than guessing.

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
const ITEM_QUANTITY_PATTERN = /\b\d+\s*x\s+([A-Za-z][\w'’.-]*(?:\s+[A-Za-z][\w'’.-]*){0,6})/g;

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

export function extractTrackingNumbers(content: string): string[] {
  const match = content.match(TRACKING_PATTERN);
  return match ? [match[1]] : [];
}

export function extractItems(content: string): string[] {
  const items = new Set<string>();
  const labelled = content.match(ITEM_LABEL_PATTERN);
  if (labelled) items.add(labelled[1].trim().slice(0, 200));
  for (const match of content.matchAll(ITEM_QUANTITY_PATTERN)) items.add(match[1].trim());
  return [...items].slice(0, 5);
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
