import { createHash } from "node:crypto";
import { z } from "zod";
import { isPurchaseConfirmationSubject } from "@/lib/email/classify";

const candidateSchema = z.object({
  yahoo_message_id: z.string().min(1), email_date: z.string().datetime(), sender: z.string().min(1), subject: z.string().min(1),
  order_reference: z.string().nullable(), item_title: z.string().nullable(), seller_name: z.string().nullable(), item_size: z.string().nullable(),
  price_paid: z.number().nonnegative().nullable(), purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), dispatch_status: z.string().nullable(),
  delivery_status: z.string().nullable(), cancellation_refund_status: z.string().nullable(), parser_confidence: z.number().min(0).max(1), fingerprint: z.string().length(64),
  sanitized_excerpt: z.string().max(500), purchased_from: z.string().min(1).max(100), candidate_type: z.literal("general"), uncertainty_reasons: z.array(z.string()).max(10),
}).strict();
export type GeneralPurchaseCandidate = z.infer<typeof candidateSchema>;

function first(text: string, patterns: RegExp[]) { for (const pattern of patterns) { const value = text.match(pattern)?.[1]?.trim(); if (value) return value.replace(/\s+/g, " "); } return null; }
function itemFromStructuredSection(text: string) {
  const section = text.match(/(?:order summary|order details|invoice details|description|your items?)\s*\n([\s\S]{0,3000})/i)?.[1];
  if (!section) return null;
  const rejected = /^(?:item|product|description|quantity|qty|price|amount|subtotal|shipping|delivery|discount|tax|vat|total|order|invoice|payment|billing|address|date)\b/i;
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 3 || line.length > 180 || rejected.test(line) || /^(?:£|GBP|\d+[.,]?\d*)$/i.test(line)) continue;
    if (/[a-z]{3}/i.test(line)) return line.replace(/\s+(?:£|GBP)\s*\d[\d,.]*.*$/i, "").trim();
  }
  return null;
}
function retailer(sender: string) {
  const name = sender.match(/^([^<]+)</)?.[1]?.trim(); if (name && !/^(no.?reply|orders?|customer service)$/i.test(name)) return name;
  const domain = sender.match(/@([a-z0-9-]+)\./i)?.[1]; return domain ? domain.replace(/[-_]+/g, " ").replace(/\b\w/g, value => value.toUpperCase()) : "Unknown retailer";
}

export function parseGeneralPurchaseEmail(email: { messageId: string | null; sender: string; subject: string; date: string | null; text: string }): GeneralPurchaseCandidate | null {
  if (!email.messageId || !email.date) return null;
  const source = `${email.subject}\n${email.text}`.replace(/\u00a0/g, " ");
  if (/\b(cancel(?:led|ed|lation)?|refund(?:ed)?|dispatched|shipped|tracking|on (?:its|the) way|out for delivery|delivered)\b/i.test(email.subject)) return null;
  const subjectEvidence = isPurchaseConfirmationSubject(email.subject);
  const bodyEvidence = /\b(order (?:confirmation|confirmed|details|summary|number)|thank you for (?:placing )?(?:an |your )?order|thank you for your purchase|purchase confirmation|total paid)\b/i.test(email.text);
  const bodyHasReference = /(?:order|reference|confirmation)(?:\s+(?:number|no\.?|id|reference))?\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{3,}/i.test(email.text);
  const bodyHasTotal = /(?:total paid|order total|grand total|total)\s*[:\-]?\s*(?:Â£|£|GBP\s*)\d/i.test(email.text);
  if (!subjectEvidence && !(bodyEvidence && bodyHasReference && bodyHasTotal)) return null;
  const orderReference = first(source, [/(?:order|reference|confirmation)(?:\s+(?:number|no\.?|id|reference))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i]);
  const item = first(source, [/(?:item|product|description)\s*[:\-]\s*([^\n£]{2,200})/i, /order summary\s+([^\n£]{2,200})/i, /thank you for (?:buying|ordering)\s+([^\n£]{2,200})/i]) || itemFromStructuredSection(email.text);
  const size = first(source, [/\bsize\s*[:\-]?\s*([A-Z0-9. /-]{1,30})/i]);
  const amount = first(source, [/(?:total paid|order total|grand total|total)\s*[:\-]?\s*(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i, /(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i]);
  const price = amount ? Number(amount) : null;
  const purchasedFrom = retailer(email.sender);
  const uncertainty = [!item && "Item name could not be extracted.", price === null && "Price could not be extracted.", !orderReference && "No order reference was found.", !size && "No size was found; N/A will be used."].filter((value): value is string => Boolean(value));
  const confidence = Math.max(0.35, Math.min(0.95, 0.55 + (item ? 0.15 : 0) + (price !== null ? 0.15 : 0) + (orderReference ? 0.1 : 0)));
  const purchaseDate = email.date.slice(0, 10);
  const fingerprint = createHash("sha256").update([purchasedFrom, orderReference || "", item || email.subject, price?.toFixed(2) || "", purchaseDate].join("|").toLowerCase()).digest("hex");
  return candidateSchema.parse({ yahoo_message_id: email.messageId, email_date: email.date, sender: email.sender, subject: email.subject, order_reference: orderReference, item_title: item, seller_name: null, item_size: size || "N/A", price_paid: price, purchase_date: purchaseDate, dispatch_status: null, delivery_status: null, cancellation_refund_status: null, parser_confidence: confidence, fingerprint, sanitized_excerpt: email.text.replace(/\s+/g, " ").slice(0, 500), purchased_from: purchasedFrom, candidate_type: "general", uncertainty_reasons: uncertainty });
}
