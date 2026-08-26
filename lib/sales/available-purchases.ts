import "server-only";
import { supabaseRequest } from "@/lib/supabase";
import type { Purchase } from "@/lib/types";

export const AVAILABLE_PURCHASES_DEFAULT_LIMIT = 25;
export const AVAILABLE_PURCHASES_MAX_LIMIT = 100;

/** Strips PostgREST/ilike-pattern-significant characters — same sanitisation convention as lib/email-index/query.ts's own `safe()` helper. */
export function sanitizeSearchTerm(value: string): string {
  return value.replace(/[%*,()]/g, "").trim();
}

export function clampLimit(rawLimit: unknown): number {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) return AVAILABLE_PURCHASES_DEFAULT_LIMIT;
  return Math.min(Math.trunc(parsed), AVAILABLE_PURCHASES_MAX_LIMIT);
}

export function clampOffset(rawOffset: unknown): number {
  const parsed = Number(rawOffset);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

/**
 * Builds the PostgREST query for one page of candidate purchases: currently
 * `in_stock`, most-recent-first, optionally narrowed by a case-insensitive
 * partial match against description/SKU/seller/supplier. Does NOT exclude
 * actively-sold purchases itself (PostgREST can't express "no matching row
 * in a different table" as a single filter) — see searchAvailablePurchases,
 * which runs a second bounded query for that.
 */
export function buildAvailablePurchasesQuery(term: string): string {
  const filters = ["select=*", "stock_status=eq.in_stock", "order=order_date.desc,created_at.desc"];
  const sanitized = sanitizeSearchTerm(term);
  if (sanitized) {
    const encoded = encodeURIComponent(sanitized);
    filters.push(`or=(item_description.ilike.*${encoded}*,sku.ilike.*${encoded}*,seller_name.ilike.*${encoded}*,purchased_from.ilike.*${encoded}*)`);
  }
  return `purchases?${filters.join("&")}`;
}

export type AvailablePurchasesPage = { results: Purchase[]; total: number };

/**
 * Fetches one page of purchases matching `term` that are genuinely
 * available to sell right now: stock_status = in_stock AND not already
 * linked to an active (non-refunded/non-cancelled) sale item.
 *
 * The second condition can't be expressed as a single PostgREST filter
 * against a different table, so this runs as two bounded queries: the
 * candidate page (bounded by limit+offset, matching search+stock_status),
 * then a lookup of which of just those candidate ids have an active
 * sale_items row, with those excluded. A purchase excluded this way makes
 * the returned page smaller than `limit` — an accepted trade-off for a
 * post-filtered search page at this application's real scale (thousands of
 * purchases, never millions). `total` reflects the stock_status+search
 * match count before this second exclusion pass, so it may be a very
 * slight overcount in the rare case a purchase was manually toggled back to
 * "in stock" while still actively sold.
 *
 * Never relies on stock_status alone as the sole availability signal: a
 * purchase manually toggled back to "in stock" via the existing
 * StockStatusToggle while still actively linked to a sale (an edge case
 * that control has no way to know about) must not reappear in Quick Sale /
 * Order Sale search — see lib/purchase-availability.ts's own comment on why
 * stock_status alone isn't treated as authoritative here.
 */
export async function searchAvailablePurchases(term: string, limit: number, offset: number): Promise<AvailablePurchasesPage> {
  const path = buildAvailablePurchasesQuery(term);
  const response = await supabaseRequest(path, { headers: { Prefer: "count=exact", Range: `${offset}-${offset + limit - 1}` } });
  const candidates = await response.json() as Purchase[];
  const range = response.headers.get("content-range") || "";
  const total = Number(range.split("/")[1] || 0);

  if (!candidates.length) return { results: [], total };

  const ids = candidates.map(purchase => purchase.id);
  const activeSaleItems = await (await supabaseRequest(`sale_items?purchase_id=in.(${ids.join(",")})&is_active=eq.true&select=purchase_id`)).json() as { purchase_id: string }[];
  const activelySold = new Set(activeSaleItems.map(row => row.purchase_id));
  const results = candidates.filter(purchase => !activelySold.has(purchase.id));
  return { results, total };
}
