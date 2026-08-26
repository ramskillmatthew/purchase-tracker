import { z } from "zod";
import { createHash } from "crypto";

/**
 * Milestone 7 (Vinted category catalogue sync).
 *
 * Source: Vinted UK's own authenticated "Sell an item" (Create Listing)
 * page, which loads its real category tree from
 *   GET https://www.vinted.co.uk/api/v2/item_upload/catalogs
 * Verified/accessed: 2026-08-03. This is NOT a documented public API — a
 * live endpoint observed from Vinted's own web app, which may change,
 * start requiring authentication, or be rate-limited/blocked at any time
 * (see lib/listing-studio/vinted-catalogue-client.ts's own comment for a
 * live-observed example of exactly that happening). This file is pure,
 * dependency-free transformation logic with no network/database access at
 * all, so it stays fully unit-testable against constructed fixtures —
 * never against a hard-coded copy of Vinted's real catalogue (the live
 * endpoint remains the one source of truth for actual category data; the
 * root ids below are used only as a small, verified derivation aid, never
 * as a substitute for a real sync).
 *
 * Two-stage validation, matching this file's two responsibilities:
 *  1. `vintedCatalogueResponseSchema` (+ `parseVintedCatalogueResponse`) —
 *     is this even a well-formed Vinted catalogue response at all.
 *  2. `flattenVintedCatalogue` — walking the (now schema-valid) tree into
 *     flat rows, which is where structural problems a schema alone can't
 *     see (cycles, id collisions, runaway depth/size) are caught.
 *
 * Follow-up correction (2026-08-03): the live endpoint above has returned
 * a Cloudflare challenge page (text/html, not JSON) every time it's been
 * tested from this project's environment — see
 * vinted-catalogue-client.ts's own comment. The one genuine full
 * catalogue actually obtained came from a verified browser snapshot
 * (Vinted UK's own signed-in Create Listing page's embedded
 * `catalogTree`, already flat) — see vinted-catalogue-snapshot.ts, which
 * reuses this file's root-metadata derivation and RPC-payload/fingerprint
 * helpers rather than duplicating them. That snapshot also verified
 * `isSelectable = isLeaf` directly against the live Create Listing UI
 * (leaf rows expose a radio control and enable Save; parent rows only
 * navigate) — no longer merely a documented assumption.
 */

// ---------------------------------------------------------------------------
// Raw response shape + schema

// Vinted's own example response mixes representations for the same kind of
// flag across fields in the SAME node (`"color_field_visibility": 1` next
// to `"measurements_field_visibility": false`) — both are accepted here
// and normalised to a real boolean by toBooleanOrNull() during flattening,
// never rejected for using "the wrong" representation.
const visibilityFlagSchema = z.union([z.boolean(), z.number()]).nullable().optional();

export type VintedCatalogNode = {
  id: number;
  code?: string | null;
  title: string;
  path?: string | null;
  url?: string | null;
  color_field_visibility?: boolean | number | null;
  size_field_visibility?: boolean | number | null;
  measurements_field_visibility?: boolean | number | null;
  brand_field_visibility?: boolean | number | null;
  catalogs: VintedCatalogNode[];
  [key: string]: unknown;
};

// `.passthrough()` (not `.strict()`) deliberately — Vinted can add a new
// field to this response at any time (it's an internal endpoint, not a
// versioned public contract), and an unrecognised extra field must never
// fail the whole sync. Only the fields this app actually reads are
// type-checked; anything else rides along into raw_json untouched. `id`
// and `title` are the only two fields treated as truly load-bearing here
// — everything else is optional/nullable, matching how sparse the one
// verified example response's own non-essential fields already are.
const vintedCatalogNodeSchema: z.ZodType<VintedCatalogNode> = z.lazy(() => z.object({
  id: z.number(),
  code: z.string().nullable().optional(),
  title: z.string().min(1),
  path: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  color_field_visibility: visibilityFlagSchema,
  size_field_visibility: visibilityFlagSchema,
  measurements_field_visibility: visibilityFlagSchema,
  brand_field_visibility: visibilityFlagSchema,
  catalogs: z.array(vintedCatalogNodeSchema).default([]),
}).passthrough());

// The top-level shape: `{ "catalogs": [...] }`. `.min(1)` rejects a
// genuinely empty catalogue outright at the schema layer — Vinted's real
// catalogue always has root categories; an empty array is a sign
// something is badly wrong (a broken response, an A/B test, a redesigned
// endpoint), never a legitimate "there are no categories" state to accept
// and silently apply.
export const vintedCatalogueResponseSchema = z.object({
  catalogs: z.array(vintedCatalogNodeSchema).min(1),
}).passthrough();

export type VintedCatalogueResponseParseResult =
  | { success: true; roots: VintedCatalogNode[] }
  | { success: false; error: string };

/** Schema-level validation only — see this file's own top comment for why this is a separate stage from flattenVintedCatalogue. */
export function parseVintedCatalogueResponse(raw: unknown): VintedCatalogueResponseParseResult {
  const result = vintedCatalogueResponseSchema.safeParse(raw);
  if (!result.success) return { success: false, error: "Vinted's catalogue response did not match the expected shape." };
  return { success: true, roots: result.data.catalogs };
}

// ---------------------------------------------------------------------------
// Flattened row shape

export type VintedAudience = "mens" | "womens" | "kids" | "unisex";
export type VintedItemFamily = "footwear" | "clothing" | "accessories" | "home" | "electronics" | "entertainment" | "sports" | "collectables" | "other";

export type FlattenedVintedCategory = {
  id: number;
  code: string | null;
  label: string;
  fullPath: string;
  parentId: number | null;
  rootId: number;
  depth: number;
  sortOrder: number;
  isLeaf: boolean;
  isSelectable: boolean;
  audience: VintedAudience | null;
  itemFamily: VintedItemFamily | null;
  vintedUrl: string | null;
  colorFieldVisibility: boolean | null;
  sizeFieldVisibility: boolean | null;
  measurementsFieldVisibility: boolean | null;
  brandFieldVisibility: boolean | null;
  rawJson: unknown;
};

export class VintedCatalogueValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VintedCatalogueValidationError";
    this.code = code;
  }
}

// Generous but bounded — Vinted's real catalogue is a few thousand
// categories at most and rarely more than 4-5 levels deep; these exist
// purely as a runaway-input guard (a malformed/adversarial response
// building an unbounded or absurdly deep tree), not a real expected ceiling.
export const MAX_CATALOGUE_DEPTH = 12;
export const MAX_CATALOGUE_NODES = 20_000;

// The ONLY root ids this derivation trusts — exactly the ones verified
// live from Vinted UK's own Create Listing form (see this milestone's
// completion report). Every other root (including any Vinted adds later)
// derives null rather than a guess — "do not guess from arbitrary English
// words when the hierarchy provides no reliable answer" applies here.
const VERIFIED_ROOT_AUDIENCE: Record<number, VintedAudience> = {
  1904: "womens", // Women
  5: "mens", // Men
  1193: "kids", // Kids
};

// Only roots that are unambiguously ONE item family end-to-end (a "Home"
// listing is never footwear or clothing). Women/Men/Kids are deliberately
// NOT included: those roots contain footwear, clothing, AND accessories as
// descendants, and no verified code/label pattern for telling those
// apart below the root was available when this was built — see the
// completion report's "could not be verified" section. Their item_family
// is null until a real refresh's actual child codes can be inspected and
// this mapping extended with genuine evidence.
const VERIFIED_ROOT_ITEM_FAMILY: Record<number, VintedItemFamily> = {
  1918: "home", // Home
  2994: "electronics", // Electronics
  2309: "entertainment", // Books & Media (root 2309's real verified title — corrected 2026-08-03 from this file's own earlier "Entertainment" guess; "entertainment" remains the closest fit among the fixed item_family enum values)
  4824: "collectables", // Hobbies & collectables
  4332: "sports", // Sports
  // Designer (2993, verified 2026-08-03) is deliberately NOT included —
  // it spans multiple audiences and item families (designer clothing,
  // footwear, accessories, etc. alike), so no single value would be
  // honest here; it derives null, same as any unmapped root.
};

/** The verified root-level audience/item_family derivation, exposed for reuse by the flat-snapshot validator (vinted-catalogue-snapshot.ts) — same rules, same "null rather than guess" policy. */
export function deriveVerifiedRootMetadata(rootId: number): { audience: VintedAudience | null; itemFamily: VintedItemFamily | null } {
  return { audience: VERIFIED_ROOT_AUDIENCE[rootId] ?? null, itemFamily: VERIFIED_ROOT_ITEM_FAMILY[rootId] ?? null };
}

function toBooleanOrNull(value: boolean | number | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  return value !== 0;
}

/** " Men  >  Shoes " -> "Men > Shoes"; collapses any run of whitespace around ">" or elsewhere to one space. */
function normalizePathSegment(segment: string): string {
  return segment.trim().replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
}

function stripChildren(node: VintedCatalogNode): Record<string, unknown> {
  const { catalogs: _catalogs, ...rest } = node;
  return rest;
}

/**
 * Walks an already schema-valid Vinted catalogue tree into flat rows.
 * Throws VintedCatalogueValidationError (never returns a partial result)
 * on any structural problem a schema alone can't catch: a cycle, a
 * genuinely conflicting duplicate id, excessive depth, or an excessive
 * total node count. An id appearing twice with IDENTICAL data (same
 * label/full path/parent) is tolerated silently — some real catalogues do
 * legitimately reference the same node twice — only a CONFLICTING repeat
 * is rejected.
 */
export function flattenVintedCatalogue(roots: VintedCatalogNode[]): FlattenedVintedCategory[] {
  const result: FlattenedVintedCategory[] = [];
  const seen = new Map<number, FlattenedVintedCategory>();
  let nodeCount = 0;

  function walk(node: VintedCatalogNode, parentId: number | null, rootId: number, depth: number, sortOrder: number, ancestorIds: ReadonlySet<number>): void {
    nodeCount += 1;
    if (nodeCount > MAX_CATALOGUE_NODES) {
      throw new VintedCatalogueValidationError("TOO_MANY_NODES", `Catalogue exceeds the maximum of ${MAX_CATALOGUE_NODES} categories.`);
    }
    if (depth > MAX_CATALOGUE_DEPTH) {
      throw new VintedCatalogueValidationError("TOO_DEEP", `Catalogue exceeds the maximum depth of ${MAX_CATALOGUE_DEPTH} at category ${node.id}.`);
    }
    if (!Number.isInteger(node.id) || node.id <= 0) {
      throw new VintedCatalogueValidationError("INVALID_ID", `Category id must be a positive integer, got ${JSON.stringify(node.id)}.`);
    }
    if (ancestorIds.has(node.id)) {
      throw new VintedCatalogueValidationError("CYCLE_DETECTED", `Category ${node.id} appears as its own ancestor.`);
    }

    const fullPath = normalizePathSegment([node.path, node.title].filter((part): part is string => Boolean(part && part.trim())).join(" > "));
    const isLeaf = !node.catalogs || node.catalogs.length === 0;
    const { audience, itemFamily } = deriveVerifiedRootMetadata(rootId);

    const flattened: FlattenedVintedCategory = {
      id: node.id,
      code: node.code ?? null,
      label: node.title,
      fullPath,
      parentId,
      rootId,
      depth,
      sortOrder,
      isLeaf,
      // Verified 2026-08-03 against the live Create Listing UI (see this
      // milestone's completion report): leaf categories expose a radio
      // selection control and enable Save; parent categories only navigate
      // to their children and expose no selection control. is_leaf is a
      // reliable proxy for selectability, not merely a documented guess.
      isSelectable: isLeaf,
      audience,
      itemFamily,
      vintedUrl: node.url ?? null,
      colorFieldVisibility: toBooleanOrNull(node.color_field_visibility),
      sizeFieldVisibility: toBooleanOrNull(node.size_field_visibility),
      measurementsFieldVisibility: toBooleanOrNull(node.measurements_field_visibility),
      brandFieldVisibility: toBooleanOrNull(node.brand_field_visibility),
      rawJson: stripChildren(node),
    };

    const existing = seen.get(node.id);
    if (existing) {
      if (existing.label !== flattened.label || existing.fullPath !== flattened.fullPath || existing.parentId !== flattened.parentId) {
        throw new VintedCatalogueValidationError("DUPLICATE_ID_CONFLICT", `Category id ${node.id} appears twice with conflicting data (e.g. a different label, path, or parent).`);
      }
      return; // Identical repeat — harmless, not re-added.
    }
    seen.set(node.id, flattened);
    result.push(flattened);

    const childAncestors = new Set(ancestorIds);
    childAncestors.add(node.id);
    (node.catalogs ?? []).forEach((child, index) => walk(child, node.id, rootId, depth + 1, index, childAncestors));
  }

  roots.forEach((root, index) => walk(root, null, root.id, 0, index, new Set()));
  return result;
}

// ---------------------------------------------------------------------------
// Refresh-transaction helpers — shared by the refresh route and its tests.
// Both stay pure/deterministic so a refresh's "did anything actually
// change" comparison never depends on network or database timing.

/**
 * A stable SHA-256 fingerprint of a flattened catalogue, independent of
 * the order categories happen to arrive in (sorted by id first). Two
 * fetches of an unchanged Vinted catalogue always produce the same
 * fingerprint; any real change to id/label/path/hierarchy/flags changes it.
 */
export function computeVintedCatalogueFingerprint(categories: FlattenedVintedCategory[]): string {
  const sorted = [...categories].sort((a, b) => a.id - b.id);
  const payload = sorted.map((c) => [
    c.id, c.code, c.label, c.fullPath, c.parentId, c.rootId, c.depth, c.sortOrder,
    c.isLeaf, c.isSelectable, c.audience, c.itemFamily, c.vintedUrl,
    c.colorFieldVisibility, c.sizeFieldVisibility, c.measurementsFieldVisibility, c.brandFieldVisibility,
  ]);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** camelCase -> the exact snake_case shape supabase-listing-studio.sql's vinted_categories_apply_refresh RPC unpacks from its `p_categories` jsonb array. */
export function toVintedCategoryRpcPayload(category: FlattenedVintedCategory) {
  return {
    id: category.id,
    code: category.code,
    label: category.label,
    full_path: category.fullPath,
    parent_id: category.parentId,
    root_id: category.rootId,
    depth: category.depth,
    sort_order: category.sortOrder,
    is_leaf: category.isLeaf,
    is_selectable: category.isSelectable,
    audience: category.audience,
    item_family: category.itemFamily,
    vinted_url: category.vintedUrl,
    color_field_visibility: category.colorFieldVisibility,
    size_field_visibility: category.sizeFieldVisibility,
    measurements_field_visibility: category.measurementsFieldVisibility,
    brand_field_visibility: category.brandFieldVisibility,
    raw_json: category.rawJson,
  };
}
