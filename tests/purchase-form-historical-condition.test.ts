import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { conditions, isHistoricalCondition, normalizeConditionText, purchaseInputSchema } from "@/lib/validation/purchase";

describe("isHistoricalCondition", () => {
  it("REQUIREMENT 16: recognises every canonical condition as NOT historical", () => {
    for (const condition of conditions) expect(isHistoricalCondition(condition)).toBe(false);
  });

  it("recognises a factual free-text description as historical", () => {
    expect(isHistoricalCondition("Holes in heel")).toBe(true);
    expect(isHistoricalCondition("Scuffs on toe box")).toBe(true);
  });

  it("treats blank/undefined/null as not historical (nothing to preserve)", () => {
    expect(isHistoricalCondition("")).toBe(false);
    expect(isHistoricalCondition(undefined)).toBe(false);
    expect(isHistoricalCondition(null)).toBe(false);
  });

  it("BUGFIX: a lowercase/whitespace variant of a canonical condition is NOT historical — this is what stopped the duplicate 'Historical: brand new' entry from appearing alongside the real 'Brand new' option", () => {
    expect(isHistoricalCondition("brand new")).toBe(false);
    expect(isHistoricalCondition("BRAND NEW")).toBe(false);
    expect(isHistoricalCondition("  Brand new  ")).toBe(false);
    expect(isHistoricalCondition("brand new without tags")).toBe(false);
  });
});

describe("normalizeConditionText", () => {
  it("normalises a recognised case/whitespace variant to the exact canonical string", () => {
    expect(normalizeConditionText("brand new")).toBe("Brand new");
    expect(normalizeConditionText("BRAND NEW")).toBe("Brand new");
    expect(normalizeConditionText("  Brand New  ")).toBe("Brand new");
    expect(normalizeConditionText("good condition from photos")).toBe("Good condition from photos");
  });

  it("REQUIREMENT: leaves genuinely unknown historical text unchanged (only trimmed) — never guessed into a canonical bucket", () => {
    expect(normalizeConditionText("Holes in heel")).toBe("Holes in heel");
    expect(normalizeConditionText("  Scuffs on toe box  ")).toBe("Scuffs on toe box");
  });

  it("blank/null/undefined normalises to an empty string", () => {
    expect(normalizeConditionText("")).toBe("");
    expect(normalizeConditionText("   ")).toBe("");
    expect(normalizeConditionText(null)).toBe("");
    expect(normalizeConditionText(undefined)).toBe("");
  });

  it("every canonical condition normalises to itself (idempotent)", () => {
    for (const condition of conditions) expect(normalizeConditionText(condition)).toBe(condition);
  });
});

describe("REQUIREMENT 11/12/17: purchaseInputSchema itself stays canonical-only — every non-import purchase-creation path is unaffected", () => {
  it("still rejects a historical/free-text condition for ordinary manual purchase creation", () => {
    const candidate = {
      order_date: "2026-07-24", purchased_from: "Vinted", seller_name: null, sku: "1801",
      item_description: "Nike Air Max 95", item_size: "9", quantity: 1, category: "Other",
      item_condition: "Holes in heel", price_purchased: 13.49, arrived: null,
    };
    const result = purchaseInputSchema.safeParse(candidate);
    expect(result.success).toBe(false);
  });

  it("still accepts only the five canonical conditions", () => {
    for (const condition of conditions) {
      const result = purchaseInputSchema.safeParse({
        order_date: "2026-07-24", purchased_from: "Vinted", seller_name: null, sku: "1801",
        item_description: "Nike Air Max 95", item_size: "9", quantity: 1, category: "Other",
        item_condition: condition, price_purchased: 13.49, arrived: null,
      });
      expect(result.success).toBe(true);
    }
  });

  it("BUGFIX: normalises a recognised case/whitespace legacy variant before validating, rather than rejecting it outright", () => {
    const result = purchaseInputSchema.safeParse({
      order_date: "2026-07-24", purchased_from: "Vinted", seller_name: null, sku: "1801",
      item_description: "Nike Air Max 95", item_size: "9", quantity: 1, category: "Other",
      item_condition: "brand new", price_purchased: 13.49, arrived: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.item_condition).toBe("Brand new");
  });

  it("still rejects genuinely unknown historical text — normalisation never widens what a fresh manual entry may store", () => {
    const result = purchaseInputSchema.safeParse({
      order_date: "2026-07-24", purchased_from: "Vinted", seller_name: null, sku: "1801",
      item_description: "Nike Air Max 95", item_size: "9", quantity: 1, category: "Other",
      item_condition: "Holes in heel", price_purchased: 13.49, arrived: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("BUGFIX: PATCH schema (partial, quantity-omitted) accepts a category-only edit on a legacy purchase with an unnormalised condition", () => {
  const patchSchema = purchaseInputSchema.omit({ quantity: true }).partial().strict();

  it("REQUIREMENT: sending quantity on a PATCH is rejected by the strict schema — this is exactly what made every edit fail with 'Invalid request.' before the client-side fix (PurchaseForm.tsx no longer sends quantity on edit — see the structural check below)", () => {
    const result = patchSchema.safeParse({ category: "Other", quantity: 3 });
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: a category-only edit (no item_condition at all) succeeds, changing nothing else", () => {
    const result = patchSchema.safeParse({ category: "Footwear" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ category: "Footwear" });
  });

  it("REQUIREMENT: if item_condition IS re-sent unchanged as a recognised legacy variant (e.g. the client's historical-preservation match fails for some reason), the server-side normalisation still accepts it rather than rejecting the whole request", () => {
    const result = patchSchema.safeParse({ category: "Other", item_condition: "brand new" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.item_condition).toBe("Brand new");
  });

  it("a recognised old category value migrated by supabase-purchase-category-v2.sql (e.g. Non-Pokémon TCG) can be set via a normal edit", () => {
    const result = patchSchema.safeParse({ category: "Non-Pokémon TCG" });
    expect(result.success).toBe(true);
  });

  it("no unrelated fields are required or defaulted — a partial edit only ever carries the keys actually sent", () => {
    const result = patchSchema.safeParse({ seller_name: "New Seller" });
    expect(result.success).toBe(true);
    if (result.success) expect(Object.keys(result.data)).toEqual(["seller_name"]);
  });
});

describe("PurchaseForm.tsx structural checks (no React testing harness in this project — mirrors the codebase's existing route-level structural-test convention)", () => {
  const source = readFileSync("components/PurchaseForm.tsx", "utf8");

  it("REQUIREMENT 17: never renders a free-text input for Item Condition — only the canonical/historical <select>, so a new manual purchase can never introduce new free text", () => {
    expect(source).not.toMatch(/name="item_condition"[^>]*<input/);
    expect(source).toContain('name="item_condition"');
    expect(source).toContain("<select");
  });

  it("REQUIREMENT 17: the historical option can only ever appear when editing an existing purchase, never when creating a new one", () => {
    // historicalCondition is derived from `purchase?.item_condition` and purchase is undefined in create mode
    expect(source).toContain("isHistoricalCondition(purchase?.item_condition)");
    expect(source).toContain("{historicalCondition &&");
  });

  it("REQUIREMENT 15: an unchanged historical condition is omitted from the save request rather than re-sent through the canonical-only PATCH schema", () => {
    expect(source).toContain("delete fields.item_condition");
  });

  it("REQUIREMENT: uses the normalised condition (not the raw stored value) for both the historical-option value and the select's defaultValue, so a recognised variant never renders as a duplicate historical entry", () => {
    expect(source).toContain("const normalizedCondition = normalizeConditionText(purchase?.item_condition);");
    expect(source).toContain("const historicalCondition = isHistoricalCondition(purchase?.item_condition) ? normalizedCondition : null;");
    expect(source).toContain('defaultValue={normalizedCondition}');
  });

  it("BUGFIX: quantity is only ever included in the request body when creating a new purchase, never on an edit — sending it on PATCH violated the route's strict, quantity-omitted schema and made every edit fail with 'Invalid request.', regardless of which field the user actually changed", () => {
    expect(source).toContain("if (!purchase) body.quantity = Number(values.quantity);");
    // The body literal itself must not unconditionally set quantity anymore.
    const bodyLiteral = source.slice(source.indexOf("const body: Record<string, unknown> = {"), source.indexOf("};", source.indexOf("const body: Record<string, unknown> = {")));
    expect(bodyLiteral).not.toContain("quantity");
  });

  it("BUGFIX: surfaces field-specific validation feedback from the server's `issues` array instead of only the generic top-level 'Invalid request.' message", () => {
    const fn = source.slice(source.indexOf("} else {"), source.indexOf("setSaving(false);"));
    expect(fn).toContain("failure?.issues");
    expect(fn).toContain("setError(detail || failure?.error || \"Could not save purchase.\");");
  });

  it("REGRESSION: still falls back to a safe message if the server response can't even be parsed as JSON", () => {
    expect(source).toContain("await res.json().catch(() => null)");
  });
});
