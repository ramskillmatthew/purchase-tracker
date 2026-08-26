import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { VINTED_CATALOGUE_SOURCE_MARKET } from "./vinted-catalogue-client";
import { extractCategorySearchKeywords } from "./vinted-category-selection";

/**
 * Read access to the synced public.vinted_categories /
 * public.vinted_category_sync_status tables (see supabase-listing-studio.sql
 * and lib/listing-studio/vinted-catalogue-client.ts for how they're
 * populated). Deliberately a shared lib, not inlined per-route: the exact
 * same "active + selectable" search this milestone's search API route
 * exposes to the Edit Fields picker is also what the AI category
 * candidate-selection stage needs (a compact set of real candidates to
 * hand Claude) — one query, two callers, not duplicated PostgREST filter
 * strings drifting apart over time.
 */

export type VintedCategoryRow = {
  id: number;
  code: string | null;
  label: string;
  full_path: string;
  parent_id: number | null;
  root_id: number;
  depth: number;
  is_leaf: boolean;
  is_selectable: boolean;
  is_active: boolean;
  audience: string | null;
  item_family: string | null;
};

const CATEGORY_SELECT = "id,code,label,full_path,parent_id,root_id,depth,is_leaf,is_selectable,is_active,audience,item_family";

/** Looks up one category by its Vinted id regardless of active/selectable state — Listings Review needs to render the path of a category that has since gone inactive, not just currently-valid ones. */
export async function getVintedCategoryById(id: number): Promise<VintedCategoryRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await supabaseRequestAll<VintedCategoryRow>(`vinted_categories?id=eq.${id}&select=${CATEGORY_SELECT}&order=id.asc`);
  return rows[0] ?? null;
}

/** The one rule for "may this category be published/kept as Ready": active, selectable, and (defensively) a leaf. */
export function isPublishableVintedCategory(category: VintedCategoryRow | null): category is VintedCategoryRow {
  return !!category && category.is_active && category.is_selectable && category.is_leaf;
}

/** Bulk lookup for Listings Review's "is each listing's stored category still valid" pass — one query for every distinct id on the page, instead of one per listing. */
export async function getVintedCategoriesByIds(ids: number[]): Promise<Map<number, VintedCategoryRow>> {
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (!uniqueIds.length) return new Map();
  const rows = await supabaseRequestAll<VintedCategoryRow>(`vinted_categories?id=in.(${uniqueIds.join(",")})&select=${CATEGORY_SELECT}&order=id.asc`);
  return new Map(rows.map((row) => [row.id, row]));
}

// Bounded on both ends: broad enough that a real picker/candidate list is
// useful, tight enough that "send the entire catalogue to the browser" (or
// to Claude) can never happen through this path.
const MIN_SEARCH_QUERY_LENGTH = 2;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

export type VintedCategorySearchResult = { id: number; label: string; fullPath: string; audience: string | null; itemFamily: string | null };

export type VintedCategorySearchOptions = {
  query?: string | null;
  audience?: string | null;
  itemFamily?: string | null;
  limit?: number;
};

export type VintedCategorySearchOutcome =
  | { status: "success"; results: VintedCategorySearchResult[] }
  | { status: "query_too_short" };

/** PostgREST's ilike pattern treats these as wildcards/separators — stripped from a free-text term rather than escaped, since this is a "contains" search, not a precise match. */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[%,()*]/g, "").trim();
}

export async function searchActiveSelectableVintedCategories(options: VintedCategorySearchOptions): Promise<VintedCategorySearchOutcome> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const filters = ["is_active=eq.true", "is_selectable=eq.true"];
  if (options.audience) filters.push(`audience=eq.${encodeURIComponent(options.audience)}`);
  if (options.itemFamily) filters.push(`item_family=eq.${encodeURIComponent(options.itemFamily)}`);

  const rawQuery = options.query?.trim();
  if (rawQuery) {
    if (rawQuery.length < MIN_SEARCH_QUERY_LENGTH) return { status: "query_too_short" };
    const sanitized = sanitizeSearchTerm(rawQuery);
    const idClause = /^\d+$/.test(rawQuery) ? `,id.eq.${rawQuery}` : "";
    if (sanitized || idClause) {
      filters.push(`or=(full_path.ilike.*${encodeURIComponent(sanitized)}*,label.ilike.*${encodeURIComponent(sanitized)}*${idClause})`);
    }
  }

  const response = await supabaseRequest(`vinted_categories?${filters.join("&")}&select=id,label,full_path,audience,item_family&order=full_path.asc&limit=${limit}`);
  const rows = (await response.json()) as { id: number; label: string; full_path: string; audience: string | null; item_family: string | null }[];
  return { status: "success", results: rows.map((row) => ({ id: row.id, label: row.label, fullPath: row.full_path, audience: row.audience, itemFamily: row.item_family })) };
}

// Milestone 7 follow-up (2026-08-03) — the automatic AI category-selection
// scope is hard-capped at 25 candidates, never the general search's 50
// (see selectAutomaticSelectionBranches's own comment): "never send more
// than 25 candidates" is an explicit hard rule, not a default.
export const MAX_AUTOMATIC_SELECTION_CANDIDATES = 25;

/** Escapes the ilike-significant characters in a fixed branch full_path constant before using it as a prefix pattern — defensive only, since none of the 8 verified branch paths actually contain these characters today. */
function escapeIlikePattern(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

/**
 * Candidates for automatic AI category selection: active + selectable
 * leaves whose full_path starts with one of the given (already
 * deterministically chosen) branch paths, optionally further narrowed by
 * a productType-derived keyword match. Hard-capped at
 * MAX_AUTOMATIC_SELECTION_CANDIDATES — this is the one query that must
 * NEVER be allowed to return "the whole catalogue" by construction, since
 * its result is handed directly to the bounded AI call. The cap matters
 * in practice, not just in theory: the verified branches themselves can
 * have well over 25 active/selectable leaves (e.g. "Women > Clothing" has
 * ~150), so productType narrowing isn't a nicety here — without it, a
 * query would silently truncate to an arbitrary alphabetical-first 25.
 *
 * Follow-up correction (2026-08-07) — production bug fix: narrowing used
 * to AND the productType field's entire raw text onto the query as one
 * literal full_path substring (e.g. "Running Trainers" as a single
 * phrase). Vinted's catalogue vocabulary essentially never matches an
 * AI-generated productType phrase verbatim — the real leaves are
 * "Trainers" and "Running shoes", neither of which contains the exact
 * substring "Running Trainers" — so that filter excluded every real
 * candidate, every time, for any multi-word productType, and the
 * resolveVintedCategoryAssignment caller (see vinted-category-assignment.ts)
 * saw zero candidates and reported the honest-but-wrong "no_candidates"
 * even though real, active, selectable leaves existed right under the
 * correctly-chosen branch. Now narrows on each significant WORD
 * independently (OR'd — see extractCategorySearchKeywords), and — the
 * durable safety property, not just a one-off vocabulary patch — falls
 * back to the unnarrowed branch scope whenever the narrowed query finds
 * nothing, so a vocabulary mismatch between the AI's phrasing and this
 * branch's own labels can never again be mistaken for "no real candidates
 * exist".
 *
 * Deduplicates naturally: a leaf under the Kids "> Shoes" branch matches
 * BOTH that branch's own path prefix and its parent Kids-clothing
 * branch's prefix when both are supplied (selectAutomaticSelectionBranches
 * returns both for an "uncertain" item family) — since each query below
 * is one SQL OR-combined call producing one row set (never per-branch
 * queries concatenated), each category id can only ever appear once
 * regardless.
 */
export async function searchAutomaticSelectionCandidates(options: { branchFullPaths: string[]; query?: string | null }): Promise<VintedCategorySearchResult[]> {
  if (!options.branchFullPaths.length) return [];
  const branchOr = `or(${options.branchFullPaths.map((path) => `full_path.ilike.${encodeURIComponent(escapeIlikePattern(path) + "%")}`).join(",")})`;

  async function runQuery(extraAndGroups: string[]): Promise<VintedCategorySearchResult[]> {
    const andFilter = `and=(is_active.eq.true,is_selectable.eq.true,${branchOr}${extraAndGroups.map((group) => `,${group}`).join("")})`;
    const response = await supabaseRequest(`vinted_categories?${andFilter}&select=id,label,full_path,audience,item_family&order=full_path.asc&limit=${MAX_AUTOMATIC_SELECTION_CANDIDATES}`);
    const rows = (await response.json()) as { id: number; label: string; full_path: string; audience: string | null; item_family: string | null }[];
    return rows.map((row) => ({ id: row.id, label: row.label, fullPath: row.full_path, audience: row.audience, itemFamily: row.item_family }));
  }

  const keywords = extractCategorySearchKeywords(options.query ?? null);
  if (keywords.length) {
    const keywordOr = `or(${keywords.map((word) => `full_path.ilike.*${encodeURIComponent(word)}*`).join(",")})`;
    const narrowed = await runQuery([keywordOr]);
    if (narrowed.length) return narrowed;
  }

  return runQuery([]);
}

export type VintedCategorySyncStatusRow = {
  source_market: string;
  source_endpoint: string;
  last_attempted_at: string | null;
  last_succeeded_at: string | null;
  last_status: "success" | "failed" | "rejected_shrinkage" | "rejected_invalid_response" | null;
  last_error: string | null;
  fetched_count: number | null;
  active_count: number | null;
  fingerprint: string | null;
  duration_ms: number | null;
  // Milestone 7 follow-up (2026-08-03) — which path produced the last
  // successful import: the live endpoint, or a verified browser snapshot
  // (see vinted-catalogue-snapshot.ts's own top comment for why the
  // latter has been the only one that's actually worked so far).
  last_source_type: "live_endpoint" | "verified_browser_snapshot" | null;
  last_captured_at: string | null;
  updated_at: string;
};

export async function getVintedCategorySyncStatus(): Promise<VintedCategorySyncStatusRow | null> {
  const rows = await supabaseRequestAll<VintedCategorySyncStatusRow>(
    `vinted_category_sync_status?source_market=eq.${encodeURIComponent(VINTED_CATALOGUE_SOURCE_MARKET)}&select=*&order=source_market.asc`,
  );
  return rows[0] ?? null;
}
