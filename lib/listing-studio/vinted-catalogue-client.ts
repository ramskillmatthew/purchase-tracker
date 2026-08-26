import "server-only";
import { parseVintedCatalogueResponse, flattenVintedCatalogue, VintedCatalogueValidationError, type FlattenedVintedCategory } from "./vinted-catalogue";

/**
 * Milestone 7 (Vinted category catalogue sync) — server-only HTTP client.
 *
 * Source: Vinted UK's own authenticated "Sell an item" (Create Listing)
 * page, which loads its real category tree from the endpoint below.
 * Verified/accessed: 2026-08-03. This is NOT a documented public API — a
 * live endpoint observed from Vinted's own web app, which may change,
 * start requiring authentication, be rate-limited, or be blocked at any
 * time. Confirmed live from this project's own environment during this
 * milestone: a direct request (no auth, a real browser-style Accept
 * header) returned HTTP 403 with a Cloudflare "Please wait" JS-challenge
 * page — `text/html`, not JSON — instead of the expected catalogue. That
 * is exactly the "blocked"/"unexpected_content_type" outcome below, not a
 * hypothetical this file guards against defensively; it is what this
 * endpoint actually does from this app's current network environment. See
 * this milestone's completion report for the full finding — the live
 * refresh has NOT been verified end-to-end against real Vinted data.
 *
 * Every failure mode is a closed-set outcome (mirrors
 * lib/listing-studio/listing-generation-ai.ts's ListingGenerationAiOutcome
 * convention) so a caller can never accidentally treat "didn't work" as
 * "got an empty catalogue" — those are different outcomes, handled
 * differently by the refresh route (which must never let a fetch failure
 * of any kind destroy the last known-good catalogue).
 */

export const VINTED_CATALOGUE_SOURCE_MARKET = "vinted_uk";
export const VINTED_CATALOGUE_ENDPOINT = "https://www.vinted.co.uk/api/v2/item_upload/catalogs";

const FETCH_TIMEOUT_MS = 10_000;
// Generous for a JSON category tree (expected to be a few hundred KB at
// most), tight enough to reject a runaway or adversarial response without
// ever buffering it fully into memory first.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// A real, truthful UA identifying this app — never a spoofed browser UA.
// This client never sends cookies, and never sends any Supabase/Anthropic
// credential or user data — the request carries nothing but this header.
const USER_AGENT = "PurchaseTrackerListingStudio/1.0 (+listing-studio Vinted category sync)";

export type VintedCatalogueFetchOutcome =
  | { status: "success"; categories: FlattenedVintedCategory[] }
  | { status: "blocked"; httpStatus: number }
  | { status: "rate_limited"; httpStatus: number }
  | { status: "unexpected_content_type"; contentType: string | null }
  | { status: "response_too_large" }
  | { status: "invalid_response"; detail: string }
  | { status: "http_error"; httpStatus: number }
  | { status: "network_error" };

/** Streams the body with a hard byte cap, never buffering an oversized response into memory. Returns null once the cap is exceeded. */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > maxBytes ? null : new Uint8Array(buffer);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function attemptFetch(): Promise<VintedCatalogueFetchOutcome> {
  let response: Response;
  try {
    response = await fetch(VINTED_CATALOGUE_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Covers network failure and the AbortSignal timeout firing — neither
    // carries any detail worth surfacing beyond "try again shortly".
    return { status: "network_error" };
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "blocked", httpStatus: response.status };
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "rate_limited", httpStatus: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "http_error", httpStatus: response.status };
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    // The exact shape of the real Cloudflare challenge page this endpoint
    // returned when tested live during this milestone: text/html, not
    // JSON. Drain the body so the connection is released, but never parse
    // or forward it anywhere.
    await response.body?.cancel().catch(() => undefined);
    return { status: "unexpected_content_type", contentType };
  }

  const body = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
  if (body === null) return { status: "response_too_large" };

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { status: "invalid_response", detail: "Response body was not valid JSON." };
  }

  const parsed = parseVintedCatalogueResponse(raw);
  if (!parsed.success) return { status: "invalid_response", detail: parsed.error };

  try {
    const categories = flattenVintedCatalogue(parsed.roots);
    return { status: "success", categories };
  } catch (error) {
    if (error instanceof VintedCatalogueValidationError) return { status: "invalid_response", detail: error.message };
    return { status: "invalid_response", detail: "Unexpected error while flattening the catalogue." };
  }
}

function isTransient(outcome: VintedCatalogueFetchOutcome): boolean {
  return outcome.status === "network_error" || (outcome.status === "http_error" && outcome.httpStatus >= 500);
}

/**
 * Fetches and validates Vinted UK's live category catalogue. At most one
 * conservative retry, and only for genuinely transient failures (a
 * network error, or a 5xx) — never for 401/403/429/malformed-response,
 * which retrying can't fix and would only look like hammering the
 * endpoint. Never throws — every outcome, including total failure, is a
 * value the caller must handle explicitly.
 */
export async function fetchVintedCatalogue(): Promise<VintedCatalogueFetchOutcome> {
  const first = await attemptFetch();
  if (isTransient(first)) return attemptFetch();
  return first;
}

/** A fixed, safe sentence for every failure outcome — never the raw detail, which is for server logs only. */
export function describeVintedCatalogueFetchFailure(outcome: Exclude<VintedCatalogueFetchOutcome, { status: "success" }>): string {
  switch (outcome.status) {
    case "blocked": return "Vinted blocked this request. Its category catalogue could not be refreshed right now.";
    case "rate_limited": return "Vinted is rate-limiting these requests. Please try refreshing again shortly.";
    case "unexpected_content_type": return "Vinted returned an unexpected response instead of its category catalogue.";
    case "response_too_large": return "Vinted's response was unexpectedly large and was not processed.";
    case "invalid_response": return "Vinted's category catalogue did not match the expected format.";
    case "http_error": return "Vinted's category catalogue could not be fetched right now.";
    case "network_error": return "Could not reach Vinted to refresh its category catalogue.";
  }
}
