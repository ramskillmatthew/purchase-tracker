import "server-only";
import { z } from "zod";

/**
 * Stage 4 — the ONE place this app talks to eBay's real Taxonomy API
 * (https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html).
 * No client secret, no OAuth token, and no raw eBay response ever reaches
 * the browser — every function here runs server-side only ("server-only"
 * import) and every caller gets back a closed, safe result type, never a
 * thrown provider error.
 *
 * Credentials: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET (an eBay Developer
 * Program "Production" keyset — https://developer.ebay.com/my/keys).
 * EBAY_ENVIRONMENT selects "PRODUCTION" (default) or "SANDBOX". None of
 * these exist in this project's environment yet — every function below
 * returns { ok: false, error: "not_configured" } until they're set, and
 * NEVER falls back to fabricated suggestions in that case (see this
 * module's own tests and lib/listing-studio/ebay-category-service.ts's
 * fixture-mode gate, which only ever activates outside production).
 */

const EBAY_OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;

function apiBase(): string {
  return process.env.EBAY_ENVIRONMENT === "SANDBOX" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}
function oauthTokenUrl(): string {
  return process.env.EBAY_ENVIRONMENT === "SANDBOX" ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token" : "https://api.ebay.com/identity/v1/oauth2/token";
}

export type EbayApiFailure =
  | { ok: false; error: "not_configured" }
  | { ok: false; error: "timeout" }
  | { ok: false; error: "rate_limited" }
  | { ok: false; error: "request_failed" }
  | { ok: false; error: "invalid_response" };

function credentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// Module-level in-memory cache — a real eBay application access token is
// valid for ~2 hours. This is a best-effort optimisation only (a cold
// serverless instance simply re-fetches one); the genuinely expensive,
// slow-changing data (category tree id/version, aspect definitions) has
// its own durable, database-backed cache in ebay-taxonomy-cache.ts, so a
// token re-fetch on cold start is a minor, acceptable cost, never a
// correctness issue.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function getAccessToken(): Promise<{ ok: true; token: string } | EbayApiFailure> {
  const creds = credentials();
  if (!creds) return { ok: false, error: "not_configured" };
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return { ok: true, token: cachedToken.value };

  let response: Response;
  try {
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    response = await fetchWithTimeout(oauthTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: EBAY_OAUTH_SCOPE }).toString(),
    });
  } catch (error) {
    return { ok: false, error: (error as Error)?.name === "TimeoutError" ? "timeout" : "request_failed" };
  }
  if (response.status === 429) return { ok: false, error: "rate_limited" };
  if (!response.ok) return { ok: false, error: "request_failed" };

  const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
  const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, error: "invalid_response" };

  cachedToken = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
  return { ok: true, token: parsed.data.access_token };
}

async function ebayGet<T>(path: string, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | EbayApiFailure> {
  const token = await getAccessToken();
  if (!token.ok) return token;

  let response: Response;
  try {
    response = await fetchWithTimeout(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token.token}`, "Accept-Language": "en-GB", "Content-Language": "en-GB" },
    });
  } catch (error) {
    return { ok: false, error: (error as Error)?.name === "TimeoutError" ? "timeout" : "request_failed" };
  }
  if (response.status === 429) return { ok: false, error: "rate_limited" };
  if (!response.ok) return { ok: false, error: "request_failed" };

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) return { ok: false, error: "invalid_response" };
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) return { ok: false, error: "invalid_response" };

  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, error: "invalid_response" }; }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: "invalid_response" };
  return { ok: true, data: parsed.data };
}

const categoryTreeIdSchema = z.object({
  categoryTreeId: z.string().min(1),
  categoryTreeVersion: z.string().min(1),
  categoryTreeMarketplaceId: z.string().optional(),
});
export type EbayCategoryTreeId = z.infer<typeof categoryTreeIdSchema>;

/** GET /commerce/taxonomy/v1/category_tree/get_default_category_tree_id */
export async function getDefaultCategoryTreeId(ebayMarketplaceId: string): Promise<{ ok: true; data: EbayCategoryTreeId } | EbayApiFailure> {
  return ebayGet(`/commerce/taxonomy/v1/category_tree/get_default_category_tree_id?marketplace_id=${encodeURIComponent(ebayMarketplaceId)}`, categoryTreeIdSchema);
}

const categorySchema = z.object({ categoryId: z.string().min(1), categoryName: z.string().min(1) });
const categorySuggestionSchema = z.object({
  category: categorySchema,
  categoryTreeNodeLevel: z.number().int().optional(),
  categoryTreeNodeAncestors: z.array(z.object({ categoryId: z.string(), categoryName: z.string(), categoryTreeNodeLevel: z.number().int().optional() })).optional(),
  relevancy: z.string().optional(),
});
const categorySuggestionsResponseSchema = z.object({ categorySuggestions: z.array(categorySuggestionSchema).default([]) });
export type EbayCategorySuggestion = z.infer<typeof categorySuggestionSchema>;

/**
 * GET .../category_tree/{id}/get_category_suggestions?q=... — per eBay's
 * own documented behaviour this endpoint ONLY ever returns LEAF categories
 * (a listing can only ever be created under a leaf), so every suggestion
 * this function returns already satisfies "the selected category is a leaf
 * category" by construction — no separate verification call is needed for
 * anything sourced from here (see lib/listing-studio/ebay-category-service.ts's
 * own comment on why "Manual change" always re-searches through this same
 * endpoint rather than accepting an arbitrary category id directly).
 */
export async function getCategorySuggestions(categoryTreeId: string, query: string): Promise<{ ok: true; data: EbayCategorySuggestion[] } | EbayApiFailure> {
  const result = await ebayGet(
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(categoryTreeId)}/get_category_suggestions?q=${encodeURIComponent(query)}`,
    categorySuggestionsResponseSchema,
  );
  if (!result.ok) return result;
  return { ok: true, data: result.data.categorySuggestions };
}

// Stage 5's own aspect-constraint shape — kept here (not a separate file)
// since it's returned by this same Taxonomy API family
// (get_item_aspects_for_category), just a different endpoint.
const aspectValueSchema = z.object({ localizedValue: z.string() });
const aspectConstraintSchema = z.object({
  aspectDataType: z.string().optional(),
  itemToAspectCardinality: z.enum(["SINGLE", "MULTI"]).optional(),
  aspectMode: z.enum(["FREE_TEXT", "SELECTION_ONLY"]).optional(),
  aspectRequired: z.boolean().optional(),
  aspectUsage: z.enum(["REQUIRED", "RECOMMENDED", "OPTIONAL"]).optional(),
  aspectEnabledForVariations: z.boolean().optional(),
  aspectMaxLength: z.number().int().optional(),
});
const ebayAspectSchema = z.object({
  localizedAspectName: z.string(),
  aspectConstraint: aspectConstraintSchema.optional(),
  aspectValues: z.array(aspectValueSchema).optional(),
});
const itemAspectsResponseSchema = z.object({
  categoryTreeId: z.string().optional(),
  categoryId: z.string().optional(),
  aspects: z.array(ebayAspectSchema).default([]),
});
export type EbayAspect = z.infer<typeof ebayAspectSchema>;

/** GET .../category_tree/{id}/get_item_aspects_for_category?category_id=... */
export async function getItemAspectsForCategory(categoryTreeId: string, categoryId: string): Promise<{ ok: true; data: EbayAspect[] } | EbayApiFailure> {
  const result = await ebayGet(
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(categoryTreeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
    itemAspectsResponseSchema,
  );
  if (!result.ok) return result;
  return { ok: true, data: result.data.aspects };
}

/** Test-only: clears the in-memory OAuth token cache between test cases. */
export function __resetEbayTokenCacheForTests(): void { cachedToken = null; }
