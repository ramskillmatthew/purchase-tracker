import { classifyQueryIntent } from "@/lib/email/classify";
import { FORWARD_LIFECYCLE_EVIDENCE, matchesLifecycleEvidence } from "@/lib/email/lifecycle-evidence";

// Pronouns and instruction words ("they", "them", "who", "list", ...) show up
// naturally in hybrid count+explain phrasing ("what were they for", "list
// them", "who were they from") — none of them ever identify a retailer or
// sender, so they must never survive into an entity/sender string. Query
// text is normalized (accent-stripped, apostrophes collapsed to spaces)
// before this filter runs, so a contraction like "they're"/"they've" arrives
// as two tokens ("they"+"re" / "they"+"ve") — "re"/"ve" are listed too so
// the leftover fragment doesn't leak through as its own bogus entity token,
// alongside the merged "theyre"/"theyve" spellings some clients might send.
const ignored = new Set(["find", "show", "tell", "get", "give", "import", "imports", "importing", "list", "me", "my", "your", "their", "the", "a", "an", "this", "that", "these", "those", "they", "them", "theyre", "theyve", "it", "who", "which", "re", "ve", "most", "recent", "latest", "last", "past", "previous", "ago", "newest", "how", "what", "when", "where", "many", "count", "number", "is", "are", "was", "were", "there", "did", "do", "does", "will", "would", "could", "should", "can", "have", "has", "happened", "status", "history", "story", "whole", "full", "everything", "between", "and", "during", "over", "within", "so", "far", "receive", "received", "email", "emails", "message", "messages", "from", "about", "relating", "related", "to", "for", "in", "containing", "contains", "with", "of", "please", "all", "every", "any", "purchase", "purchases", "order", "orders", "confirmation", "confirmations", "confirmed", "receipt", "receipts", "invoice", "invoices", "sold", "solds", "sale", "sales", "item", "items", "tracking", "delivery", "delivered", "arrive", "arrives", "arriving", "arrived", "dispatch", "dispatched", "shipping", "shipped", "refund", "refunds", "refunded", "return", "returns", "returned", "cancellation", "cancellations", "cancelled", "canceled", "unread", "read", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "day", "days", "week", "weeks", "month", "months", "year", "years", "today", "yesterday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);

function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(?:centre|cente)\b/g, "center").replace(/\bconformation\b/g, "confirmation").replace(/[^a-z0-9@]+/g, " ").trim(); }
export function queryEntityTokens(query: string) { return normalize(query).split(" ").filter(token => token.length > 1 && !ignored.has(token) && !/^\d+(?:st|nd|rd|th)?$/.test(token)).slice(0, 8); }
type SearchResultText = { sender: string; subject: string; excerpt: string };

export function queryRequestsTransaction(query: string) {
  return classifyQueryIntent([normalize(query)]) !== "other";
}

// A request for the whole narrative ("what happened", "tell me about",
// "history of", "whole/full story", "everything about") is fundamentally
// different from a status question or an explicit document request: it
// wants every significant event, including reversals. This is checked
// before intent classification so it overrides every type-specific branch
// below, rather than adding another special case inside them — a broad
// history question never narrows to one lifecycle type.
export const BROAD_HISTORY_QUESTION = /\b(what happened|tell me about|history of|whole story|full story|everything about)\b/i;

function resultMatchesQueryIntent(query: string, result: SearchResultText) {
  const requested = normalize(query);
  if (BROAD_HISTORY_QUESTION.test(requested)) return true;
  const subject = normalize(result.subject);
  const content = normalize(`${result.subject} ${result.excerpt}`);
  const intent = classifyQueryIntent([requested]);

  if (intent === "sold" || intent === "shipping" || intent === "delivery" || intent === "cancellation" || intent === "refund") return matchesLifecycleEvidence(intent, content);

  if (intent === "confirmation") {
    const reversalOnly = /\b(cancelled|canceled|cancellation|refund|refunded|return|returned)\b/;
    const requestedReversal = /\b(cancel|cancelled|canceled|cancellation|refund|refunded|return|returned)\b/.test(requested);
    if (!requestedReversal && reversalOnly.test(subject)) return false;

    const transactionEvidence = /\b(receipt|invoice|payment (?:has been )?(?:received|confirmed)|purchase confirmation|order confirmation|order (?:has been )?(?:confirmed|received|placed)|(?:we(?: ve)?|we have) (?:got|received) your order|thank you for (?:placing )?(?:an? )?order|thanks for (?:placing )?(?:an? )?order|order details|date ordered|paid|total paid|proof of purchase)\b/;

    // An explicit ask for the confirmation/receipt/invoice document itself
    // ("find my order confirmation", "show my invoice") stays narrow to that
    // document — unchanged from before. A generic "my order" question
    // (reached "confirmation" only via the bare-word order/purchase
    // fallback, with no explicit confirmation/receipt/invoice wording) is
    // really a status question about the whole order lifecycle, so it
    // accepts evidence from any forward-lifecycle stage too, not only the
    // confirmation receipt.
    const explicitDocumentRequest = /\b(receipt|invoice|confirmation|confirmations|confirmed)\b/.test(requested);
    if (!explicitDocumentRequest) return transactionEvidence.test(content) || FORWARD_LIFECYCLE_EVIDENCE.test(content) || /\border\b/.test(subject);

    const lifecycleOnly = /\b(shipment|shipped|shipping|dispatch|dispatched|tracking|on (?:the|its) way|out for delivery|due (?:to be )?delivered|delivered|will arrive)\b/;
    const nonTransaction = /\b(account|welcome|sign up|signed up|newsletter)\b/;
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
