import "server-only";

/**
 * The explicit allowlist eBay Inventory API calls will be required to go
 * through once a future stage actually implements draft creation. No
 * Inventory API call exists anywhere in this codebase yet — this file
 * exists now, ahead of that work, so the pattern ("check an explicit
 * allowlist before ever constructing an Inventory API request") is
 * established before any real network call is written, rather than
 * retrofitted after the fact.
 *
 * `sell.inventory` (see lib/ebay-account/oauth.ts's own scope comment) is
 * a genuinely WRITE-CAPABLE, publish-capable OAuth scope — it is requested
 * now only so the next stage doesn't force a second re-authorisation, and
 * granting it does not itself let this application publish anything.
 * Draft-only safety is enforced HERE, in application code: every future
 * Inventory API call site must call assertAllowedInventoryOperation(...)
 * before constructing a request, and no code anywhere may accept a
 * client-supplied operation name or raw Inventory API path — see
 * tests/ebay-account-draft-only-safety.test.ts for the proof this holds
 * today (trivially, since no Inventory call exists at all) and will keep
 * holding once real operations are added.
 */

/** Operations a future stage is permitted to add real implementations
 * for — every one of these creates/reads/updates a DRAFT (an unpublished
 * inventory item or offer), never a live listing.
 *
 * Stage 6 — the "future stage" this file's own header anticipated. Every
 * operation below is implemented in lib/ebay-account/inventory-client.ts,
 * gated by assertAllowedInventoryOperation at its one call site each, and
 * covered by tests/ebay-account-draft-only-safety.test.ts's own proof that
 * no publish-capable call exists anywhere in this codebase. Every one of
 * these creates/reads an UNPUBLISHED inventory item or offer, or reads
 * account-level Inventory API data (locations) — never publishes. */
const ALLOWED_INVENTORY_OPERATIONS: ReadonlySet<string> = new Set([
  "createOrReplaceInventoryItem",
  "createOffer",
  "getOffer",
  "getOffersForSku",
  "getInventoryLocations",
  // Corrective pass (failed-draft diagnosis/retry) — read-only GET of one
  // inventory item by its exact SKU, the official Inventory API operation
  // for "does this inventory item exist on eBay's side". Never a fallback
  // to PUT/createOrReplaceInventoryItem — see inventory-client.ts's own
  // getInventoryItem, which hardcodes method "GET" and cannot be called
  // any other way.
  "getInventoryItem",
]);

/**
 * Operations that can make a listing live on eBay — permanently forbidden
 * regardless of what ALLOWED_INVENTORY_OPERATIONS above ever contains.
 * Listed explicitly (rather than merely "not on the allow list") so a
 * future edit that accidentally adds one of these to the allowlist is
 * still caught — this check runs first and always wins.
 */
const FORBIDDEN_PUBLISH_OPERATIONS: ReadonlySet<string> = new Set([
  "publishOffer", "bulkPublishOffer", "publishOfferByInventoryItemGroup",
  "withdrawOffer", "bulkWithdrawOffer",
]);

/**
 * The one gate every future Inventory API call site must pass through
 * before constructing a request. Throws for:
 *  - any known publish-capable operation, even if it were ever mistakenly
 *    added to ALLOWED_INVENTORY_OPERATIONS (checked first, always wins);
 *  - any operation not explicitly present in ALLOWED_INVENTORY_OPERATIONS
 *    (which today is every operation, since the set is empty).
 * Never accepts a raw URL/path — only a known, hardcoded operation name a
 * caller passes as a string literal, never derived from client input.
 */
export function assertAllowedInventoryOperation(operation: string): void {
  if (FORBIDDEN_PUBLISH_OPERATIONS.has(operation)) {
    throw new Error(`"${operation}" is a publish-capable eBay operation and is permanently forbidden in this application.`);
  }
  if (!ALLOWED_INVENTORY_OPERATIONS.has(operation)) {
    throw new Error(`"${operation}" is not on the explicit allowlist of permitted eBay Inventory API operations.`);
  }
}
