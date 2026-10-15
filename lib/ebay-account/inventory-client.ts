import "server-only";
import { ebayApiBase, ebayEnvironment } from "@/lib/ebay-account/oauth";
import { assertAllowedInventoryOperation } from "@/lib/ebay-account/inventory-allowlist";
import { parseEbayErrors, formatEbayErrorForUser, type SanitizedEbayError } from "@/lib/ebay-account/ebay-error";

/**
 * eBay Inventory API calls (Stage 6) — the "future stage" that
 * lib/ebay-account/inventory-allowlist.ts's own header comment anticipated.
 * Every function here calls assertAllowedInventoryOperation(...) with a
 * hardcoded string literal (never a caller-supplied operation name) before
 * constructing any request — the one gate every Inventory API call site
 * must pass through. No function in this file can ever publish anything:
 * there is no publishOffer/bulkPublishOffer/publishOfferByInventoryItemGroup/
 * withdrawOffer implementation anywhere in this codebase (see
 * tests/ebay-account-draft-only-safety.test.ts), and
 * assertAllowedInventoryOperation itself refuses those names outright even
 * if one were ever mistakenly added to the allowlist.
 *
 * Every request here needs a genuinely valid eBay access token — callers
 * always obtain one via lib/ebay-account/client.ts's getValidEbayAccessToken
 * first, never a token this module reads or refreshes itself.
 */

async function inventoryRequest(accessToken: string, method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${ebayApiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Language": "en-GB",
        "Accept-Language": "en-GB",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    const error = new Error("Could not reach eBay's Inventory API.") as Error & { cause?: unknown };
    error.cause = cause;
    throw error;
  }
  return response;
}

/** Never surfaces eBay's raw response body upward as-is — it can echo back
 * request fields — only a safe, bounded, sanitised summary.
 *
 * CORRECTIVE PASS (failed first draft) — previously kept only eBay's
 * short top-level `message` field, which eBay itself documents as a
 * generic per-category summary ("Invalid request") rather than the actual
 * reason. Now parses the full structured error envelope via
 * lib/ebay-account/ebay-error.ts's parseEbayErrors (errorId/domain/
 * category/message/longMessage/parameters, every value length-bounded and
 * scanned for secret-shaped substrings) and builds the thrown error's
 * `.message` from the DETAILED longMessage when eBay provided one — this
 * is what makes a future failure's persisted error_message actually
 * diagnosable instead of a dead end. The full sanitised detail is also
 * attached as `.ebayErrors` for any caller that wants the structured form
 * (e.g. to log a machine-readable errorId) without re-parsing text. */
async function inventoryError(response: Response, fallbackMessage: string): Promise<Error & { status: number; ebayErrors: SanitizedEbayError[] }> {
  let ebayErrors: SanitizedEbayError[] = [];
  try {
    const body: unknown = await response.json();
    ebayErrors = parseEbayErrors(body);
  } catch { /* non-JSON or empty body — fall back to the generic message */ }
  const error = new Error(formatEbayErrorForUser(ebayErrors, fallbackMessage)) as Error & { status: number; ebayErrors: SanitizedEbayError[] };
  error.status = response.status;
  error.ebayErrors = ebayErrors;
  return error;
}

export type EbayInventoryLocation = {
  merchantLocationKey: string;
  name: string | null;
  status: string | null;
  addressSummary: string | null;
};

export async function createEbayInventoryLocation(accessToken: string, merchantLocationKey: string, input: { name: string; postalCode: string }): Promise<void> {
  assertAllowedInventoryOperation("createInventoryLocation");
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(merchantLocationKey)) throw new Error("Invalid eBay inventory location key.");
  const response = await inventoryRequest(accessToken, "POST", `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`, {
    location: { address: { postalCode: input.postalCode, country: "GB" } },
    locationTypes: ["WAREHOUSE"], merchantLocationStatus: "ENABLED", name: input.name,
  });
  if (!response.ok) throw await inventoryError(response, "eBay inventory location could not be created.");
}

/** Read-only — lists every merchant inventory location the connected
 * account already has configured on eBay's side. This app never creates,
 * edits, enables, disables, or deletes a location (see
 * lib/ebay-account/inventory-allowlist.ts's own comment: only
 * "getInventoryLocations" is on the allowlist for this resource). */
export async function fetchEbayInventoryLocations(accessToken: string): Promise<EbayInventoryLocation[]> {
  assertAllowedInventoryOperation("getInventoryLocations");
  const results: EbayInventoryLocation[] = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < 20; page += 1) {
    const response = await inventoryRequest(accessToken, "GET", `/sell/inventory/v1/location?limit=${limit}&offset=${offset}`);
    if (!response.ok) throw await inventoryError(response, "eBay inventory locations could not be read.");
    const body = await response.json() as { locations?: Array<Record<string, unknown>>; total?: number };
    for (const item of body.locations ?? []) {
      const address = item.location as { address?: Record<string, unknown> } | undefined;
      const addressFields = address?.address;
      const addressSummary = addressFields
        ? [addressFields.addressLine1, addressFields.city, addressFields.postalCode].filter(Boolean).join(", ") || null
        : null;
      results.push({
        merchantLocationKey: String(item.merchantLocationKey),
        name: typeof item.name === "string" && item.name ? item.name : null,
        status: typeof item.merchantLocationStatus === "string" ? item.merchantLocationStatus : null,
        addressSummary,
      });
    }
    offset += limit;
    if (!body.total || offset >= body.total) break;
  }
  return results;
}

export type EbayInventoryItemPayload = {
  condition: string;
  conditionDescription?: string;
  product: {
    title: string;
    description: string;
    aspects?: Record<string, string[]>;
    imageUrls: string[];
  };
  availability: { shipToLocationAvailability: { quantity: number } };
};

/** Creates or replaces (idempotent PUT, keyed by SKU) the eBay Inventory
 * item for one product — always an UNPUBLISHED, draft-only Inventory item;
 * this call alone never creates a live listing (an inventory item has no
 * price, quantity-for-sale offer, or visibility on eBay until a separate
 * Offer is created and — a call this codebase never makes — published).
 * Returns nothing on success (eBay's own PUT returns 200/204 with no useful
 * body); the caller re-reads via getOffer once the offer itself exists if
 * it needs to verify. */
export async function createOrReplaceInventoryItem(accessToken: string, sku: string, payload: EbayInventoryItemPayload): Promise<void> {
  assertAllowedInventoryOperation("createOrReplaceInventoryItem");
  if (!sku || !/^[A-Za-z0-9._-]{1,50}$/.test(sku)) throw new Error("Invalid eBay inventory SKU.");
  const response = await inventoryRequest(accessToken, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, payload);
  if (!response.ok) throw await inventoryError(response, "eBay inventory item could not be created.");
}

export type EbayOfferPayload = {
  sku: string;
  marketplaceId: "EBAY_GB";
  format: "FIXED_PRICE";
  categoryId: string;
  listingDescription: string;
  pricingSummary: { price: { value: string; currency: "GBP" } };
  quantityLimitPerBuyer?: number;
  listingPolicies: {
    fulfillmentPolicyId: string;
    returnPolicyId: string;
    paymentPolicyId: string;
  };
  merchantLocationKey?: string;
};

export type EbayOfferResult = { offerId: string };

/** Creates ONE unpublished offer for an already-created inventory item
 * (identified by payload.sku). This is the ONLY write call in this file
 * that produces the object a future, deliberately separate publish step
 * would need — and no such publish call exists anywhere in this codebase
 * (see this file's own header comment). Callers must check
 * getOffersForSku FIRST (see below) — this function itself does not
 * de-duplicate; idempotency is the caller's own "check, then create"
 * responsibility, exactly like every other create-if-absent flow in this
 * codebase. */
export async function createOffer(accessToken: string, payload: EbayOfferPayload): Promise<EbayOfferResult> {
  assertAllowedInventoryOperation("createOffer");
  const response = await inventoryRequest(accessToken, "POST", "/sell/inventory/v1/offer", payload);
  if (!response.ok) throw await inventoryError(response, "eBay offer could not be created.");
  const body = await response.json() as { offerId: string };
  return { offerId: body.offerId };
}

/** Replaces the mutable fields of one known offer. The offer id is always
 * discovered server-side from eBay or this owner's marketplace draft. */
export async function updateOffer(accessToken: string, offerId: string, payload: EbayOfferPayload): Promise<void> {
  assertAllowedInventoryOperation("updateOffer");
  if (!offerId) throw new Error("Missing eBay offer id.");
  // eBay's UpdateOffer request does not accept `sku`; the offer id already
  // identifies the inventory item. Strip it server-side so create/update
  // can share one builder without sending an undocumented field.
  const { sku: _sku, ...updatePayload } = payload;
  const response = await inventoryRequest(accessToken, "PUT", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, updatePayload);
  if (!response.ok) throw await inventoryError(response, "eBay offer could not be updated.");
}

export type EbayPublishOfferResult = { offerId: string; listingId: string };

/** The only operation in this application that can make an eBay listing
 * live. Callers must enforce their own explicit user confirmation before
 * reaching this function. */
export async function publishOffer(accessToken: string, offerId: string): Promise<EbayPublishOfferResult> {
  assertAllowedInventoryOperation("publishOffer");
  if (!offerId) throw new Error("Missing eBay offer id.");
  const response = await inventoryRequest(accessToken, "POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`);
  if (!response.ok) throw await inventoryError(response, "eBay could not publish this listing.");
  const body = await response.json() as { listingId?: string };
  if (!body.listingId) throw new Error("eBay published the offer but did not return a listing id. Check Seller Hub before retrying.");
  return { offerId, listingId: body.listingId };
}

/** Corrective pass — the real eBay-documented way to make offer creation
 * idempotent: eBay's own `GET /sell/inventory/v1/offer?sku=...` lists every
 * offer already registered for a SKU. Called BEFORE createOffer on every
 * attempt (including a retry after a crash/timeout whose actual remote
 * outcome is unknown) so a retry can discover and reuse an offer eBay
 * already created rather than risking a duplicate — this is what makes
 * "a retry continues from the known remote state" a genuine guarantee
 * rather than a hope. Read-only; never publishes or modifies anything. */
export async function getOffersForSku(accessToken: string, sku: string, marketplaceId: "EBAY_GB" = "EBAY_GB"): Promise<EbayOfferResult[]> {
  assertAllowedInventoryOperation("getOffersForSku");
  const response = await inventoryRequest(accessToken, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`);
  if (response.status === 404) return [];
  if (!response.ok) throw await inventoryError(response, "Existing eBay offers could not be checked.");
  const body = await response.json() as { offers?: Array<{ offerId: string }> };
  return (body.offers ?? []).map(o => ({ offerId: o.offerId }));
}

export type EbayOfferReadResult = { offerId: string; status: string; sku: string; listingId: string | null } | null;

/** Read-only verification that a previously created offer still exists as
 * expected — used to confirm a draft after creation, never to publish or
 * modify it. Returns null (never throws) for a 404 — "the offer is gone" is
 * an expected, handled outcome for a verification step, not a crash. */
export async function getOffer(accessToken: string, offerId: string): Promise<EbayOfferReadResult> {
  assertAllowedInventoryOperation("getOffer");
  const response = await inventoryRequest(accessToken, "GET", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await inventoryError(response, "eBay offer could not be read.");
  const body = await response.json() as { offerId: string; status: string; sku: string; listing?: { listingId?: string }; listingId?: string };
  return { offerId: body.offerId, status: body.status, sku: body.sku, listingId: body.listingId ?? body.listing?.listingId ?? null };
}

export type EbayInventoryItemReadResult = {
  sku: string;
  condition: string | null;
  hasOffers: boolean;
} | null;

/** Read-only — the official Inventory API operation for "does this
 * inventory item exist, and what does it currently look like". Used ONLY
 * for reconciliation after a failed/uncertain attempt, never as a
 * precondition for a write. Hardcodes method "GET" and a fixed path
 * template — there is no parameter or code path here that could ever
 * become a PUT/POST, unlike createOrReplaceInventoryItem above, which is a
 * deliberately separate function. Returns null (never throws) for a
 * genuine 404 — "this SKU has no inventory item yet" is an expected,
 * handled outcome, not a fault. Any OTHER non-2xx response (auth failure,
 * rate limit, 5xx) throws via inventoryError, exactly like every other
 * read here — it must never be silently treated as "does not exist".
 * Returns only the few fields reconciliation actually needs — never the
 * full remote body, never image URLs, never aspects. */
export async function getInventoryItem(accessToken: string, sku: string): Promise<EbayInventoryItemReadResult> {
  assertAllowedInventoryOperation("getInventoryItem");
  if (!sku || !/^[A-Za-z0-9._-]{1,50}$/.test(sku)) throw new Error("Invalid eBay inventory SKU.");
  const response = await inventoryRequest(accessToken, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await inventoryError(response, "eBay inventory item could not be read.");
  const body = await response.json() as { sku?: string; condition?: string; offers?: unknown[] };
  return { sku: body.sku ?? sku, condition: body.condition ?? null, hasOffers: Array.isArray(body.offers) && body.offers.length > 0 };
}

/** Never used for a real network call — exists purely so a test (or a
 * future diagnostic) can assert which eBay environment/host an Inventory
 * API call would target, mirroring lib/ebay-account/oauth.ts's own
 * ebayApiBase export. */
export function inventoryApiHost(): string {
  return ebayApiBase(ebayEnvironment());
}
