import { createHash } from "node:crypto";
import { z } from "zod";

export const vintedCandidateSchema = z.object({
  yahoo_message_id: z.string().min(1), email_date: z.string().datetime(), sender: z.string().min(1), subject: z.string().min(1),
  order_reference: z.string().nullable(), item_title: z.string().nullable(), seller_name: z.string().nullable(), item_size: z.string().nullable(),
  price_paid: z.number().nonnegative().nullable(), purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dispatch_status: z.string().nullable(), delivery_status: z.string().nullable(), cancellation_refund_status: z.string().nullable(),
  parser_confidence: z.number().min(0).max(1), fingerprint: z.string().length(64), sanitized_excerpt: z.string().max(500),
}).strict();
export type VintedCandidate = z.infer<typeof vintedCandidateSchema>;

function capture(text: string, patterns: RegExp[]) { for (const pattern of patterns) { const match = text.match(pattern); if (match?.[1]) return match[1].trim(); } return null; }
export function parseVintedEmail(email: { messageId: string | null; sender: string; subject: string; date: string | null; text: string }): VintedCandidate | null {
  const source = `${email.subject}\n${email.text}`;
  const fromVinted = /@(?:email\.)?vinted\.(?:com|co\.uk|fr|de|nl|es|it)/i.test(email.sender) || /\bvinted\b/i.test(email.sender);
  const forwardedReceipt = /your receipt for\s*["“][^"”]+["”]/i.test(email.subject) && /your vinted purchase receipt/i.test(email.text);
  if (!fromVinted && !forwardedReceipt) return null;
  if (!email.date || !email.messageId) return null;
  const buyerReceipt = forwardedReceipt || /your vinted purchase receipt/i.test(source) || /your receipt for\s*["“][^"”]+["”]/i.test(email.subject) || /\b(?:purchase|order) (?:is )?confirmed\b/i.test(email.subject);
  if (!buyerReceipt) return null;
  // Seller-side notifications mention orders and payments too, so exclude them
  // before applying the broader buyer-purchase signals below.
  if (/(?:you(?:'|’)?ve sold an item|your item (?:has )?sold|item sold on vinted|make sure to send (?:the|your) item|ship (?:the|your) item to the buyer)/i.test(source)) return null;
  const kind = /refund|refunded/i.test(source) ? "refunded" : /cancel(?:led|ation)/i.test(source) ? "cancelled" : /deliver(?:ed|y complete)|collected/i.test(source) ? "delivered" : /dispatch|shipped|on its way/i.test(source) ? "dispatched" : /purchase|order|bought|payment/i.test(source) ? "purchase" : null;
  if (!kind) return null;
  const reference = capture(source, [/(?:transaction\s+id)\s*[:#]?\s*([A-Z0-9-]{4,})/i, /(?:order|transaction)(?:\s+(?:number|reference|id))?\s*[:#]?\s*([A-Z0-9-]{4,})/i]);
  const title = capture(source, [/your receipt for\s*["“]([^"”]{2,200})["”]/i, /\border\s+(.+?)\s+paid\s+£/i, /^order[ \t]*\r?\n[ \t]*([^\r\n]{2,200})/im, /(?:item|you bought|purchase)\s*[:\-]\s*([^\n]{2,200})/i]);
  const seller = capture(source, [/\bseller\s+@?(.+?)\s+order\s+/i, /(?:seller)\s*[:\-]?\s*@?([^\n]{2,100})/i, /(?:sold by)\s*[:\-]\s*@?([^\n]{2,100})/i]);
  const size = capture(source, [/(?:size)\s*[:\-]\s*([^\n]{1,50})/i]);
  const amount = capture(source, [/(?:paid)\s*[:\-]?\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)/i, /(?:total|price)\s*[:\-]?\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)/i, /£\s*([0-9]+(?:\.[0-9]{1,2})?)/]);
  const price = amount === null ? null : Number(amount);
  const paymentDate = capture(source, [/payment date\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i]);
  const purchaseDate = paymentDate ? paymentDate.split("/").reverse().join("-") : email.date.slice(0, 10);
  const fingerprint = createHash("sha256").update([title || "", seller || "", price?.toFixed(2) || "", purchaseDate].join("|").toLowerCase()).digest("hex");
  const present = [reference, title, seller, size, price].filter(value => value !== null).length;
  return vintedCandidateSchema.parse({ yahoo_message_id: email.messageId, email_date: email.date, sender: email.sender, subject: email.subject, order_reference: reference, item_title: title, seller_name: seller, item_size: size, price_paid: price, purchase_date: purchaseDate, dispatch_status: kind === "dispatched" ? "dispatched" : null, delivery_status: kind === "delivered" ? "delivered" : null, cancellation_refund_status: kind === "cancelled" || kind === "refunded" ? kind : null, parser_confidence: Math.min(.98, .45 + present * .1), fingerprint, sanitized_excerpt: email.text.slice(0, 500) });
}
