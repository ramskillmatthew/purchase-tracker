import type { MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";

/**
 * Live-diagnostic follow-up fix (proven root cause of "price_not_set"
 * appearing 4+ times in one draft's stored validationMessages) — every
 * automation pass (category suggestion, aspect resolution, a manual
 * price save) rebuilds its OWN small slice of the validation-message
 * list and appends it, but several call sites only ever filtered out the
 * codes THEY directly manage from the previous list, never the
 * selling-settings codes (condition/price/quantity) another pass had
 * already added — so running the pipeline more than once (completely
 * normal: generate, then Suggest category, then Suggest item specifics,
 * then save a price) accumulated duplicate copies without bound. Every
 * call site that recomputes these three now uses this ONE shared
 * builder/filter pair, so they can never drift or duplicate again.
 */
export const SELLING_SETTINGS_MESSAGE_CODES = ["condition_not_set", "price_not_set", "quantity_not_set"] as const;

export function buildSellingSettingsMessages(draft: { conditionValue: string | null; pricePence: number | null; quantity: number | null }): MarketplaceValidationMessage[] {
  const messages: MarketplaceValidationMessage[] = [];
  if (!draft.conditionValue) messages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
  // Stage 6 correction — price is no longer required for eBay CONTENT
  // readiness (see lib/listing-studio/marketplace-readiness.ts's own
  // comment on hasPrice): it's entered later, per-listing, in Listings
  // Review, and only blocks the separate "Create eBay drafts" action there
  // (see lib/listing-studio/ebay-draft-eligibility.ts) — never marks
  // generated content itself incomplete. Downgraded to a low-severity
  // suggestion rather than removed entirely, so it still surfaces as a
  // helpful reminder without reading as a blocking problem.
  if (draft.pricePence == null) messages.push({ code: "price_not_set", message: "No eBay selling price yet — set it in Listings Review before creating a draft.", field: "price", severity: "suggestion" });
  if (draft.quantity == null) messages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });
  return messages;
}

/** Removes every message whose code is in `codes` — call this on a
 * draft's existing validationMessages before appending a freshly
 * recomputed copy of those same codes, at every call site that
 * (re)computes some subset of the full validation-message list, so
 * partial automation passes never accumulate stale duplicates. */
export function withoutMessageCodes(previous: MarketplaceValidationMessage[], codes: readonly string[]): MarketplaceValidationMessage[] {
  const codeSet = new Set(codes);
  return previous.filter(m => !codeSet.has(m.code));
}

/** Same idea, for a code FAMILY sharing a prefix (e.g. "aspect_required_"
 * / "aspect_recommended_", one entry per aspect name) rather than a fixed
 * small set of exact codes. */
export function withoutMessageCodePrefix(previous: MarketplaceValidationMessage[], prefix: string): MarketplaceValidationMessage[] {
  return previous.filter(m => !m.code.startsWith(prefix));
}
