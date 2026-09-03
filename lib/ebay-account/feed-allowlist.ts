import "server-only";

/**
 * The Sell Feed API equivalent of lib/ebay-account/inventory-allowlist.ts
 * — a hard, denylist-first gate every Feed API call site and every CSV
 * row this application builds must pass through. Two independent
 * dimensions are gated here, because they are two different kinds of
 * mistake this application must never make:
 *
 *   1. Which Feed API HTTP operations this application may call at all
 *      (createFeedTask/uploadFeedFile/getFeedTask/getFeedTasks/
 *      getFeedResultFile — never anything that could touch order data,
 *      account settings, or any other Feed API resource this feature
 *      doesn't need).
 *   2. Which Action value a generated CSV row may ever contain
 *      (Draft — and ONLY Draft; Add/Revise/Relist/End are all real,
 *      officially-supported FX_LISTING actions that would create or
 *      change a LIVE listing, which this application must never do).
 *
 * Both checks are denylist-first: a known-dangerous value is rejected
 * even if it were ever mistakenly added to the allowlist below, exactly
 * mirroring inventory-allowlist.ts's own established pattern.
 */

const ALLOWED_FEED_OPERATIONS: ReadonlySet<string> = new Set([
  "createFeedTask",
  "uploadFeedFile",
  "getFeedTask",
  "getFeedTasks",
  "getFeedResultFile",
]);

/** Feed API operations that could touch order/fulfilment data or other
 * resources this feature has no business calling — listed explicitly so
 * an accidental future addition is still caught, never merely "not on
 * the allowlist". */
const FORBIDDEN_FEED_OPERATIONS: ReadonlySet<string> = new Set([
  "createOrderTask", "getOrderTask", "getOrderTasks",
  "createInventoryTask", "getInventoryTask", "getInventoryTasks",
  "createSchedule", "updateSchedule", "deleteSchedule",
  "createCustomerServiceMetricTask",
]);

export function assertAllowedFeedOperation(operation: string): void {
  if (FORBIDDEN_FEED_OPERATIONS.has(operation)) {
    throw new Error(`"${operation}" is outside this feature's Feed API surface and is permanently forbidden.`);
  }
  if (!ALLOWED_FEED_OPERATIONS.has(operation)) {
    throw new Error(`"${operation}" is not on the explicit allowlist of permitted Feed API operations.`);
  }
}

/** The ONE Action value this application may ever write into a generated
 * CSV row — see lib/listing-studio/ebay-feed/template-contract.ts's own
 * ONLY_ALLOWED_ACTION, which this re-exports so there is exactly one
 * source of truth. */
export const ONLY_ALLOWED_FEED_ACTION = "Draft";

/** Every other real FX_LISTING Action this application is architecturally
 * forbidden from ever emitting — named explicitly (not merely "not
 * Draft") so a future edit that broadens this by accident is still
 * caught by the denylist-first check below, exactly like
 * inventory-allowlist.ts's own FORBIDDEN_PUBLISH_OPERATIONS. */
const FORBIDDEN_FEED_ACTIONS: ReadonlySet<string> = new Set([
  "Add", "Revise", "Relist", "End",
  // Also reject the LMS-family action-equivalent feed types outright, in
  // case a caller ever passes one of these strings through this same gate.
  "LMS_ADD_FIXED_PRICE_ITEM", "LMS_ADD_ITEM", "LMS_REVISE_FIXED_PRICE_ITEM", "LMS_END_ITEM",
]);

/** The one gate every CSV-row-building code path must pass an Action
 * value through before it can ever reach a generated file. Throws for
 * any known live-listing-capable action (checked first, always wins,
 * even if ONLY_ALLOWED_FEED_ACTION were ever mistakenly widened) or any
 * value that simply isn't "Draft". */
export function assertAllowedFeedAction(action: string): void {
  if (FORBIDDEN_FEED_ACTIONS.has(action)) {
    throw new Error(`"${action}" would create or modify a live eBay listing and is permanently forbidden in this application.`);
  }
  if (action !== ONLY_ALLOWED_FEED_ACTION) {
    throw new Error(`"${action}" is not the only permitted Feed draft action ("${ONLY_ALLOWED_FEED_ACTION}").`);
  }
}
