import { classifyQueryIntent } from "@/lib/email/classify";

export function searchVariants(values: string[]) {
  const variants = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ");
    if (!value) continue;
    variants.add(value);
    const center = value.replace(/\b(?:centre|cente)\b/gi, match => match[0] === "C" ? "Center" : "center");
    const centre = value.replace(/\bcenter\b/gi, match => match[0] === "C" ? "Centre" : "centre");
    variants.add(center); variants.add(centre);
    if (/\border\s+confirmation\b/i.test(value) || /\bconfirm(?:ed|ation)?\s+order\b/i.test(value)) {
      ["order", "your order", "order confirmed", "order received", "thanks for your order", "thank you for your order", "receipt"].forEach(term => variants.add(term));
    }
    for (const item of [...variants]) {
      if (/pokemon/i.test(item)) variants.add(item.replace(/pokemon/gi, match => match[0] === "P" ? "Pokémon" : "pokémon"));
      if (/pokémon/i.test(item)) variants.add(item.replace(/pokémon/gi, match => match[0] === "P" ? "Pokemon" : "pokemon"));
    }
  }
  return [...variants].slice(0, 12);
}

export function canonicalSender(value: string) {
  return value.trim().replace(/\b(?:centre|cente)\b/gi, "center").replace(/\bpokemon\b/gi, "pokémon");
}

// IMAP text matching is literal. Generate a small, bounded set of broad
// sender probes so a one-character typo can still retrieve candidates; final
// relevance validation remains stricter and happens after retrieval.
export function senderSearchVariants(value: string) {
  if (isExactEmailAddress(value)) return [value.trim()];
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);
  const variants = new Set(searchVariants([value]));
  for (const word of words) {
    if (word.length >= 4) variants.add(word.slice(0, Math.min(4, word.length - 1)));
  }
  for (const word of words) {
    const collapsed = word.replace(/(.)\1+/g, "$1");
    if (collapsed !== word) variants.add(collapsed);
  }
  for (const word of words) {
    if (word.length >= 5) for (let index = 0; index < word.length; index += 1) variants.add(word.slice(0, index) + word.slice(index + 1));
  }
  return [...variants].filter(Boolean).slice(0, 12);
}

export function isExactEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function semanticSubjectTerms(values: string[]) {
  const intent = values.join(" ").replace(/\bconformation\b/gi, "confirmation");
  const terms = new Set<string>();
  if (classifyQueryIntent(values) === "sold") ["sold", "you've sold", "you’ve sold", "item sold", "sale completed"].forEach(term => terms.add(term));
  // Shipping/delivery wording is checked before the generic order/purchase
  // and confirmation branches below, so a lifecycle-status question (e.g.
  // "when did my order arrive") keeps its specific "parcel"/"arriving"
  // terms within the bounded result set instead of them being crowded out
  // by the more generic order-confirmation vocabulary that also matches.
  if (/(?:dispatch|shipping|shipped|tracking|on (?:the|its) way|parcel)/i.test(intent)) {
    ["dispatch", "dispatched", "shipping", "shipped", "tracking", "on its way", "order update", "parcel"].forEach(term => terms.add(term));
  }
  if (/(?:deliver|delivery|collected|collection|arriv|expect|parcel)/i.test(intent)) {
    ["delivered", "delivery", "ready for collection", "collected", "arriving", "expecting", "parcel"].forEach(term => terms.add(term));
  }
  if (/\b(?:order|purchase|preorder)\b/i.test(intent)) {
    const orderTerms = /\bconfirm(?:ed|ation)?s?\b/i.test(intent)
      ? ["confirmed", "confirmation", "thank you for", "order received", "order", "purchase", "order details", "receipt"]
      : ["order", "purchase", "preorder", "thank you for", "order confirmed", "order received", "receipt"];
    orderTerms.forEach(term => terms.add(term));
  }
  if (/(?:receipt|invoice|confirmations?|confirmed|proof of purchase)/i.test(intent)) {
    ["confirmed", "confirmation", "thank you for", "receipt", "invoice", "purchase", "order details", "payment received", "payment confirmation", "purchase confirmation", "order"].forEach(term => terms.add(term));
  }
  if (/(?:cancel|cancellation)/i.test(intent)) ["cancelled", "canceled", "cancellation"].forEach(term => terms.add(term));
  if (/(?:refund|refunded|money back)/i.test(intent)) ["refund", "refunded", "money back"].forEach(term => terms.add(term));
  return [...terms].slice(0, 12);
}

export function countSubjectTerms(values: string[]) {
  const confirmationRequest = /\bconfirm(?:ed|ation)?s?\b/i.test(values.join(" "));
  return semanticSubjectTerms(values).filter(term => !confirmationRequest || !["order", "preorder"].includes(term));
}
