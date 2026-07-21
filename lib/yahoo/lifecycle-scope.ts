import { classifySubject, type EmailType } from "@/lib/email/classify";
import { BROAD_HISTORY_QUESTION } from "@/lib/yahoo/query-relevance";

// A single, explicit document request (e.g. "find my order confirmation",
// "show my invoice") stays scoped to exactly that type. A status/lifecycle
// question ("did my order arrive?", "where is my order?", "what's the
// status of my order?") is really asking across the whole forward order
// narrative, so it should retrieve confirmation, shipping, and delivery
// together instead of excluding two of the three via one equality filter.
// Cancellation/refund/sold stay their own narrow types either way — they
// are a different outcome, not another stage of the same forward story.
const FORWARD_LIFECYCLE_TYPES: EmailType[] = ["confirmation", "shipping", "delivery"];
const explicitDocumentRequest = /\b(receipt|invoice|confirmation|confirmations|confirmed)\b/i;

// A broad-history question ("what happened with my order", "tell me about
// my Meaco orders") wants every significant event, including reversals —
// unlike a status question it must not stop at the forward lifecycle types,
// so the indexed path applies no type filter at all here, same as the live
// IMAP path's BROAD_HISTORY_QUESTION bypass in query-relevance.ts.
export function lifecycleTypeFilter(intent: EmailType, message: string): EmailType | EmailType[] | undefined {
  if (BROAD_HISTORY_QUESTION.test(message)) return undefined;
  if (intent === "other") return undefined;
  if (intent === "shipping" || intent === "delivery") return FORWARD_LIFECYCLE_TYPES;
  if (intent === "confirmation" && !explicitDocumentRequest.test(message)) return FORWARD_LIFECYCLE_TYPES;
  return intent;
}

const STAGE_ORDER: EmailType[] = ["confirmation", "shipping", "delivery", "cancellation", "refund", "sold", "other"];

/**
 * Picks up to `limit` items, guaranteeing at least one representative from
 * every lifecycle stage present in `items` before a second item from any
 * single stage is added — so a rare but important stage (e.g. the one
 * delivery email among a dozen confirmations) is never crowded out by pure
 * recency-based slicing. Within a stage, the most recent items are
 * preferred. The returned order is not itself meaningful — callers should
 * re-sort for presentation (e.g. chronologically for a timeline prompt).
 */
export function diversifyByLifecycleStage<T>(items: T[], subjectOf: (item: T) => string, dateOf: (item: T) => string | null, limit: number): T[] {
  const byStage = new Map<EmailType, T[]>();
  for (const item of items) {
    const stage = classifySubject(subjectOf(item));
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage)!.push(item);
  }
  for (const group of byStage.values()) group.sort((a, b) => Date.parse(dateOf(b) || "") - Date.parse(dateOf(a) || ""));
  const groups = STAGE_ORDER.map(stage => byStage.get(stage)).filter((group): group is T[] => Boolean(group && group.length));
  const picked: T[] = [];
  for (let round = 0; picked.length < limit && groups.some(group => round < group.length); round += 1) {
    for (const group of groups) {
      if (picked.length >= limit) break;
      if (group[round]) picked.push(group[round]);
    }
  }
  return picked;
}
