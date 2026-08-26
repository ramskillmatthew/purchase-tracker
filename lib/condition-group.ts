import { conditions } from "./validation/purchase";

/**
 * The single source of truth for "new vs. used" reporting. `item_condition`
 * stays exactly as the user (or a historical spreadsheet import — see
 * isHistoricalCondition in lib/validation/purchase.ts) entered it; nothing
 * here ever reads or writes that field. Sales snapshots and reports derive
 * their own "new"/"used" grouping by calling this pure function at the
 * moment they need it, rather than storing a second, independently-editable
 * classification that could drift from item_condition.
 *
 * IMPORTANT: this exact mapping is mirrored in the create_completed_sale()
 * PL/pgSQL function (supabase-sales.sql) so the atomic sale-creation RPC can
 * derive condition_group_snapshot from a freshly-locked purchase row without
 * a round trip back through this module. tests/condition-group.test.ts
 * cross-checks the two never drift apart — update both together.
 */
export type ConditionGroup = "new" | "used" | "unknown";

const NEW_CONDITIONS: readonly string[] = ["Brand new", "Brand new without tags"];
const USED_CONDITIONS: readonly string[] = ["Labelled as very good condition", "Good condition from photos", "Decent condition from photos"];

// Defensive at compile time: if `conditions` in lib/validation/purchase.ts
// ever gains or loses a value without this module being updated to match,
// this throws immediately (at import time, in every test run and at
// startup) rather than silently misclassifying a canonical condition as
// "unknown".
const mappedConditions = new Set([...NEW_CONDITIONS, ...USED_CONDITIONS]);
if (mappedConditions.size !== conditions.length || !conditions.every(condition => mappedConditions.has(condition))) {
  throw new Error("lib/condition-group.ts's NEW_CONDITIONS/USED_CONDITIONS have drifted out of sync with lib/validation/purchase.ts's canonical `conditions` list.");
}

/**
 * Derives the reporting group for a detailed condition string. Null,
 * undefined, blank, or any value outside the five canonical conditions
 * (including historical free-text spreadsheet-import conditions, e.g.
 * "Holes in heel") safely returns "unknown" rather than throwing or
 * guessing.
 */
export function deriveConditionGroup(itemCondition: string | null | undefined): ConditionGroup {
  if (!itemCondition) return "unknown";
  if (NEW_CONDITIONS.includes(itemCondition)) return "new";
  if (USED_CONDITIONS.includes(itemCondition)) return "used";
  return "unknown";
}
