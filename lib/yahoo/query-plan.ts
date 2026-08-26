import { explicitDateRange } from "./query-dates";
import { queryEntityTokens, queryRequestsTransaction } from "./query-relevance";
import { classifyQueryIntent, type EmailType } from "@/lib/email/classify";

export type EmailQueryPlan = {
  operation: "count" | "search";
  hybrid: boolean;
  entity: string | null;
  intent: EmailType;
  startDate?: string;
  endDate?: string;
  transactional: boolean;
};

// A "how many" question that also asks for explanation, identification,
// listing, grouping, or detail ("...and what was cancelled", "...and which
// items were affected", "...what were they for", "list them") is a hybrid
// count+explain request, not a bare count — a plain number can't answer the
// second half, so it must go through retrieval and synthesis instead.
const EXPLAIN_REQUEST = /\b(and what|and which|what was|what were|which item|which items|list them|show them|who (?:was|were) (?:it|that|they) from)\b/i;

/** Converts natural language into the deterministic fields used by both the index and Yahoo. */
export function planEmailQuery(message: string, now = new Date()): EmailQueryPlan {
  const dates = explicitDateRange(message, now);
  const tokens = queryEntityTokens(message);
  const isCount = /\b(how many|count|number of|total number)\b/i.test(message);
  return {
    operation: isCount ? "count" : "search",
    hybrid: isCount && EXPLAIN_REQUEST.test(message),
    entity: tokens.length ? tokens.join(" ") : null,
    intent: classifyQueryIntent([message]),
    startDate: dates?.startDate,
    endDate: dates?.endDate,
    transactional: queryRequestsTransaction(message),
  };
}
