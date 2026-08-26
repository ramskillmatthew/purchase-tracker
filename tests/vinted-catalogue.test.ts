import { describe, expect, it } from "vitest";
import {
  parseVintedCatalogueResponse,
  flattenVintedCatalogue,
  VintedCatalogueValidationError,
  MAX_CATALOGUE_DEPTH,
  MAX_CATALOGUE_NODES,
  type VintedCatalogNode,
} from "@/lib/listing-studio/vinted-catalogue";

function node(overrides: Partial<VintedCatalogNode> & { id: number; title: string }): VintedCatalogNode {
  return { code: null, path: null, url: null, catalogs: [], ...overrides };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof VintedCatalogueValidationError) return error.code;
    throw error;
  }
  throw new Error("expected fn to throw a VintedCatalogueValidationError");
}

describe("parseVintedCatalogueResponse — Live response validation", () => {
  it("accepts a valid nested response", () => {
    const result = parseVintedCatalogueResponse({
      catalogs: [node({ id: 1904, title: "Women", code: "WOMEN_ROOT", catalogs: [node({ id: 1905, title: "Shoes" })] })],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing catalogs entirely", () => {
    expect(parseVintedCatalogueResponse({}).success).toBe(false);
    expect(parseVintedCatalogueResponse({ notCatalogs: [] }).success).toBe(false);
  });

  it("rejects an empty catalogue", () => {
    expect(parseVintedCatalogueResponse({ catalogs: [] }).success).toBe(false);
  });

  it("rejects nodes with missing or non-numeric ids at the schema layer", () => {
    expect(parseVintedCatalogueResponse({ catalogs: [{ title: "Women", catalogs: [] }] }).success).toBe(false);
    expect(parseVintedCatalogueResponse({ catalogs: [{ id: "1904", title: "Women", catalogs: [] }] }).success).toBe(false);
  });

  it("tolerates unknown extra fields on a node (passthrough / forward compatibility)", () => {
    const result = parseVintedCatalogueResponse({
      catalogs: [{ id: 1904, title: "Women", catalogs: [], someBrandNewVintedField: "future" }],
    });
    expect(result.success).toBe(true);
  });

  it("tolerates boolean-or-number visibility flags mixed on the same node", () => {
    const result = parseVintedCatalogueResponse({
      catalogs: [{ id: 1904, title: "Women", catalogs: [], color_field_visibility: 1, measurements_field_visibility: false }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object / array-shaped payload (simulating a non-JSON or wrong-shape response)", () => {
    expect(parseVintedCatalogueResponse("not an object").success).toBe(false);
    expect(parseVintedCatalogueResponse(null).success).toBe(false);
    expect(parseVintedCatalogueResponse([1, 2, 3]).success).toBe(false);
  });
});

describe("flattenVintedCatalogue — invalid ids / duplicates / depth / size guards", () => {
  it("rejects a negative id", () => {
    const roots = [node({ id: -5, title: "Bad" })];
    expect(() => flattenVintedCatalogue(roots)).toThrow(VintedCatalogueValidationError);
  });

  it("rejects a zero id", () => {
    expect(errorCode(() => flattenVintedCatalogue([node({ id: 0, title: "Bad" })]))).toBe("INVALID_ID");
  });

  it("rejects a non-integer id", () => {
    expect(errorCode(() => flattenVintedCatalogue([node({ id: 1.5, title: "Bad" })]))).toBe("INVALID_ID");
  });

  it("tolerates an identical duplicate id (same label/path/parent) appearing twice", () => {
    const shared = node({ id: 99, title: "Shared" });
    const roots = [
      node({ id: 1, title: "A", catalogs: [shared] }),
    ];
    // Reference the same node object twice under the same parent to simulate a harmless repeat.
    (roots[0].catalogs as VintedCatalogNode[]).push(shared);
    const flattened = flattenVintedCatalogue(roots);
    expect(flattened.filter((c) => c.id === 99)).toHaveLength(1);
  });

  it("rejects a duplicate id with conflicting data (different parent)", () => {
    const roots = [
      node({ id: 1, title: "A", catalogs: [node({ id: 99, title: "Shared under A" })] }),
      node({ id: 2, title: "B", catalogs: [node({ id: 99, title: "Shared under B" })] }),
    ];
    expect(errorCode(() => flattenVintedCatalogue(roots))).toBe("DUPLICATE_ID_CONFLICT");
  });

  it("rejects a cycle (a node listing an ancestor as its own child)", () => {
    const child: VintedCatalogNode = node({ id: 2, title: "Child" });
    const root: VintedCatalogNode = node({ id: 1, title: "Root", catalogs: [child] });
    child.catalogs = [root]; // cycle
    expect(errorCode(() => flattenVintedCatalogue([root]))).toBe("CYCLE_DETECTED");
  });

  it("rejects excessive depth", () => {
    let deepest = node({ id: 100000, title: "Bottom" });
    for (let i = 0; i < MAX_CATALOGUE_DEPTH + 2; i++) {
      deepest = node({ id: 100000 - i - 1, title: `Level ${i}`, catalogs: [deepest] });
    }
    expect(errorCode(() => flattenVintedCatalogue([deepest]))).toBe("TOO_DEEP");
  });

  it("rejects an excessive node count", () => {
    const children = Array.from({ length: MAX_CATALOGUE_NODES + 5 }, (_, i) => node({ id: i + 2, title: `Child ${i}` }));
    const root = node({ id: 1, title: "Root", catalogs: children });
    expect(errorCode(() => flattenVintedCatalogue([root]))).toBe("TOO_MANY_NODES");
  });
});

describe("flattenVintedCatalogue — hierarchy/flattening semantics", () => {
  const tree: VintedCatalogNode[] = [
    node({
      id: 1904,
      title: "Women",
      code: "WOMEN_ROOT",
      catalogs: [
        node({
          id: 1905,
          title: "Shoes",
          path: "Women",
          catalogs: [
            node({ id: 1906, title: "Trainers", path: "Women > Shoes" }),
          ],
        }),
      ],
    }),
    node({
      id: 5,
      title: "Men",
      catalogs: [
        node({
          id: 6,
          title: "Shoes",
          path: "Men",
          catalogs: [
            node({
              id: 7,
              title: "Sports shoes",
              path: "Men > Shoes",
              catalogs: [node({ id: 8, title: "Running", path: "Men > Shoes > Sports shoes" })],
            }),
          ],
        }),
      ],
    }),
    node({ id: 1918, title: "Home" }),
  ];

  it("sets parentId from the containing node, and null for roots", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1904)!.parentId).toBeNull();
    expect(flat.find((c) => c.id === 1905)!.parentId).toBe(1904);
    expect(flat.find((c) => c.id === 1906)!.parentId).toBe(1905);
  });

  it("builds a normalized ' > ' joined full path", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 8)!.fullPath).toBe("Men > Shoes > Sports shoes > Running");
    expect(flat.find((c) => c.id === 1904)!.fullPath).toBe("Women");
  });

  it("assigns deterministic, ancestor-count-based depth", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1904)!.depth).toBe(0);
    expect(flat.find((c) => c.id === 1905)!.depth).toBe(1);
    expect(flat.find((c) => c.id === 1906)!.depth).toBe(2);
    expect(flat.find((c) => c.id === 8)!.depth).toBe(3);
  });

  it("preserves Vinted's own order via sortOrder", () => {
    const roots = [node({ id: 1, title: "First" }), node({ id: 2, title: "Second" }), node({ id: 3, title: "Third" })];
    const flat = flattenVintedCatalogue(roots);
    expect(flat.find((c) => c.id === 1)!.sortOrder).toBe(0);
    expect(flat.find((c) => c.id === 2)!.sortOrder).toBe(1);
    expect(flat.find((c) => c.id === 3)!.sortOrder).toBe(2);
  });

  it("flags leaves (empty catalogs) vs branches", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1904)!.isLeaf).toBe(false); // Women has a child
    expect(flat.find((c) => c.id === 8)!.isLeaf).toBe(true); // Running has none
    expect(flat.find((c) => c.id === 1918)!.isLeaf).toBe(true); // Home (no children in fixture)
  });

  it("derives isSelectable from isLeaf (documented assumption)", () => {
    const flat = flattenVintedCatalogue(tree);
    for (const category of flat) expect(category.isSelectable).toBe(category.isLeaf);
  });

  it("assigns rootId as the top-level ancestor's own id for every descendant", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1906)!.rootId).toBe(1904);
    expect(flat.find((c) => c.id === 8)!.rootId).toBe(5);
    expect(flat.find((c) => c.id === 1918)!.rootId).toBe(1918);
  });

  it("derives audience only from verified root ids (Women/Men/Kids), null elsewhere", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1904)!.audience).toBe("womens");
    expect(flat.find((c) => c.id === 1906)!.audience).toBe("womens");
    expect(flat.find((c) => c.id === 5)!.audience).toBe("mens");
    expect(flat.find((c) => c.id === 8)!.audience).toBe("mens");
    expect(flat.find((c) => c.id === 1918)!.audience).toBeNull();
  });

  it("derives itemFamily only from verified unambiguous roots (Home/Electronics/etc), null for fashion roots", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1918)!.itemFamily).toBe("home");
    expect(flat.find((c) => c.id === 1904)!.itemFamily).toBeNull();
    expect(flat.find((c) => c.id === 8)!.itemFamily).toBeNull();
  });

  it("normalises boolean-or-number visibility flags to real booleans", () => {
    const roots = [node({ id: 1, title: "Root", color_field_visibility: 1, measurements_field_visibility: false, brand_field_visibility: 0 })];
    const flat = flattenVintedCatalogue(roots);
    expect(flat[0].colorFieldVisibility).toBe(true);
    expect(flat[0].measurementsFieldVisibility).toBe(false);
    expect(flat[0].brandFieldVisibility).toBe(false);
  });

  it("preserves exact displayed labels and codes", () => {
    const flat = flattenVintedCatalogue(tree);
    expect(flat.find((c) => c.id === 1904)!.label).toBe("Women");
    expect(flat.find((c) => c.id === 1904)!.code).toBe("WOMEN_ROOT");
    expect(flat.find((c) => c.id === 1918)!.code).toBeNull();
  });
});
