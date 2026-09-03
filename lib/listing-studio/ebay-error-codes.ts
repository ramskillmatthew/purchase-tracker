import type { EbayApiFailure } from "@/lib/listing-studio/ebay-taxonomy-client";

/**
 * Phase 8 fix — "Replace generic handling with safe actionable messages."
 * Before this, every real upstream failure other than a 429/timeout fell
 * into one generic bucket ("We could not retrieve eBay categories. Try
 * again shortly.") — proven, during this fix's own diagnosis, to be
 * exactly what hid a genuine 401 invalid_client (bad configured
 * credentials) behind an unhelpful "try again" message that can never
 * self-resolve by retrying. One shared mapping, reused by both the
 * category service and the aspect service, so the two never drift.
 *
 * Live-diagnostic follow-up fix — the Production keyset issue was
 * resolved, which then exposed a genuine second bug: a wrong URL path in
 * ebay-taxonomy-client.ts's getDefaultCategoryTreeId (fixed alongside
 * this). Investigating that exposed the SAME single generic
 * "EBAY_TAXONOMY_UNAVAILABLE" message covering everything from a 5xx
 * upstream failure to a malformed response to a rejected OAuth scope —
 * distinguishable, verified failure reasons now get distinguishable
 * codes/messages instead.
 */
export type EbayErrorCode =
  | "EBAY_NOT_CONFIGURED" | "EBAY_AUTH_FAILED" | "EBAY_SCOPE_REJECTED" | "EBAY_MARKETPLACE_UNSUPPORTED"
  | "EBAY_CATEGORY_TREE_UNAVAILABLE" | "EBAY_RATE_LIMITED" | "EBAY_SERVER_ERROR" | "EBAY_NETWORK_FAILURE"
  | "EBAY_RESPONSE_PARSE_FAILED" | "EBAY_TAXONOMY_UNAVAILABLE" | "EBAY_NO_CATEGORY" | "EBAY_ASPECTS_FAILED" | "CACHE_FAILED";

/** Same failure reasons as describeEbayApiFailure, but worded for the
 * item-specifics step specifically — "The category was found, but its
 * item specifics could not be loaded" is a materially different, more
 * actionable statement than a bare category-lookup failure. */
export function describeEbayAspectsFailure(reason: EbayApiFailure["error"] | "not_configured"): { code: EbayErrorCode; message: string } {
  if (reason === "not_configured") return { code: "EBAY_NOT_CONFIGURED", message: "eBay category access is not configured on localhost." };
  if (reason === "auth_failed") return { code: "EBAY_AUTH_FAILED", message: "eBay rejected the local developer credentials." };
  if (reason === "rate_limited") return { code: "EBAY_RATE_LIMITED", message: "eBay category service is temporarily unavailable — rate limited. Try again shortly." };
  if (reason === "scope_rejected") return { code: "EBAY_SCOPE_REJECTED", message: "eBay accepted the local developer credentials but rejected this request as forbidden — the configured keyset may be missing the Taxonomy API scope/permission." };
  if (reason === "marketplace_unsupported") return { code: "EBAY_MARKETPLACE_UNSUPPORTED", message: "eBay does not recognise the requested marketplace for category lookups." };
  if (reason === "category_tree_unavailable") return { code: "EBAY_CATEGORY_TREE_UNAVAILABLE", message: "The cached eBay category tree could not be used — it may be stale. Try again shortly." };
  if (reason === "server_error") return { code: "EBAY_SERVER_ERROR", message: "eBay's category service returned a server error. Try again shortly." };
  if (reason === "network_failure") return { code: "EBAY_NETWORK_FAILURE", message: "Could not reach eBay — check the local network connection." };
  if (reason === "invalid_response") return { code: "EBAY_RESPONSE_PARSE_FAILED", message: "The category was found, but eBay's item-specifics response could not be read." };
  // Remaining generic reasons (timeout/request_failed) — worded for the
  // item-specifics step specifically: "The category was found, but its
  // item specifics could not be loaded" is a materially different, more
  // actionable statement than a bare category-lookup failure.
  return { code: "EBAY_ASPECTS_FAILED", message: "The category was found, but its item specifics could not be loaded. Try again shortly." };
}

export function describeEbayApiFailure(reason: EbayApiFailure["error"]): { code: EbayErrorCode; message: string } {
  switch (reason) {
    case "not_configured": return { code: "EBAY_NOT_CONFIGURED", message: "eBay category access is not configured on localhost." };
    case "auth_failed": return { code: "EBAY_AUTH_FAILED", message: "eBay rejected the local developer credentials." };
    // Distinct from auth_failed: the token itself was accepted (never a
    // 401) — this is eBay refusing the specific request as forbidden,
    // the standard signal for a missing/rejected OAuth scope or
    // permission on an otherwise-valid keyset.
    case "scope_rejected": return { code: "EBAY_SCOPE_REJECTED", message: "eBay accepted the local developer credentials but rejected this request as forbidden — the configured keyset may be missing the Taxonomy API scope/permission." };
    // Verified via a real errorId (62003) returned by eBay's own
    // Taxonomy API for an unrecognised marketplace_id.
    case "marketplace_unsupported": return { code: "EBAY_MARKETPLACE_UNSUPPORTED", message: "eBay does not recognise the requested marketplace for category lookups." };
    // Verified via a real errorId (62004) — a stale/bad category tree id
    // was rejected by get_category_suggestions or get_item_aspects_for_category.
    case "category_tree_unavailable": return { code: "EBAY_CATEGORY_TREE_UNAVAILABLE", message: "The cached eBay category tree could not be used — it may be stale. Try again shortly." };
    case "rate_limited": return { code: "EBAY_RATE_LIMITED", message: "eBay category service is temporarily unavailable — rate limited. Try again shortly." };
    // A real HTTP response was received with a 5xx status — eBay's own
    // side failed, never a request-shape problem on this app's end.
    case "server_error": return { code: "EBAY_SERVER_ERROR", message: "eBay's category service returned a server error. Try again shortly." };
    // fetch() itself never completed (DNS failure, connection refused,
    // offline) — distinct from a timeout (the request was sent) and from
    // every status-code-driven failure above (a response was received).
    case "network_failure": return { code: "EBAY_NETWORK_FAILURE", message: "Could not reach eBay — check the local network connection." };
    case "timeout": return { code: "EBAY_TAXONOMY_UNAVAILABLE", message: "eBay category service is temporarily unavailable — the request timed out. Try again shortly." };
    case "request_failed":
      return { code: "EBAY_TAXONOMY_UNAVAILABLE", message: "eBay category service is temporarily unavailable. Try again shortly." };
    // A real 2xx response was received but didn't match the expected
    // shape — this app's own parsing/validation failed, not an upstream
    // outage. Deliberately its own code (never folded into the generic
    // "temporarily unavailable" bucket): retrying won't help this one the
    // way it might for a genuine timeout/request_failed blip.
    case "invalid_response":
      return { code: "EBAY_RESPONSE_PARSE_FAILED", message: "eBay's category service returned a response this app could not read." };
  }
}
