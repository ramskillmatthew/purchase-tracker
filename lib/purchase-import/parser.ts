import { createHash } from "node:crypto";
import { isPurchaseConfirmationSubject } from "@/lib/email/classify";
import { parsedOrderSchema, type ParsedOrder, type ParsedOrderItem } from "./types";
import { poundsToPence } from "./allocate";

function first(text: string, patterns: RegExp[]) { for (const pattern of patterns) { const value = text.match(pattern)?.[1]?.trim(); if (value) return value.replace(/\s+/g, " "); } return null; }

/**
 * Scans a structured "order summary"-style section for every qualifying
 * item line (not just the first) — a genuinely multi-item order lists more
 * than one such line, each optionally followed by its own "£<price>" on
 * the same line. Capped at 10 lines as a sanity limit; real invoice tables
 * rarely list more distinct products than that, and it bounds worst-case
 * scan cost.
 */
function itemsFromStructuredSection(text: string): { description: string; pricePence: number | null }[] {
  const section = text.match(/(?:order summary|order details|invoice details|description|your items?)\s*\n([\s\S]{0,3000})/i)?.[1];
  if (!section) return [];
  const rejected = /^(?:item|product|description|quantity|qty|price|amount|subtotal|shipping|delivery|discount|tax|vat|total|order|invoice|payment|billing|address|date)\b/i;
  const items: { description: string; pricePence: number | null }[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 3 || line.length > 180 || rejected.test(line) || /^(?:£|GBP|\d+[.,]?\d*)$/i.test(line)) continue;
    if (!/[a-z]{3}/i.test(line)) continue;
    const priceMatch = line.match(/(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i);
    const description = line.replace(/\s+(?:£|GBP)\s*\d[\d,.]*.*$/i, "").trim();
    if (description) items.push({ description, pricePence: priceMatch ? poundsToPence(Number(priceMatch[1])) : null });
    if (items.length >= 10) break;
  }
  return items;
}

function retailer(sender: string) {
  const name = sender.match(/^([^<]+)</)?.[1]?.trim(); if (name && !/^(no.?reply|orders?|customer service)$/i.test(name)) return name;
  const domain = sender.match(/@([a-z0-9-]+)\./i)?.[1]; return domain ? domain.replace(/[-_]+/g, " ").replace(/\b\w/g, value => value.toUpperCase()) : "Unknown retailer";
}

export function parseGeneralPurchaseEmail(email: { messageId: string | null; sender: string; subject: string; date: string | null; text: string }): ParsedOrder | null {
  if (!email.messageId || !email.date) return null;
  const source = `${email.subject}\n${email.text}`.replace(/\u00a0/g, " ");
  if (/\b(cancel(?:led|ed|lation)?|refund(?:ed)?|dispatched|shipped|tracking|on (?:its|the) way|out for delivery|delivered)\b/i.test(email.subject)) return null;
  const subjectEvidence = isPurchaseConfirmationSubject(email.subject);
  const bodyEvidence = /\b(order (?:confirmation|confirmed|details|summary|number)|thank you for (?:placing )?(?:an |your )?order|thank you for your purchase|purchase confirmation|total paid)\b/i.test(email.text);
  const bodyHasReference = /(?:order|reference|confirmation)(?:\s+(?:number|no\.?|id|reference))?\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{3,}/i.test(email.text);
  const bodyHasTotal = /(?:total paid|order total|grand total|total)\s*[:\-]?\s*(?:Â£|£|GBP\s*)\d/i.test(email.text);
  if (!subjectEvidence && !(bodyEvidence && bodyHasReference && bodyHasTotal)) return null;

  const orderReference = first(source, [/(?:order|reference|confirmation)(?:\s+(?:number|no\.?|id|reference))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i]);
  const size = first(source, [/\bsize\s*[:\-]?\s*([A-Z0-9. /-]{1,30})/i]);
  const amount = first(source, [/(?:total paid|order total|grand total|total)\s*[:\-]?\s*(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i, /(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i]);
  const totalPaidPence = amount ? poundsToPence(Number(amount)) : null;
  const purchasedFrom = retailer(email.sender);
  const purchaseDate = email.date.slice(0, 10);

  // "order summary" is deliberately not matched here — that heading is now
  // handled generically by itemsFromStructuredSection below, which (unlike
  // this single-capture helper) can return more than one item when the
  // section genuinely lists more than one.
  const labelledItem = first(source, [/(?:item|product|description)\s*[:\-]\s*([^\n£]{2,200})/i, /thank you for (?:buying|ordering)\s+([^\n£]{2,200})/i]);
  const structured = itemsFromStructuredSection(email.text);

  let items: ParsedOrderItem[];
  if (labelledItem) {
    items = [{ description: labelledItem, size: size || "N/A", condition: "Brand new", quantity: 1, linePricePence: structured[0]?.pricePence ?? null }];
  } else if (structured.length > 1) {
    items = structured.map(entry => ({ description: entry.description, size: size || "N/A", condition: "Brand new", quantity: 1, linePricePence: entry.pricePence }));
  } else if (structured.length === 1) {
    items = [{ description: structured[0].description, size: size || "N/A", condition: "Brand new", quantity: 1, linePricePence: structured[0].pricePence }];
  } else {
    items = [];
  }
  if (!items.length) return null;

  const uncertainty = [
    totalPaidPence === null && "Price could not be extracted.",
    !orderReference && "No order reference was found.",
    !size && "No size was found; N/A will be used.",
    items.length > 1 && items.some(item => item.linePricePence === null) && "Multiple items were found but not every individual price could be confirmed.",
  ].filter((value): value is string => Boolean(value));
  const confidence = Math.max(0.35, Math.min(0.95, 0.55 + (items[0].description ? 0.15 : 0) + (totalPaidPence !== null ? 0.15 : 0) + (orderReference ? 0.1 : 0)));
  const fingerprint = createHash("sha256").update([purchasedFrom, orderReference || "", items[0].description || email.subject, amount || "", purchaseDate].join("|").toLowerCase()).digest("hex");

  return parsedOrderSchema.parse({
    messageId: email.messageId, emailDate: email.date, sender: email.sender, subject: email.subject,
    orderReference, sellerName: null, purchasedFrom, candidateType: "general", purchaseDate,
    dispatchStatus: null, deliveryStatus: null, cancellationRefundStatus: null,
    items, totalPaidPence, parserConfidence: confidence, fingerprint, sanitizedExcerpt: email.text.replace(/\s+/g, " ").slice(0, 500), uncertaintyReasons: uncertainty,
  } satisfies ParsedOrder);
}
