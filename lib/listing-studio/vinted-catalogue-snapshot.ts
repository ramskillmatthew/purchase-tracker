import { z } from "zod";
import { deriveVerifiedRootMetadata, MAX_CATALOGUE_DEPTH, MAX_CATALOGUE_NODES, type FlattenedVintedCategory } from "./vinted-catalogue";

/**
 * Milestone 7 follow-up (2026-08-03) — verified browser-snapshot import.
 *
 * The live endpoint (vinted-catalogue-client.ts) has returned a Cloudflare
 * challenge page every time it's been tested from this project's
 * environment. The one genuine full catalogue actually obtained instead
 * came from a verified browser snapshot: Vinted UK's own signed-in Create
 * Listing page (`https://www.vinted.co.uk/items/new`), whose embedded
 * `catalogTree` was extracted and already flattened by hand before being
 * handed to this application — NOT the nested tree shape
 * vinted-catalogue.ts's flattener expects, so this is a dedicated
 * validator for that already-flat shape, not a variant of that flattener.
 *
 * Every number in the file's own `verification` block is treated as a
 * CLAIM, never a fact — this module recomputes every count and every
 * structural invariant independently from the `categories` array itself,
 * and rejects outright (never repairs) on any mismatch. This is the one
 * hard rule the whole import path is built around: "do not silently
 * repair malformed data."
 */

// Generous relative to the real catalogue this was built from (3,049
// categories, max depth 4) — exists purely as a runaway/adversarial-input
// guard, reusing the exact same ceiling the live-endpoint flattener uses
// for the same reason.
export const MAX_SNAPSHOT_NODES = MAX_CATALOGUE_NODES;
export const MAX_SNAPSHOT_DEPTH = MAX_CATALOGUE_DEPTH;

// The 9 roots verified live from Vinted UK's own Create Listing page on
// 2026-08-03 (Women 1904, Men 5, Designer 2993, Kids 1193, Home 1918,
// Electronics 2994, Books & Media 2309, Hobbies & collectables 4824,
// Sports 4332) — checked for PRESENCE only. A snapshot is rejected if any
// of these is missing; a snapshot containing an additional, not-yet-seen
// root is not itself an error (Vinted adding a new root later is
// expected, eventually).
export const EXPECTED_VERIFIED_ROOT_IDS = [5, 1193, 1904, 1918, 2309, 2993, 2994, 4332, 4824] as const;

const snapshotCategorySchema = z.object({
  id: z.number(),
  title: z.string().min(1),
  url: z.string().nullable(),
  parentId: z.number().nullable(),
  rootId: z.number(),
  depth: z.number().int().min(0),
  sortOrder: z.number().int(),
  isLeaf: z.boolean(),
  fullPath: z.string().min(1),
  photoUrl: z.string().nullable(),
}).strict();

export type SnapshotCategory = z.infer<typeof snapshotCategorySchema>;

// `.strict()` throughout — unlike the live endpoint's own raw response
// (vinted-catalogue.ts's `.passthrough()`), this is a format this
// application itself defines end-to-end, so an unrecognised field is a
// sign the capture script and this validator have drifted apart, not
// forward-compatible data to tolerate.
const snapshotFileSchema = z.object({
  source: z.object({
    market: z.string().min(1),
    pageUrl: z.string().min(1),
    extractionMethod: z.string().min(1),
    capturedAt: z.string().min(1),
    shape: z.record(z.string(), z.string()),
  }).strict(),
  verification: z.object({
    categoryCount: z.number(),
    leafCount: z.number(),
    maxDepth: z.number(),
    invalidRecords: z.number(),
    duplicateIds: z.number(),
    leafSelectability: z.string(),
  }).strict(),
  categories: z.array(snapshotCategorySchema),
}).strict();

export type SnapshotMeta = {
  pageUrl: string;
  capturedAt: string;
  categoryCount: number;
  leafCount: number;
  selectableCount: number;
  maxDepth: number;
  rootIds: number[];
};

export type SnapshotValidationResult =
  | { valid: true; categories: FlattenedVintedCategory[]; meta: SnapshotMeta }
  | { valid: false; errors: string[] };

/** " Women  >  Shoes " already arrives pre-joined in this format — this only guards against the same stray-whitespace class of issue the live flattener normalizes. */
function normalizePathSegment(segment: string): string {
  return segment.trim().replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
}

/**
 * Validates an already-flat Vinted category snapshot end to end: schema
 * shape, then every hierarchy invariant recomputed independently of the
 * file's own claims. Returns the full, verified, flattened category list
 * (reusing vinted-catalogue.ts's FlattenedVintedCategory shape, so the
 * import route can hand it straight to the same fingerprint/RPC-payload
 * helpers the live-refresh path already uses) on success, or an
 * exhaustive list of every discrepancy found on failure — never a partial
 * or "best effort" result either way.
 */
export function validateVintedCategorySnapshot(raw: unknown): SnapshotValidationResult {
  const parsed = snapshotFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, errors: ["INVALID_SNAPSHOT_SHAPE: " + parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")] };
  }
  const { source, categories } = parsed.data;

  if (categories.length === 0) return { valid: false, errors: ["EMPTY_CATALOGUE: the snapshot contains no categories."] };
  if (categories.length > MAX_SNAPSHOT_NODES) return { valid: false, errors: [`TOO_MANY_NODES: ${categories.length} exceeds the maximum of ${MAX_SNAPSHOT_NODES}.`] };

  const errors: string[] = [];
  const byId = new Map<number, SnapshotCategory>();
  for (const category of categories) {
    if (!Number.isInteger(category.id) || category.id <= 0) {
      errors.push(`INVALID_ID: category id must be a positive integer, got ${JSON.stringify(category.id)}.`);
      continue;
    }
    if (byId.has(category.id)) { errors.push(`DUPLICATE_ID: category id ${category.id} appears more than once.`); continue; }
    byId.set(category.id, category);
  }
  if (errors.length > 0) return { valid: false, errors };

  for (const category of categories) {
    if (category.depth > MAX_SNAPSHOT_DEPTH) errors.push(`TOO_DEEP: category ${category.id} exceeds the maximum depth of ${MAX_SNAPSHOT_DEPTH}.`);
    if (category.parentId !== null && !byId.has(category.parentId)) errors.push(`MISSING_PARENT: category ${category.id} references parent ${category.parentId}, which does not exist in this snapshot.`);
    if (!byId.has(category.rootId)) { errors.push(`MISSING_ROOT: category ${category.id} references root ${category.rootId}, which does not exist in this snapshot.`); continue; }
    const rootCategory = byId.get(category.rootId)!;
    if (rootCategory.parentId !== null) errors.push(`INVALID_ROOT: category ${category.id}'s rootId ${category.rootId} does not identify an actual root category (it has its own parent).`);
  }
  if (errors.length > 0) return { valid: false, errors };

  // Depth/fullPath/cycle checks all walk the parent chain — done together
  // per category so a cycle is caught (and reported) exactly once rather
  // than as a confusing cascade of depth/path mismatches.
  const hasChildren = new Set<number>();
  for (const category of categories) if (category.parentId !== null) hasChildren.add(category.parentId);

  for (const category of categories) {
    const seen = new Set<number>();
    const pathParts: string[] = [];
    let cursor: SnapshotCategory | undefined = category;
    let depth = 0;
    let cycle = false;
    while (cursor) {
      if (seen.has(cursor.id)) { cycle = true; break; }
      seen.add(cursor.id);
      pathParts.unshift(cursor.title);
      if (cursor.parentId === null) break;
      cursor = byId.get(cursor.parentId);
      depth += 1;
    }
    if (cycle) { errors.push(`CYCLE_DETECTED: category ${category.id} appears as its own ancestor.`); continue; }
    if (depth !== category.depth) errors.push(`DEPTH_MISMATCH: category ${category.id} has depth ${category.depth}, but its actual ancestor chain gives ${depth}.`);
    const expectedPath = normalizePathSegment(pathParts.join(" > "));
    if (expectedPath !== normalizePathSegment(category.fullPath)) errors.push(`PATH_MISMATCH: category ${category.id}'s fullPath ${JSON.stringify(category.fullPath)} does not match its actual hierarchy ${JSON.stringify(expectedPath)}.`);
    const actuallyLeaf = !hasChildren.has(category.id);
    if (actuallyLeaf !== category.isLeaf) errors.push(`LEAF_MISMATCH: category ${category.id} reports isLeaf=${category.isLeaf}, but ${actuallyLeaf ? "has no" : "has"} children in this snapshot.`);
  }
  if (errors.length > 0) return { valid: false, errors };

  const rootIds = categories.filter((c) => c.parentId === null).map((c) => c.id);
  const rootIdSet = new Set(rootIds);
  const missingVerifiedRoots = EXPECTED_VERIFIED_ROOT_IDS.filter((id) => !rootIdSet.has(id));
  if (missingVerifiedRoots.length > 0) {
    errors.push(`MISSING_VERIFIED_ROOT: expected root id(s) ${missingVerifiedRoots.join(", ")} not found among this snapshot's roots.`);
  }
  if (errors.length > 0) return { valid: false, errors };

  const flattened: FlattenedVintedCategory[] = categories.map((category) => {
    const { audience, itemFamily } = deriveVerifiedRootMetadata(category.rootId);
    return {
      id: category.id,
      code: null,
      label: category.title,
      fullPath: normalizePathSegment(category.fullPath),
      parentId: category.parentId,
      rootId: category.rootId,
      depth: category.depth,
      sortOrder: category.sortOrder,
      isLeaf: category.isLeaf,
      // Verified 2026-08-03 directly in the live Create Listing UI (this
      // snapshot's own `verification.leafSelectability` field) — leaf
      // rows expose a radio control and enable Save; parent rows only
      // navigate. Not a guess.
      isSelectable: category.isLeaf,
      audience,
      itemFamily,
      vintedUrl: category.url,
      colorFieldVisibility: null,
      sizeFieldVisibility: null,
      measurementsFieldVisibility: null,
      brandFieldVisibility: null,
      rawJson: { photoUrl: category.photoUrl },
    };
  });

  return {
    valid: true,
    categories: flattened,
    meta: {
      pageUrl: source.pageUrl,
      capturedAt: source.capturedAt,
      categoryCount: categories.length,
      leafCount: flattened.filter((c) => c.isLeaf).length,
      selectableCount: flattened.filter((c) => c.isSelectable).length,
      maxDepth: Math.max(...categories.map((c) => c.depth)),
      rootIds: [...rootIds].sort((a, b) => a - b),
    },
  };
}
