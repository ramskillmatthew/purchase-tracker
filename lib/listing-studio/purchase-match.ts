import { poundsToPence } from "@/lib/purchase-import/allocate";
import { formatPenceAsGBP } from "./selling-price";

/**
 * Milestone 6 (purchase-price lookup) — matches a listing draft's own SKU
 * against public.purchases so the original price paid can be shown
 * alongside the manual Vinted selling price. Pure and DB-free (like
 * lib/bulk-arrivals.ts's resolveBulkArrivals, whose exact matching
 * convention this mirrors): the caller fetches every purchase with a
 * non-null SKU in ONE query (never one request per listing — see
 * app/api/listing-studio/listings-review/route.ts) and builds one index
 * via buildPurchaseMatchIndex; every listing's match is then a plain,
 * network-free lookup against that index.
 *
 * Matching is exact, case-insensitive, and trimmed — never a substring/
 * partial match, and the SKU is never parsed as a number (leading zeroes
 * stay meaningful; "AA1711" and "AA17110" are never confused). Neither the
 * purchase row nor the listing's own SKU is ever modified by matching.
 *
 * Follow-up correction (restricting the purchase lookup to relevant SKUs)
 * — the caller used to fetch every purchase with a non-null SKU, full
 * stop. buildPurchaseSkuLookupQueries below instead builds one or more
 * BOUNDED queries scoped to only the listing SKUs actually on the current
 * page, so an owner with thousands of historical purchases but few
 * current listings never pulls unrelated rows.
 */

export type PurchaseMatchRecord = {
  id: string;
  sku: string | null;
  order_date: string | null;
  item_description: string;
  // PostgREST can return a `numeric` column as either a JS number or a
  // numeric-looking string depending on driver/response shape — never
  // trusted as already being a clean number (see toPricePence below).
  price_purchased: number | string | null;
};

export type PurchaseMatchSummary = { orderDate: string | null; itemDescription: string; pricePence: number | null };

export type SkuPurchaseMatch =
  | { status: "missing_sku" }
  | { status: "not_found"; sku: string }
  | { status: "matched"; sku: string; purchasePricePence: number | null }
  | { status: "duplicate"; sku: string; matches: PurchaseMatchSummary[] };

/**
 * Safely converts a `purchases.price_purchased` value (pounds, `numeric`)
 * into integer pence — null for anything that isn't a genuine finite
 * number (a blank/malformed stored value is treated as "price
 * unavailable", never as 0 or a crash). Never floating-point arithmetic
 * beyond poundsToPence's own single, final rounding step.
 *
 * Blank/whitespace-only strings are rejected explicitly — `Number("")` is
 * `0`, not `NaN` — the same gotcha lib/purchases.ts's toFinitePrice
 * already guards against for this exact column elsewhere in the app.
 */
function toPricePence(raw: number | string | null): number | null {
  if (raw === null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const numeric = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(numeric) ? poundsToPence(numeric) : null;
}

/** Buckets every purchase with a non-blank SKU by its trimmed, lowercased value — the one place case-insensitivity/whitespace normalization happens. */
export function buildPurchaseMatchIndex(records: PurchaseMatchRecord[]): Map<string, PurchaseMatchRecord[]> {
  const index = new Map<string, PurchaseMatchRecord[]>();
  for (const record of records) {
    const key = record.sku?.trim().toLowerCase();
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(record); else index.set(key, [record]);
  }
  return index;
}

/** One listing's own SKU against the pre-built index — no network, no per-listing query. */
export function matchSkuToPurchase(sku: string | null, index: Map<string, PurchaseMatchRecord[]>): SkuPurchaseMatch {
  const trimmedSku = sku?.trim();
  if (!trimmedSku) return { status: "missing_sku" };

  const matches = index.get(trimmedSku.toLowerCase());
  if (!matches?.length) return { status: "not_found", sku: trimmedSku };

  if (matches.length > 1) {
    return {
      status: "duplicate", sku: trimmedSku,
      matches: matches.map((match): PurchaseMatchSummary => ({ orderDate: match.order_date, itemDescription: match.item_description, pricePence: toPricePence(match.price_purchased) })),
    };
  }

  return { status: "matched", sku: trimmedSku, purchasePricePence: toPricePence(matches[0].price_purchased) };
}

const PURCHASE_MATCH_SELECT = "id,sku,order_date,item_description,price_purchased";

// Bounded so the generated query string can never grow unbounded even with
// many distinct listing SKUs on one page — comfortably clears any
// PostgREST/HTTP practical URL length limit while still being a genuinely
// small number of requests even at hundreds of listings (e.g. 300 unique
// SKUs is only 6 requests, never 300).
export const MAX_SKU_LOOKUP_CHUNK_SIZE = 50;

// PostgREST's bare `ilike.<value>` (no `*`/`%` wildcard added) performs an
// EXACT, case-insensitive match — verified live against this project's own
// Supabase instance (sku=ilike.aa1621 matched the real row stored as
// "AA1621", and sku=ilike.<nonexistent> matched nothing — never a
// substring). This is deliberately NOT PostgREST's `in.()` operator, which
// is case-sensitive `=` and would silently miss a purchase whose SKU was
// typed in different case than the listing's own. `%`/`_` are still SQL
// LIKE wildcards even when the caller added no wildcard themselves, so a
// SKU that happens to literally contain either character is escaped first
// — defensive only (unusual for a real SKU), but never left to silently
// risk turning an "exact" term into an accidental partial match.
function escapeIlikeExactTerm(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

/**
 * Builds one or more bounded PostgREST query strings that together return
 * every purchase whose SKU exactly (case-insensitively) matches one of the
 * given listing SKUs — never the whole purchases table, never one request
 * per listing. Duplicates are still detected correctly: an exact-match
 * clause for one SKU returns EVERY row with that SKU, not just one, so
 * buildPurchaseMatchIndex/matchSkuToPurchase's existing duplicate handling
 * is completely unaffected by this narrower fetch.
 *
 * Deduplicates the input first (case-sensitively — redundant near-duplicate
 * terms like "AA1711" and "aa1711" are harmless since ilike already
 * matches both, this just avoids sending the exact same literal term
 * twice) and drops blanks. Returns [] when given no SKUs at all — the
 * caller then makes ZERO purchase requests, exactly matching "no listing
 * on this page has a SKU".
 */
export function buildPurchaseSkuLookupQueries(skus: (string | null)[]): string[] {
  const uniqueSkus = [...new Set(skus.map(sku => sku?.trim()).filter((sku): sku is string => Boolean(sku)))];
  if (!uniqueSkus.length) return [];

  const queries: string[] = [];
  for (let i = 0; i < uniqueSkus.length; i += MAX_SKU_LOOKUP_CHUNK_SIZE) {
    const chunk = uniqueSkus.slice(i, i + MAX_SKU_LOOKUP_CHUNK_SIZE);
    const orClause = chunk.map(sku => `sku.ilike.${encodeURIComponent(escapeIlikeExactTerm(sku))}`).join(",");
    queries.push(`purchases?select=${PURCHASE_MATCH_SELECT}&or=(${orClause})`);
  }
  return queries;
}

/** The exact fixed line the Listings Review details panel shows for each match outcome — never a raw internal status, matching this codebase's describeXFailure convention elsewhere. */
export function describePurchaseMatch(match: SkuPurchaseMatch): string {
  switch (match.status) {
    case "missing_sku": return "Purchase price unavailable — SKU missing";
    case "not_found": return `No purchase found for SKU ${match.sku}`;
    case "duplicate": return `Multiple purchases found for SKU ${match.sku}`;
    case "matched": return match.purchasePricePence !== null ? `You paid: ${formatPenceAsGBP(match.purchasePricePence)}` : "Purchase price unavailable";
  }
}

/**
 * Listings Review redesign — the Cost column. Only a single, unambiguous
 * "matched" outcome with a real recorded price counts as a known cost;
 * "not_found"/"duplicate"/"missing_sku" are all genuinely ambiguous (no
 * purchase, more than one candidate, or no SKU to match at all) and must
 * never be guessed at — the table/detail panel render "—" for null, never
 * a misleading number.
 */
export function computeCostPence(match: SkuPurchaseMatch): number | null {
  return match.status === "matched" ? match.purchasePricePence : null;
}

/**
 * Profit = selling price − cost, in pence. Null whenever either side is
 * unknown — never partially computed, never a marketplace-fee deduction
 * (no such calculation exists anywhere in this codebase to reuse, and none
 * is added here).
 */
export function computeProfitPence(costPence: number | null, sellingPricePence: number | null): number | null {
  return costPence !== null && sellingPricePence !== null ? sellingPricePence - costPence : null;
}
