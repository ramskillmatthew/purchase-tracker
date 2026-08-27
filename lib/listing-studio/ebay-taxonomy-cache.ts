import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { getDefaultCategoryTreeId, getItemAspectsForCategory, type EbayApiFailure, type EbayAspect } from "@/lib/listing-studio/ebay-taxonomy-client";

/**
 * Stage 4/5 — server-side caching for the two genuinely expensive, slow-
 * changing pieces of eBay's Taxonomy API (see
 * supabase-listing-studio-ebay-taxonomy.sql's own header comment for why
 * category suggestions themselves are deliberately NOT cached here).
 * Mirrors lib/investments/providers/fx-provider.ts's own "DB-table-backed
 * cache, direct supabaseRequest calls" convention — this codebase has no
 * shared generic cache utility to reuse instead (confirmed: no rate-limit/
 * cache helper exists anywhere else).
 */

// eBay's own category tree essentially never changes within a day —
// generous enough to avoid redundant calls across a normal working
// session, short enough that a genuine tree revision is picked up quickly.
const CATEGORY_TREE_TTL_MS = 24 * 60 * 60 * 1000;
// Aspect definitions for one category change even less often than the tree
// itself typically does.
const ASPECTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CategoryTreeCacheRow = { category_tree_id: string; category_tree_version: string; fetched_at: string };

export type CachedCategoryTreeId = { categoryTreeId: string; categoryTreeVersion: string; stale: boolean };

/**
 * Returns the cached (categoryTreeId, categoryTreeVersion) for one eBay
 * marketplace when fresh; otherwise fetches live and refreshes the cache.
 * If the live fetch itself fails, an existing (even expired) cached value
 * is returned with `stale: true` rather than failing outright — a soft
 * degradation the caller surfaces honestly (see
 * lib/listing-studio/ebay-category-service.ts), never silently treated as
 * fully fresh. Only when there is truly nothing cached AND the live fetch
 * fails does this return the failure itself.
 */
export async function getCachedCategoryTreeId(ebayMarketplaceId: string): Promise<{ ok: true; data: CachedCategoryTreeId } | EbayApiFailure> {
  const rows = await supabaseRequestAll<CategoryTreeCacheRow>(
    `ebay_category_tree_cache?ebay_marketplace_id=eq.${ebayMarketplaceId}&select=category_tree_id,category_tree_version,fetched_at`,
  );
  const cached = rows[0];
  const isFresh = cached && Date.now() - new Date(cached.fetched_at).getTime() < CATEGORY_TREE_TTL_MS;
  if (isFresh) return { ok: true, data: { categoryTreeId: cached.category_tree_id, categoryTreeVersion: cached.category_tree_version, stale: false } };

  const live = await getDefaultCategoryTreeId(ebayMarketplaceId);
  if (live.ok) {
    await supabaseRequest("ebay_category_tree_cache?on_conflict=ebay_marketplace_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ ebay_marketplace_id: ebayMarketplaceId, category_tree_id: live.data.categoryTreeId, category_tree_version: live.data.categoryTreeVersion, fetched_at: new Date().toISOString() }),
    });
    return { ok: true, data: { categoryTreeId: live.data.categoryTreeId, categoryTreeVersion: live.data.categoryTreeVersion, stale: false } };
  }
  if (cached) return { ok: true, data: { categoryTreeId: cached.category_tree_id, categoryTreeVersion: cached.category_tree_version, stale: true } };
  return live;
}

type AspectsCacheRow = { aspects_json: EbayAspect[]; fetched_at: string };

export type CachedAspects = { aspects: EbayAspect[]; stale: boolean };

/** Same fresh-or-refetch-with-stale-fallback shape as getCachedCategoryTreeId,
 * keyed additionally by categoryId and categoryTreeVersion — a tree version
 * bump naturally invalidates old rows without an explicit delete, since a
 * lookup for the new version simply won't match them. */
export async function getCachedItemAspects(categoryTreeId: string, categoryTreeVersion: string, categoryId: string): Promise<{ ok: true; data: CachedAspects } | EbayApiFailure> {
  const rows = await supabaseRequestAll<AspectsCacheRow>(
    `ebay_category_aspects_cache?category_tree_id=eq.${categoryTreeId}&category_id=eq.${categoryId}&category_tree_version=eq.${categoryTreeVersion}&select=aspects_json,fetched_at`,
  );
  const cached = rows[0];
  const isFresh = cached && Date.now() - new Date(cached.fetched_at).getTime() < ASPECTS_TTL_MS;
  if (isFresh) return { ok: true, data: { aspects: cached.aspects_json, stale: false } };

  const live = await getItemAspectsForCategory(categoryTreeId, categoryId);
  if (live.ok) {
    await supabaseRequest("ebay_category_aspects_cache?on_conflict=category_tree_id,category_id,category_tree_version", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ category_tree_id: categoryTreeId, category_id: categoryId, category_tree_version: categoryTreeVersion, aspects_json: live.data, fetched_at: new Date().toISOString() }),
    });
    return { ok: true, data: { aspects: live.data, stale: false } };
  }
  if (cached) return { ok: true, data: { aspects: cached.aspects_json, stale: true } };
  return live;
}
