import { classifyQueryIntent } from "@/lib/email/classify";

const ignored = new Set(["find", "show", "get", "give", "import", "imports", "importing", "me", "my", "the", "a", "an", "this", "that", "these", "those", "most", "recent", "latest", "last", "past", "previous", "ago", "newest", "how", "many", "count", "number", "was", "were", "there", "did", "do", "have", "has", "between", "and", "during", "over", "within", "so", "far", "receive", "received", "email", "emails", "message", "messages", "from", "about", "relating", "related", "to", "for", "in", "containing", "contains", "with", "of", "please", "all", "every", "any", "purchase", "purchases", "order", "orders", "confirmation", "confirmations", "confirmed", "receipt", "receipts", "invoice", "invoices", "sold", "solds", "sale", "sales", "item", "items", "tracking", "delivery", "delivered", "dispatch", "dispatched", "shipping", "shipped", "refund", "refunds", "refunded", "return", "returns", "returned", "cancellation", "cancellations", "cancelled", "canceled", "unread", "read", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "day", "days", "week", "weeks", "month", "months", "year", "years", "today", "yesterday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);

function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(?:centre|cente)\b/g, "center").replace(/\bconformation\b/g, "confirmation").replace(/[^a-z0-9@]+/g, " ").trim(); }
export function queryEntityTokens(query: string) { return normalize(query).split(" ").filter(token => token.length > 1 && !ignored.has(token) && !/^\d+(?:st|nd|rd|th)?$/.test(token)).slice(0, 8); }
type SearchResultText = { sender: string; subject: string; excerpt: string };

export function queryRequestsTransaction(query: string) {
  return classifyQueryIntent([normalize(query)]) !== "other";
}

function resultMatchesQueryIntent(query: string, result: SearchResultText) {
  const requested = normalize(query);
  const subject = normalize(result.subject);
  const content = normalize(`${result.subject} ${result.excerpt}`);
  const intent = classifyQueryIntent([requested]);

  if (intent === "sold") return /\b(?:you ve sold|sold an? item|item sold|sale completed)\b/.test(content);
  if (intent === "shipping") return /\b(?:dispatch|dispatched|shipping|shipped|tracking|on (?:the|its) way)\b/.test(content);
  if (intent === "delivery") return /\b(?:delivered|delivery|ready for collection|collected)\b/.test(content);
  if (intent === "cancellation") return /\b(?:cancelled|canceled|cancellation)\b/.test(content);
  if (intent === "refund") return /\b(?:refund|refunded|money back)\b/.test(content);

  if (intent === "confirmation") {
    const transactionEvidence = /\b(receipt|invoice|payment (?:has been )?(?:received|confirmed)|purchase confirmation|order confirmation|order (?:has been )?(?:confirmed|received|placed)|(?:we(?: ve)?|we have) (?:got|received) your order|thank you for (?:placing )?(?:an? )?order|thanks for (?:placing )?(?:an? )?order|order details|date ordered|paid|total paid|proof of purchase)\b/;
    const lifecycleOnly = /\b(shipment|shipped|shipping|dispatch|dispatched|tracking|on (?:the|its) way|out for delivery|due (?:to be )?delivered|delivered|will arrive)\b/;
    const reversalOnly = /\b(cancelled|canceled|cancellation|refund|refunded|return|returned)\b/;
    const nonTransaction = /\b(account|welcome|sign up|signed up|newsletter)\b/;
    const requestedReversal = /\b(cancel|cancelled|canceled|cancellation|refund|refunded|return|returned)\b/.test(requested);
    if (!requestedReversal && reversalOnly.test(subject)) return false;
    const explicitTransaction = transactionEvidence.test(content);
    const genericOrderSubject = /\border\b/.test(subject) && !lifecycleOnly.test(subject) && !nonTransaction.test(subject);
    if (!explicitTransaction && !genericOrderSubject) return false;

    // Lifecycle notifications can mention an order without being the receipt the user requested.
    if (lifecycleOnly.test(subject) && !/\b(receipt|invoice|payment|confirmed|confirmation|received|placed|order details|date ordered|paid)\b/.test(subject)) return false;
  }
  return true;
}

export function resultMatchesQueryEntity(query: string, result: SearchResultText) {
  const tokens = queryEntityTokens(query);
  const searchable = normalize(`${result.sender} ${result.subject} ${result.excerpt}`);
  const words = searchable.split(" ");
  const distance = (left: string, right: string) => {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      let diagonal = row[0]; row[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const previous = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
        diagonal = previous;
      }
    }
    return row[right.length];
  };
  const tokenMatches = (token: string) => searchable.includes(token) || words.some(word => {
    const allowance = token.length >= 8 ? 2 : token.length >= 4 ? 1 : 0;
    return Math.abs(word.length - token.length) <= allowance && distance(token, word) <= allowance;
  });
  return tokens.every(tokenMatches) && resultMatchesQueryIntent(query, result);
}
