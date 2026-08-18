import type { HoldingResponse } from "./view-model-types";

/**
 * Extracted from HoldingsTable.tsx as its own pure, testable module —
 * sorting a mixed-category (stock/pokemon/lego/cash) holdings list is
 * exactly the kind of logic that looks right with one row and silently
 * breaks with several (ties, negative returns, missing percentages).
 */
export type SortKey = "value" | "return" | "allocation";

export const SORTERS: Record<SortKey, (h: HoldingResponse) => number> = {
  value: h => h.currentGbpValue,
  return: h => h.unrealizedPercent ?? -Infinity,
  allocation: h => h.allocationPercent,
};

export function sortHoldings(holdings: HoldingResponse[], key: SortKey, descending: boolean): HoldingResponse[] {
  return [...holdings].sort((a, b) => (SORTERS[key](b) - SORTERS[key](a)) * (descending ? 1 : -1));
}
