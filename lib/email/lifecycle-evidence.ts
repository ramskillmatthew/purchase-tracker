import type { EmailType } from "./classify";

// Evidence that an email is somewhere in the forward order lifecycle
// (confirmed -> dispatched -> tracked -> delivered/collected). Shared between
// the shipping and delivery types since people use "delivery"/"shipping"/
// "parcel"/"arriving" wording interchangeably to mean "where's my stuff",
// regardless of which exact lifecycle stage the retailer's subject line
// happens to name.
export const FORWARD_LIFECYCLE_EVIDENCE = /\b(?:dispatch|dispatched|shipping|shipped|tracking|on (?:the|its) way|delivered|delivery|ready for collection|collected|parcel|expect(?:ing|ed)?|will arrive|arriving|arrived)\b/i;

// Retailers are legally required (UK Consumer Contracts Regulations) to
// disclose cancellation/refund rights in ordinary order confirmations, so a
// bare "cancelled"/"cancellation"/"refund" keyword match is unreliable — it
// fires on every confirmation email's standard T&C footer, not just genuine
// cancellation/refund notifications. The fix is to primarily match on an
// actual event/state/action having occurred (who did what, in what tense),
// which structurally does not overlap with policy/rights disclosure
// phrasing ("right to cancel", "cancellation policy", "eligible for a
// refund", ...). A bare-keyword check is kept only as a secondary,
// lower-confidence fallback for genuine phrasing this doesn't anticipate,
// and it alone — never the action patterns — is the thing the boilerplate
// exclusion guards, so a real cancellation email that also happens to
// mention generic policy text elsewhere is never wrongly vetoed.
const CANCELLATION_ACTION = /(?:has|have|had)\s+been\s+cancell?ed|(?:is|are|was|were)\s+(?:being\s+)?cancell?ed|being\s+cancell?ed|will\s+be\s+cancell?ed|we\s+cancell?ed|we(?:'|’|\s)?ve\s+cancell?ed|we\s+have\s+cancell?ed|cancell?ed\s+your\s+order|\border\s+cancell?ed\b|\bitem\s+cancell?ed\b|cancellation\s+confirm(?:ed|ation)|will\s+not\s+be\s+fulfilled|won(?:'|’|\s)?t\s+be\s+fulfilled|(?:can\s*not|cannot)\s+be\s+fulfilled/i;
const CANCELLATION_KEYWORD = /\b(?:cancelled|canceled|cancellation|voided)\b/i;
const CANCELLATION_BOILERPLATE = /\b(?:right to cancel|cancellation (?:policy|rights?|period)|cooling[- ]off period|consumer contracts? regulations|(?:instructions? on )?how to cancel)\b/i;

const REFUND_ACTION = /(?:has|have|had)\s+been\s+refunded|(?:is|are|was|were)\s+refunded|refund(?:ed)?\s+(?:has\s+been\s+|was\s+)?processed|refund\s+confirm(?:ed|ation)|we\s+refunded|we(?:'|’|\s)?ve\s+refunded|we\s+have\s+refunded|we(?:'|’|\s)?ve\s+issued\s+(?:a|your)\s+refund|we\s+have\s+issued\s+(?:a|your)\s+refund|issued\s+(?:a|your)\s+refund|[£$€]\s?\d+(?:\.\d{2})?\s+(?:has\s+been\s+)?refunded|refunded\s+[£$€]\s?\d+/i;
const REFUND_KEYWORD = /\b(?:refund|refunds|refunded|money back|reimbursement)\b/i;
const REFUND_BOILERPLATE = /\b(?:refund polic(?:y|ies)|right to a refund|eligible for a refund|refund eligib\w*|how to request a refund|refunds? may take)\b/i;

// Callers may pass either raw text or text already run through a normalizer
// that strips punctuation to spaces (e.g. "you've" -> "you ve"), so the
// apostrophe in "you've sold" is optional and may be a literal space.
const SOLD_EVIDENCE = /\b(?:you(?:'|’|\s)?ve sold|sold an? item|item sold|sale completed|sale confirmed)\b/i;
const CONFIRMATION_EVIDENCE = /\b(receipt|invoice|payment (?:has been )?(?:received|confirmed)|purchase confirmation|order confirmation|order (?:has been )?(?:confirmed|received|placed)|(?:we(?: ve)?|we have) (?:got|received) your order|thank you for (?:placing )?(?:an? )?order|thanks for (?:placing )?(?:an? )?order|order details|date ordered|paid|total paid|proof of purchase)\b/i;

function hasCancellationEvidence(content: string): boolean {
  if (CANCELLATION_ACTION.test(content)) return true;
  return CANCELLATION_KEYWORD.test(content) && !CANCELLATION_BOILERPLATE.test(content);
}

function hasRefundEvidence(content: string): boolean {
  if (REFUND_ACTION.test(content)) return true;
  return REFUND_KEYWORD.test(content) && !REFUND_BOILERPLATE.test(content);
}

/**
 * Whether subject+body content contains real evidence of a given lifecycle
 * type. Used so a generic subject line (e.g. "Order update") whose actual
 * event (cancelled, refunded, delivered...) is only stated in the body still
 * counts as a real match — the single source of truth shared by the search
 * path's relevance filtering and the count path's verification, so the two
 * cannot drift back out of sync the way they did before.
 */
export function matchesLifecycleEvidence(type: EmailType, content: string): boolean {
  if (type === "cancellation") return hasCancellationEvidence(content);
  if (type === "refund") return hasRefundEvidence(content);
  if (type === "sold") return SOLD_EVIDENCE.test(content);
  if (type === "shipping" || type === "delivery") return FORWARD_LIFECYCLE_EVIDENCE.test(content);
  if (type === "confirmation") return CONFIRMATION_EVIDENCE.test(content) || FORWARD_LIFECYCLE_EVIDENCE.test(content) || /\border\b/i.test(content);
  return true;
}
