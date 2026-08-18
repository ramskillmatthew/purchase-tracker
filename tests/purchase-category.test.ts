import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { purchaseCategories, purchaseInputSchema, resolveCategoryText } from "@/lib/validation/purchase";
import { importColumns, parseImportCategory } from "@/lib/purchase-import-sheet/schema";
import { purchaseExportColumns } from "@/lib/exportColumns";
import { buildPurchaseSearchText } from "@/lib/purchase-search";
import type { Purchase } from "@/lib/types";

describe("purchaseCategories — canonical values", () => {
  it("REQUIREMENT: the exact five-value canonical set", () => {
    expect(purchaseCategories).toEqual(["Pokémon", "Non-Pokémon TCG", "Clothing", "Footwear", "Other"]);
  });

  it("REGRESSION: Lorcana is no longer a standalone category — replaced by the broader Non-Pokémon TCG bucket", () => {
    expect(purchaseCategories as readonly string[]).not.toContain("Lorcana");
  });

  it("Other is present as the safe default target", () => {
    expect(purchaseCategories).toContain("Other");
  });
});

describe("resolveCategoryText — shared blank/typo-tolerant resolver", () => {
  it("REQUIREMENT: blank/undefined/null resolves to Other", () => {
    expect(resolveCategoryText("")).toEqual({ ok: true, value: "Other" });
    expect(resolveCategoryText("   ")).toEqual({ ok: true, value: "Other" });
    expect(resolveCategoryText(null)).toEqual({ ok: true, value: "Other" });
    expect(resolveCategoryText(undefined)).toEqual({ ok: true, value: "Other" });
  });

  it("an exact canonical value resolves to itself", () => {
    for (const category of purchaseCategories) expect(resolveCategoryText(category)).toEqual({ ok: true, value: category });
  });

  it("matches case-insensitively", () => {
    expect(resolveCategoryText("pokémon")).toEqual({ ok: true, value: "Pokémon" });
    expect(resolveCategoryText("CLOTHING")).toEqual({ ok: true, value: "Clothing" });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveCategoryText("  Footwear  ")).toEqual({ ok: true, value: "Footwear" });
  });

  it("REQUIREMENT: rejects a typo explicitly rather than silently coercing it", () => {
    expect(resolveCategoryText("Pokemon")).toEqual({ ok: false }); // missing accent
    expect(resolveCategoryText("Shoes")).toEqual({ ok: false });
    expect(resolveCategoryText("Toys")).toEqual({ ok: false });
  });
});

describe("purchaseInputSchema — category validation", () => {
  const base = {
    order_date: "2026-08-17", purchased_from: "Vinted", sku: "SKU1", item_description: "Item", item_size: "M",
    quantity: 1, item_condition: "Brand new", price_purchased: 10, category: "Other",
  };

  it("REQUIREMENT: accepts every canonical category", () => {
    for (const category of purchaseCategories) expect(purchaseInputSchema.safeParse({ ...base, category }).success).toBe(true);
  });

  it("REQUIREMENT: rejects an invalid category", () => {
    expect(purchaseInputSchema.safeParse({ ...base, category: "Toys" }).success).toBe(false);
  });

  it("REQUIREMENT: category is required — a manual submission omitting it is rejected", () => {
    const { category: _category, ...withoutCategory } = base;
    expect(purchaseInputSchema.safeParse(withoutCategory).success).toBe(false);
  });
});

describe("components/PurchaseForm.tsx — Category field (structural, no React test harness in this project)", () => {
  const source = readFileSync("components/PurchaseForm.tsx", "utf8");

  it("imports the shared canonical category list rather than a local copy", () => {
    expect(source).toContain("purchaseCategories");
    expect(source).toContain('from "@/lib/validation/purchase"');
  });

  it("renders a required Category select populated from purchaseCategories", () => {
    expect(source).toContain('<select className="input" name="category" required defaultValue={purchase?.category ?? "Other"}>{purchaseCategories.map(x => <option key={x}>{x}</option>)}</select>');
  });
});

describe("app/purchases/[id]/page.tsx — shows Category on the detail view", () => {
  it("adds a Category row", () => {
    const source = readFileSync("app/purchases/[id]/page.tsx", "utf8");
    expect(source).toContain('["Category", purchase.category]');
  });
});

describe("app/api/purchases/bulk/route.ts — Category handling", () => {
  const source = readFileSync("app/api/purchases/bulk/route.ts", "utf8");

  it("uses the shared resolveCategoryText resolver, not a local reimplementation", () => {
    expect(source).toContain('import { purchaseCategories, resolveCategoryText } from "@/lib/validation/purchase";');
    expect(source).toContain("resolveCategoryText(row.category)");
  });

  it("rejects an invalid category with a row-specific reason instead of silently defaulting or inserting it", () => {
    expect(source).toContain("if (!category.ok)");
    expect(source).toContain("Category row ${index + 1}: must be one of");
  });

  it("includes category in the inserted row", () => {
    expect(source).toContain("category: category.value,");
  });

  // UPDATED — the "deterministic created_at offset" this test used to check
  // for has since been replaced by a genuine numeric-SKU-aware authoritative
  // sort (see lib/purchase-order.ts and tests/purchase-order.test.ts): Bulk
  // Input's paste order was never supposed to determine saved display order,
  // and the created_at-offset hack it relied on is gone. This regression
  // check now confirms the CURRENT correct behaviour instead of the old one.
  it("REGRESSION: does not resurrect the old created_at-offset ordering hack; Category insertion is otherwise unaffected by the ordering fix", () => {
    expect(source).not.toContain("batchCreatedAt");
    expect(source).toContain("category: category.value,");
  });
});

describe("app/bulk-input/page.tsx — Category column (structural)", () => {
  const source = readFileSync("app/bulk-input/page.tsx", "utf8");

  it("adds category to the Field union and the fields column list", () => {
    expect(source).toMatch(/type Field = "order_date" \| "purchased_from" \| "seller_name" \| "sku" \| "arrived" \| "item_description" \| "item_size" \| "item_condition" \| "category" \| "price_purchased";/);
    expect(source).toContain('{ key: "category", label: "Category"');
  });

  it("REQUIREMENT: does not disrupt column alignment — both the preview header sort order and the row-cell render order include category in the same position", () => {
    const headerOrderIdx = source.indexOf('["order_date", "purchased_from", "seller_name", "sku", "arrived", "item_description", "item_size", "item_condition", "category"]');
    const rowOrderIdx = source.indexOf('(["order_date", "purchased_from", "seller_name", "sku", "arrived", "item_description", "item_size", "item_condition", "category", "price_purchased"] as Field[])');
    expect(headerOrderIdx).toBeGreaterThan(-1);
    expect(rowOrderIdx).toBeGreaterThan(-1);
  });

  it("the empty-preview row colSpan accounts for the new column (was 10, now 11: # + 9 fields + price)", () => {
    expect(source).toContain("colSpan={11}");
    expect(source).not.toContain("colSpan={10}");
  });

  it("blank category is valid (defaults server-side); a non-blank value must match a canonical category", () => {
    expect(source).toContain("function categoryIsValid(value: string) {");
    expect(source).toContain("if (!categoryIsValid(values.category)) errors.push(\"category\");");
  });

  it("includes category in the save payload sent to the bulk-save API", () => {
    expect(source).toContain("category: row.category || null,");
  });

  it("recognizes a 'Category' pasted-table heading", () => {
    expect(source).toContain('if (/category/.test(heading)) return "category";');
  });
});

describe("lib/purchase-import-sheet/schema.ts — Category is an optional import column", () => {
  it("REQUIREMENT: category is registered with required: false, unlike every other column", () => {
    const category = importColumns.find(c => c.field === "category");
    expect(category?.required).toBe(false);
    for (const column of importColumns) if (column.field !== "category") expect(column.required).toBeUndefined();
  });

  it("REQUIREMENT: a missing/blank cell defaults to Other", () => {
    expect(parseImportCategory(null)).toEqual({ ok: true, value: "Other" });
    expect(parseImportCategory("")).toEqual({ ok: true, value: "Other" });
    expect(parseImportCategory("   ")).toEqual({ ok: true, value: "Other" });
  });

  it("a valid category cell (any canonical casing) is accepted", () => {
    expect(parseImportCategory("non-pokémon tcg")).toEqual({ ok: true, value: "Non-Pokémon TCG" });
    expect(parseImportCategory("footwear")).toEqual({ ok: true, value: "Footwear" });
  });

  it("REGRESSION: Lorcana is no longer accepted — it must migrate to Non-Pokémon TCG via supabase-purchase-category-v2.sql, never re-enter through import", () => {
    expect(parseImportCategory("Lorcana")).toEqual({ ok: false, error: expect.stringContaining("must be one of") });
  });

  it("an invalid category cell is rejected with a clear reason, not silently defaulted", () => {
    const result = parseImportCategory("Toys");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be one of");
  });
});

describe("lib/spreadsheet-import/cell-parsers.ts — mapHeadings honours per-column `required`", () => {
  it("REQUIREMENT: an older file whose header row omits Category still maps successfully (not reported as missing)", async () => {
    const { mapHeadings } = await import("@/lib/spreadsheet-import/cell-parsers");
    const oldHeaderRow = importColumns.filter(c => c.field !== "category").map(c => c.heading);
    const result = mapHeadings(oldHeaderRow, importColumns);
    expect(result.ok).toBe(true);
  });

  it("REGRESSION: every other still-required column is still enforced as missing when absent", async () => {
    const { mapHeadings } = await import("@/lib/spreadsheet-import/cell-parsers");
    const headerRowMissingSku = importColumns.filter(c => c.field !== "sku").map(c => c.heading);
    const result = mapHeadings(headerRowMissingSku, importColumns);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain("sku");
  });
});

describe("lib/purchase-import-sheet/template.ts — Category column in the generated workbook", () => {
  const source = readFileSync("lib/purchase-import-sheet/template.ts", "utf8");

  it("adds a column width for category", () => {
    expect(source).toContain("category: 16");
  });

  it("adds a dropdown validation list for category using the canonical values", () => {
    expect(source).toContain("categoryColumn");
    expect(source).toContain('formulae: [`"${purchaseCategories.join(",")}"`]');
  });

  it("the autoFilter range is derived from the actual column count rather than a stale hardcoded letter", () => {
    expect(source).toContain('to: `${String.fromCharCode(64 + importColumns.length)}1`');
    expect(source).not.toContain('to: "H1"');
  });

  it("documents that Category is optional and defaults to Other", () => {
    expect(source).toContain("Category is optional");
    expect(source).toContain("defaults to Other");
  });
});

describe("components/PurchaseImportDialog.tsx — preview columns include Category", () => {
  it("adds the Category column to the preview table", () => {
    const source = readFileSync("components/PurchaseImportDialog.tsx", "utf8");
    expect(source).toContain('{ key: "category", label: "Category" }');
  });
});

describe("lib/exportColumns.ts — Category in purchase exports", () => {
  it("REQUIREMENT: exports include a Category column reading purchase.category", () => {
    const column = purchaseExportColumns.find(c => c.heading === "Category");
    expect(column).toBeDefined();
    expect(column!.value({ category: "Non-Pokémon TCG" } as Purchase)).toBe("Non-Pokémon TCG");
  });

  it("Category sits between Item Condition and Price Purchased, matching the import template's column order", () => {
    const headings = purchaseExportColumns.map(c => c.heading);
    expect(headings.indexOf("Category")).toBe(headings.indexOf("Item Condition") + 1);
    expect(headings.indexOf("Category")).toBe(headings.indexOf("Price Purchased") - 1);
  });
});

describe("lib/purchase-search.ts — category is searchable", () => {
  it("REQUIREMENT: a search term matching the category text matches the row", () => {
    const text = buildPurchaseSearchText({
      order_date: "2026-01-01", seller_name: "", item_description: "Item", item_size: "M",
      price_purchased: 10, sku: "SKU1", purchased_from: "Vinted", category: "Non-Pokémon TCG",
    });
    expect(text).toContain("non-pokémon tcg");
  });
});

describe("app/api/purchases/route.ts — quantity expansion still preserved exactly, category included in every unit row", () => {
  it("REGRESSION: quantity N still creates N rows (one per physical unit), each getting quantity: 1 and inheriting the same validated category via the same spread", () => {
    const source = readFileSync("app/api/purchases/route.ts", "utf8");
    expect(source).toContain("const purchases = Array.from({ length: quantity }, () => ({ ...purchase, quantity: 1 }));");
  });
});
