export type EmailType = "confirmation" | "sold" | "shipping" | "delivery" | "cancellation" | "refund" | "other";

// Shared lifecycle rules used identically for real subject lines and for the
// user's free-text query wording. Each branch is the union of the two regex
// sets that previously lived separately in lib/email-index/classify.ts and
// lib/yahoo/search-terms.ts, so nothing either one recognized is lost.
// Delivery is checked before shipping: text mentioning both (e.g.
// "dispatched and now out for delivery") is treated as the more specific,
// later lifecycle state.
const lifecyclePatterns: [Exclude<EmailType, "confirmation" | "other">, RegExp][] = [
  ["cancellation", /\b(cancel(?:led|ed|lations?)?|voided)\b/i],
  ["refund", /\b(refund(?:ed|s)?|money back|reimbursement)\b/i],
  ["sold", /\b(you(?:'|’)?ve sold|item sold|sale confirmed|sold an item|solds?|sale made|sales made|items? i sold|my sales)\b/i],
  ["delivery", /\b(deliver(?:ed|y)|arriv(?:e|es|ed|ing)|collect(?:ed|ion))\b/i],
  ["shipping", /\b(shipp(?:ed|ing|ment)|dispatch(?:ed)?|on (?:its|the) way|tracking)\b/i],
];

// A real subject line needs a narrow, phrase-based confirmation signal: bare
// "order"/"purchase" is too common in non-transactional subjects (e.g.
// "Order update", "This order is completed").
const subjectConfirmation = /\b(order .{0,30}confirm(?:ed|ations?)|order(?:\s+[A-Z0-9-]+)?\s+(?:confirm(?:ed|ations?)|received)|(?:your|the) order (?:has been |is )?(?:confirm(?:ed)|received|placed)|thank you for (?:placing )?(?:an |your )?(?:order|preorder)|thanks for (?:placing )?(?:an |your )?(?:order|preorder)|thank you for your purchase|purchase (?:confirm(?:ed|ations?)|receipt)|preorder (?:confirm(?:ed|ations?)|receipt)|order (?:details|summary|receipt)|receipt for|payment receipt|receipt|invoice|payment (?:received|confirmed))\b/i;

// A user's own search wording carries no such ambiguity: saying "purchases"
// or "confirmations" is itself the signal, so the query-intent fallback can
// use the broader bare-keyword form.
const queryConfirmation = /\b(?:receipt|receipts|invoice|invoices|purchase|purchases|order|orders|preorder|preorders|confirmation|confirmations|confirmed)\b/i;

/** Classifies a real email subject line. Used by index sync and per-message count validation. */
export function classifySubject(subject: string): EmailType {
  for (const [type, pattern] of lifecyclePatterns) if (pattern.test(subject)) return type;
  return subjectConfirmation.test(subject) ? "confirmation" : "other";
}

/** Classifies the user's free-text search/query wording, sharing the lifecycle rules above. */
export function classifyQueryIntent(values: string[]): EmailType {
  const value = values.join(" ");
  for (const [type, pattern] of lifecyclePatterns) if (pattern.test(value)) return type;
  return queryConfirmation.test(value) ? "confirmation" : "other";
}

export function extractMetadata(subject: string) {
  const orderReference = subject.match(/\b(?:order|ref(?:erence)?)\s*(?:number|no\.?|#|:|-)?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i)?.[1] || null;
  const money = subject.match(/(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i);
  return { order_reference: orderReference, amount: money ? Number(money[1]) : null, currency: money ? "GBP" : null };
}

export function entityFromSender(name: string | null, email: string | null) {
  if (name?.trim()) return normalizeEntity(name);
  const domain = email?.split("@")[1]?.split(".")[0];
  return domain ? normalizeEntity(domain.replace(/[-_]+/g, " ")) : null;
}

function normalizeEntity(value: string) { return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\bcentre\b/gi, "center").trim().toLowerCase(); }

export function isPurchaseConfirmationSubject(subject: string) {
  return classifySubject(subject) === "confirmation";
}

export function isPurchaseLifecycleSubject(subject: string) {
  const type = classifySubject(subject);
  return type === "shipping" || type === "delivery" || type === "cancellation" || type === "refund" || type === "sold";
}

// This gate is intentionally looser than isPurchaseConfirmationSubject: it
// decides whether a bulk mailbox scan should fetch a message body at all,
// not whether the message is confirmed as a purchase receipt. Kept as its
// own regex (not derived from classifySubject) so scan volume during Vinted
// import does not change.
const reversalOrLifecycle = /\b(cancel(?:led|ed|lation)?|refund(?:ed)?|return(?:ed)?|shipp(?:ed|ing|ment)|dispatch(?:ed)?|tracking|on (?:its|the) way|out for delivery|deliver(?:ed|y)|arriv(?:ed|ing)|ready for collection|payment is being sent|payout|order update|order (?:is )?complete(?:d)?)\b/i;

export function isPurchaseCandidateSubject(subject: string) {
  return !reversalOrLifecycle.test(subject) && /\b(order|purchase|preorder|receipt|invoice|payment)\b/i.test(subject);
}

/** Named-retailer imports inspect every matching message body; broad mailbox
 * imports retain a conservative header shortlist to avoid reading unrelated mail. */
export function shouldInspectPurchaseHeader(subject: string, namedRetailer: boolean) {
  return namedRetailer || isPurchaseCandidateSubject(subject);
}
