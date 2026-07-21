import { explicitDateRange } from "./query-dates";
import { queryEntityTokens, queryRequestsTransaction } from "./query-relevance";
import { classifyEmailIntent, type EmailIntent } from "./search-terms";

export type EmailQueryPlan = {
  operation: "count" | "search";
  entity: string | null;
  intent: EmailIntent;
  startDate?: string;
  endDate?: string;
  transactional: boolean;
};

/** Converts natural language into the deterministic fields used by both the index and Yahoo. */
export function planEmailQuery(message: string, now = new Date()): EmailQueryPlan {
  const dates = explicitDateRange(message, now);
  const tokens = queryEntityTokens(message);
  return {
    operation: /\b(how many|count|number of|total number)\b/i.test(message) ? "count" : "search",
    entity: tokens.length ? tokens.join(" ") : null,
    intent: classifyEmailIntent([message]),
    startDate: dates?.startDate,
    endDate: dates?.endDate,
    transactional: queryRequestsTransaction(message),
  };
}
