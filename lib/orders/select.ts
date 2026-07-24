import { sortOrdersChronologically } from "./view";

/**
 * The minimal shape selectRelevantOrders actually needs — deliberately
 * structural (not `PublicOrder`) so the exact same selection logic runs
 * over the internal `ReconstructedOrder[]` too. This matters for sidebar
 * relevance: `runAssistant` needs to know which *source emails* the
 * selected orders came from, and `sourceEmails` only exists on the
 * internal model, never the public DTO — selecting on the internal orders
 * first (see lib/anthropic/assistant.ts) lets it recover that, then
 * convert to the public DTO afterward, all in one selection pass rather
 * than two that could disagree.
 */
export type SelectableOrder = { orderId: string | null; purchaseAmount: number | null; refundAmount: number | null; paymentCards: string[]; purchaseDate: string | null };

/**
 * An explicit request to compare/summarize multiple orders always wants
 * every reconstructed order shown, full stop — narrowing to one would hide
 * the very orders being compared, regardless of any other wording in the
 * same query (e.g. "compare my last three orders" must show all three, not
 * narrow to the single most recent one).
 */
const STRONG_BROAD_QUESTION = /\b(compare|summari[sz]e)\b/i;

/**
 * Narrative-request phrasing ("tell me about", "what happened", ...) is
 * ambiguous on its own: it usually wants the whole history ("tell me about
 * my Meaco orders"), but the exact same phrasing is just as naturally used
 * for a single item ("tell me about my most recent purchase"). Unlike
 * STRONG_BROAD_QUESTION, this yields to recency wording in the same query —
 * see selectRelevantOrders.
 */
const WEAK_BROAD_QUESTION = /\b(what happened|tell me about|history of|whole story|full story|everything about)\b/i;

// "Most recent"/"latest" wording is a property of an ORDER, not a single
// email — see lib/anthropic/assistant.ts's matchingResults, which
// deliberately never slices the email candidate pool down before
// reconstruction so a purchase's confirmation can't be stranded from its
// later shipment/delivery notice. The equivalent narrowing happens here
// instead, after grouping has already happened, over the fully-reconstructed
// orders.
const RECENCY_QUESTION = /\b(most recent|latest|newest|last)\b/i;

const AMOUNT_PATTERN = /(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i;
const CARD_ENDING_PATTERN = /\b(?:card|visa|mastercard|amex)\w*\s+ending(?:\s+in)?\s*:?\s*(\d{4})\b/i;
const ORDER_REFERENCE_PATTERN = /\b(?:order|ref(?:erence)?)\b\s*(?:number|no\.?|#|:|-)?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i;

function queryOrderReference(message: string): string | null {
  const match = message.match(ORDER_REFERENCE_PATTERN);
  return match && /\d/.test(match[1]) ? match[1].toUpperCase() : null;
}

/**
 * Narrows a reconstructed order list down to the single order a query
 * specifically identifies — an order reference, an exact price, a card
 * ending, or (when nothing more specific matches) recency wording — e.g.
 * "Which Meaco order cost £539.99?" or "tell me about my most recent asos
 * purchase" should each show only one order's card, not every reconstructed
 * order for the merchant. An explicit comparison/summary request always
 * shows every order; narrative-request phrasing ("tell me about", "what
 * happened") does too, unless the same query also carries recency wording,
 * in which case recency wins (see WEAK_BROAD_QUESTION above). A query whose
 * identifier matches zero or more than one order is left completely
 * unfiltered, so this can never hide a genuinely relevant order.
 */
export function selectRelevantOrders<T extends SelectableOrder>(message: string, orders: T[]): T[] {
  if (orders.length <= 1 || STRONG_BROAD_QUESTION.test(message)) return orders;

  const isRecency = RECENCY_QUESTION.test(message);
  if (WEAK_BROAD_QUESTION.test(message) && !isRecency) return orders;

  const reference = queryOrderReference(message);
  if (reference) {
    const matches = orders.filter(order => order.orderId?.toUpperCase() === reference);
    if (matches.length === 1) return matches;
  }

  const amountMatch = message.match(AMOUNT_PATTERN);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    const matches = orders.filter(order => order.purchaseAmount === amount || order.refundAmount === amount);
    if (matches.length === 1) return matches;
  }

  const cardMatch = message.match(CARD_ENDING_PATTERN);
  if (cardMatch) {
    const matches = orders.filter(order => order.paymentCards.includes(cardMatch[1]));
    if (matches.length === 1) return matches;
  }

  if (isRecency) {
    const [mostRecent] = sortOrdersChronologically(orders);
    // A null purchaseDate on the sorted-first order means no order in this
    // list actually has a known purchase date at all — there's nothing
    // genuinely "most recent" to narrow to, so leave every order shown
    // rather than arbitrarily picking one.
    if (mostRecent?.purchaseDate) return [mostRecent];
  }

  return orders;
}
