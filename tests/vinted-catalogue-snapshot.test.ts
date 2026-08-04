import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateVintedCategorySnapshot, EXPECTED_VERIFIED_ROOT_IDS } from "@/lib/listing-studio/vinted-catalogue-snapshot";

// A real, genuine capture (copied into the repo as a portable fixture —
// see this file's own describe block below for why this isn't read from
// the original session-specific upload path).
const FIXTURE_PATH = path.join(__dirname, "fixtures", "vinted-category-catalogue-2026-08-03.json");

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, title: "Root", url: "/catalog/1-root", parentId: null, rootId: 1,
    depth: 0, sortOrder: 0, isLeaf: true, fullPath: "Root", photoUrl: null,
    ...overrides,
  };
}
function snapshot(categories: unknown[]) {
  return {
    source: { market: "Vinted UK", pageUrl: "https://www.vinted.co.uk/items/new", extractionMethod: "Signed-in Create Listing page embedded catalogTree", capturedAt: "2026-08-03T20:57:01.525Z", shape: { id: "number" } },
    verification: { categoryCount: categories.length, leafCount: 0, maxDepth: 0, invalidRecords: 0, duplicateIds: 0, leafSelectability: "verified" },
    categories,
  };
}
function withAllVerifiedRoots(extra: unknown[] = []) {
  const roots = EXPECTED_VERIFIED_ROOT_IDS.map((id) => category({ id, title: `Root ${id}`, rootId: id, fullPath: `Root ${id}` }));
  return [...roots, ...extra];
}

describe("validateVintedCategorySnapshot — the genuine attached file (2026-08-03 capture)", () => {
  it("passes every validation check with zero discrepancies and recomputes the exact verified totals", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    const result = validateVintedCategorySnapshot(raw);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.meta.categoryCount).toBe(3049);
      expect(result.meta.leafCount).toBe(2619);
      expect(result.meta.selectableCount).toBe(2619);
      expect(result.meta.maxDepth).toBe(4);
      expect(result.categories).toHaveLength(3049);
      expect(result.meta.rootIds).toEqual([5, 1193, 1904, 1918, 2309, 2993, 2994, 4332, 4824]);
    }
  });

  it("every returned category is flagged isSelectable exactly when isLeaf, per the verified Create Listing UI behaviour", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    const result = validateVintedCategorySnapshot(raw);
    expect(result.valid).toBe(true);
    if (result.valid) for (const c of result.categories) expect(c.isSelectable).toBe(c.isLeaf);
  });

  it("the 8 named clothing/footwear branches exist with the expected ids and titles", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    const result = validateVintedCategorySnapshot(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const byId = new Map(result.categories.map((c) => [c.id, c]));
    expect(byId.get(4)?.fullPath).toBe("Women > Clothing");
    expect(byId.get(16)?.fullPath).toBe("Women > Shoes");
    expect(byId.get(2050)?.fullPath).toBe("Men > Clothing");
    expect(byId.get(1231)?.fullPath).toBe("Men > Shoes");
    expect(byId.get(1195)?.fullPath).toBe("Kids > Girls clothing");
    expect(byId.get(1255)?.fullPath).toBe("Kids > Girls clothing > Shoes");
    expect(byId.get(1194)?.fullPath).toBe("Kids > Boys clothing");
    expect(byId.get(1256)?.fullPath).toBe("Kids > Boys clothing > Shoes");
  });
});

describe("validateVintedCategorySnapshot — rejection of every malformed/inconsistent case (never silently repaired)", () => {
  it("rejects an empty catalogue", () => {
    expect(validateVintedCategorySnapshot(snapshot([])).valid).toBe(false);
  });

  it("rejects a snapshot missing the source/verification metadata", () => {
    expect(validateVintedCategorySnapshot({ categories: withAllVerifiedRoots() }).valid).toBe(false);
  });

  it("rejects a duplicate category id", () => {
    const cats = withAllVerifiedRoots([category({ id: 100, rootId: 5, parentId: 5 }), category({ id: 100, rootId: 5, parentId: 5 })]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("DUPLICATE_ID"))).toBe(true);
  });

  it("rejects a negative or zero id", () => {
    const cats = withAllVerifiedRoots([category({ id: 0, rootId: 5, parentId: 5 })]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
  });

  it("rejects a reference to a parent that doesn't exist in the snapshot", () => {
    const cats = withAllVerifiedRoots([category({ id: 100, rootId: 5, parentId: 99999 })]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("MISSING_PARENT"))).toBe(true);
  });

  it("rejects a rootId that doesn't exist in the snapshot at all", () => {
    const cats = withAllVerifiedRoots([category({ id: 100, rootId: 424242, parentId: null })]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("MISSING_ROOT"))).toBe(true);
  });

  it("rejects a rootId that exists but isn't itself an actual root (has a parent)", () => {
    const cats = withAllVerifiedRoots([
      category({ id: 100, rootId: 5, parentId: 5 }),
      category({ id: 101, rootId: 100, parentId: 100 }), // rootId points at a non-root category
    ]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("INVALID_ROOT"))).toBe(true);
  });

  it("rejects a depth that doesn't match the actual ancestor chain", () => {
    const cats = withAllVerifiedRoots([category({ id: 100, rootId: 5, parentId: 5, depth: 5, fullPath: "Root 5 > Wrong" })]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("DEPTH_MISMATCH"))).toBe(true);
  });

  it("rejects a fullPath that doesn't match the actual hierarchy", () => {
    const cats = withAllVerifiedRoots([category({ id: 100, rootId: 5, parentId: 5, depth: 1, fullPath: "Totally Wrong > Path" })]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("PATH_MISMATCH"))).toBe(true);
  });

  it("rejects an isLeaf flag that disagrees with whether any category has it as a parent", () => {
    const cats = withAllVerifiedRoots([
      category({ id: 100, rootId: 5, parentId: 5, depth: 1, fullPath: "Root 5 > Child", isLeaf: true }),
      category({ id: 101, rootId: 5, parentId: 100, depth: 2, fullPath: "Root 5 > Child > Grandchild", isLeaf: true }),
    ]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("LEAF_MISMATCH"))).toBe(true);
  });

  it("rejects a cycle", () => {
    const cats = [
      category({ id: 200, rootId: 200, parentId: null, depth: 0, fullPath: "Root" }),
      category({ id: 201, rootId: 200, parentId: 202, depth: 2, fullPath: "Root > A > B" }),
      category({ id: 202, rootId: 200, parentId: 201, depth: 2, fullPath: "Root > B > A" }),
    ];
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("CYCLE_DETECTED"))).toBe(true);
  });

  it("rejects a snapshot missing one of the 9 verified roots", () => {
    const cats = EXPECTED_VERIFIED_ROOT_IDS.slice(1).map((id) => category({ id, title: `Root ${id}`, rootId: id, fullPath: `Root ${id}` }));
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("MISSING_VERIFIED_ROOT"))).toBe(true);
  });

  it("never trusts the file's own reported totals — incorrect verification.categoryCount does not cause rejection or repair on its own, only the recomputed structure matters", () => {
    const cats = withAllVerifiedRoots();
    const file = snapshot(cats);
    file.verification.categoryCount = 999999; // deliberately wrong
    const result = validateVintedCategorySnapshot(file);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.meta.categoryCount).toBe(cats.length); // recomputed, not the file's false claim
  });

  it("rejects an unrecognised extra field on a category record (.strict())", () => {
    const cats = withAllVerifiedRoots([{ ...category({ id: 100, rootId: 5, parentId: 5 }), extra: true }]);
    const result = validateVintedCategorySnapshot(snapshot(cats));
    expect(result.valid).toBe(false);
  });
});
