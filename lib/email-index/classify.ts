export type IndexedEmailType = "confirmation" | "sold" | "shipping" | "delivery" | "cancellation" | "refund" | "other";

const patterns: [IndexedEmailType, RegExp][] = [
  ["cancellation", /\b(cancel(?:led|ed|lation)?|voided)\b/i],
  ["refund", /\b(refund(?:ed)?|money back|reimbursement)\b/i],
  ["sold", /\b(you(?:'|’)?ve sold|item sold|sale confirmed|sold an item)\b/i],
  ["shipping", /\b(shipp(?:ed|ing|ment)|dispatch(?:ed)?|on (?:its|the) way|tracking)\b/i],
  ["delivery", /\b(deliver(?:ed|y)|arriv(?:ed|ing))\b/i],
  ["confirmation", /\b(order .{0,30}confirm(?:ed|ation)|thank you for (?:placing )?(?:an |your )?order|thank you for your purchase|purchase (?:receipt|confirmed)|order (?:details|summary|receipt)|receipt|invoice|payment (?:received|confirmed))\b/i],
];

export function classifyIndexedEmail(subject: string) {
  return patterns.find(([, pattern]) => pattern.test(subject))?.[0] || "other";
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

function normalizeEntity(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\bcentre\b/gi, "center").trim().toLowerCase(); }
