import { createHash } from "node:crypto";
import { parsedOrderSchema, type ParsedOrder, type ParsedOrderItem } from "@/lib/purchase-import/types";
import { poundsToPence } from "@/lib/purchase-import/allocate";

function capture(text: string, patterns: RegExp[]) { for (const pattern of patterns) { const match = text.match(pattern); if (match?.[1]) return match[1].trim(); } return null; }

// Vinted's own condition wording, mapped to this app's canonical
// `conditions` enum (lib/validation/purchase.ts). Checked in order —
// "very good" before the bare "good" it contains — and only ever mapped
// when the text confidently matches one of Vinted's known phrases; anything
// else is left `null` for manual review rather than guessed.
const CONDITION_MAP: [RegExp, string][] = [
  [/new with tags|brand new with tags/i, "Brand new"],
  [/new without tags|brand new without tags/i, "Brand new without tags"],
  [/very good/i, "Labelled as very good condition"],
  [/satisfactory/i, "Decent condition from photos"],
  [/\bgood\b/i, "Good condition from photos"],
];
function mapVintedCondition(raw: string | null): string | null {
  if (!raw) return null;
  for (const [pattern, mapped] of CONDITION_MAP) if (pattern.test(raw)) return mapped;
  return null;
}

// A bundle receipt lists more than one "Item <name> £<price>" line — each
// occurrence captured distinctly. A single-item receipt (the common case)
// has at most one such match, and the existing broader title/amount
// capture below is used instead so wording that doesn't fit this exact
// "Item ... £" shape still parses.
const ITEM_LINE_PATTERN = /\bitem\s+([^\n£]{2,150}?)\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)/gi;
function captureItemLines(text: string): { description: string; pricePence: number }[] {
  const items: { description: string; pricePence: number }[] = [];
  for (const match of text.matchAll(ITEM_LINE_PATTERN)) {
    const description = match[1].trim();
    if (!description || /^£?\s*\d/.test(description)) continue;
    items.push({ description, pricePence: poundsToPence(Number(match[2])) });
  }
  return items;
}

// A single item bought more than once in one checkout ("×2", "x 2",
// "Quantity: 2") — distinct from a bundle of different items, which
// captureItemLines handles instead.
const QUANTITY_PATTERN = /(?:qty|quantity)\s*[:\-]?\s*(\d{1,3})\b|[×x]\s*(\d{1,3})\b/i;
function captureQuantity(text: string): number {
  const match = text.match(QUANTITY_PATTERN);
  const value = match ? Number(match[1] || match[2]) : 1;
  return Number.isFinite(value) && value >= 1 && value <= 100 ? value : 1;
}

export function parseVintedEmail(email: { messageId: string | null; sender: string; subject: string; date: string | null; text: string }): ParsedOrder | null {
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
  const seller = capture(source, [/\bseller\s+@?(.+?)\s+order\s+/i, /(?:seller)\s*[:\-]?\s*@?([^\n]{2,100})/i, /(?:sold by)\s*[:\-]\s*@?([^\n]{2,100})/i]);
  const size = capture(source, [/(?:size)\s*[:\-]\s*([^\n]{1,50})/i]);
  const conditionRaw = capture(source, [/(?:condition)\s*[:\-]\s*([^\n]{2,50})/i]);
  const condition = mapVintedCondition(conditionRaw);
  const amount = capture(source, [/(?:paid)\s*[:\-]?\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)/i, /(?:total|price)\s*[:\-]?\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)/i, /£\s*([0-9]+(?:\.[0-9]{1,2})?)/]);
  const totalPaidPence = amount === null ? null : poundsToPence(Number(amount));
  const paymentDate = capture(source, [/payment date\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i]);
  const purchaseDate = paymentDate ? paymentDate.split("/").reverse().join("-") : email.date.slice(0, 10);

  const bundleLines = captureItemLines(source);
  const distinctBundle = new Map<string, { description: string; pricePence: number }>();
  for (const line of bundleLines) { const key = line.description.toLowerCase(); if (!distinctBundle.has(key)) distinctBundle.set(key, line); }
  const bundle = [...distinctBundle.values()];

  // linePricePence must be each item's full LINE total, quantity already
  // folded in (see the CONTRACT note on ParsedOrderItem in types.ts) — every
  // bundle line here is always quantity 1, so its own captured price already
  // IS its line total with no further multiplication needed. If bundle
  // parsing is ever extended to detect a per-line quantity, the captured
  // price must be multiplied by that quantity before being stored here.
  let items: ParsedOrderItem[];
  if (bundle.length > 1) {
    items = bundle.map(line => ({ description: line.description, size, condition, quantity: 1, linePricePence: line.pricePence }));
  } else {
    const title = capture(source, [/your receipt for\s*["“]([^"”]{2,200})["”]/i, /\border\s+(.+?)\s+paid\s+£/i, /^order[ \t]*\r?\n[ \t]*([^\r\n]{2,200})/im, /(?:item|you bought|purchase)\s*[:\-]\s*([^\n]{2,200})/i]) || bundle[0]?.description || null;
    const quantity = captureQuantity(source);
    items = title ? [{ description: title, size, condition, quantity, linePricePence: bundle[0]?.pricePence ?? null }] : [];
  }

  if (!items.length) return null;

  const present = [reference, items[0].description, seller, size, amount].filter(value => value !== null).length;
  const parserConfidence = Math.min(.98, .45 + present * .1);
  const fingerprint = createHash("sha256").update([items[0].description, seller || "", amount || "", purchaseDate].join("|").toLowerCase()).digest("hex");
  const uncertaintyReasons = [
    totalPaidPence === null && "Price could not be extracted.",
    !size && "Size could not be extracted.",
    !condition && "Condition could not be reliably determined; please review.",
  ].filter((value): value is string => Boolean(value));

  return parsedOrderSchema.parse({
    messageId: email.messageId, emailDate: email.date, sender: email.sender, subject: email.subject,
    orderReference: reference, sellerName: seller, purchasedFrom: "Vinted", candidateType: "vinted",
    purchaseDate, dispatchStatus: kind === "dispatched" ? "dispatched" : null, deliveryStatus: kind === "delivered" ? "delivered" : null,
    cancellationRefundStatus: kind === "cancelled" || kind === "refunded" ? kind : null,
    items, totalPaidPence, parserConfidence, fingerprint, sanitizedExcerpt: email.text.slice(0, 500), uncertaintyReasons,
  } satisfies ParsedOrder);
}
