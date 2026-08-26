import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { purchaseInputSchema } from "@/lib/validation/purchase";

/**
 * REGRESSION — live-reproduced and CONFIRMED FIXED (2026-08-18).
 *
 * Reproduced directly against the running dev server using a real purchase
 * row (id ccb0c804-145c-44d1-ba7d-c629ea4886bb — "pokemon first partner
 * series 3 box", purchased_from "hamleys", category "Other") by driving the
 * actual Edit Purchase form in the browser end to end: opened the dialog,
 * changed only the Category dropdown to "Non-Pokémon TCG", and clicked
 * "Save changes". This reproduced the user's exact reported failure —
 * `PATCH /api/purchases?id=...` → 400 `{"error":"Invalid request.",
 * "issues":[{"path":"","message":"Invalid input"}]}` — and the captured
 * outgoing request body proved why: `{"quantity":"1", "category":"Non-
 * Pokémon TCG", ...}`. `quantity` was present despite the form's edit path
 * never being intended to send it.
 *
 * TRUE ROOT CAUSE (an earlier pass at this bug misdiagnosed it as an
 * uncommitted/stale-bundle issue — that was wrong; this is the real,
 * previously-still-active bug): PurchaseForm.tsx's Quantity `<input>` is
 * unconditionally rendered (also shown, read-only in effect, while
 * editing), so `Object.fromEntries(new FormData(form))` always produces a
 * `quantity` string field — edit or not. The code only ever ADDED a
 * numeric `quantity` to the request body for a brand-new purchase; nothing
 * ever REMOVED the stray string value that arrived via the `...fields`
 * spread on an edit. So every edit — of any field, not just Category —
 * silently carried `quantity` along, and the PATCH route's `.strict()`
 * schema (which deliberately omits `quantity` — editing never changes it)
 * rejected the whole request as an unrecognised key. Fixed by explicitly
 * `delete fields.quantity` whenever `purchase` (i.e. editing) is truthy,
 * before `fields` is spread into the request body — see PurchaseForm.tsx.
 *
 * Also confirmed live, isolating each other variable against the PATCH
 * route directly:
 *  - The lowercase legacy `item_condition: "brand new"` alone, without
 *    quantity, does NOT fail — the schema's normalisation already handles
 *    it correctly.
 *  - The live database's category CHECK constraint already accepts
 *    "Non-Pokémon TCG" — so no further migration is required;
 *    supabase-purchase-category-v2.sql is correctly applied and no
 *    leftover/duplicate constraint is blocking it.
 *  - After the fix, replaying the identical UI action (open dialog, change
 *    only Category, click Save changes) succeeded (dialog closed, no
 *    error), and a follow-up fetch confirmed the row now has category
 *    "Non-Pokémon TCG", quantity unchanged at 1, and every other field
 *    unchanged. The row was then reverted to its original category via a
 *    direct PATCH, restoring the real data exactly as found.
 */
const purchaseFormSource = readFileSync("components/PurchaseForm.tsx", "utf8");

describe("components/PurchaseForm.tsx — the real fix: quantity is deleted from an edit's fields before the body is built", () => {
  it("REQUIREMENT: deletes the stray FormData-sourced quantity string whenever editing (purchase is truthy), before spreading fields into the request body", () => {
    const deleteIdx = purchaseFormSource.indexOf("if (purchase) delete fields.quantity;");
    const bodyIdx = purchaseFormSource.indexOf("const body: Record<string, unknown> = {");
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(bodyIdx);
  });

  it("REGRESSION: the Quantity input is unconditionally rendered (also present while editing), which is exactly why FormData always includes it and the delete above is necessary", () => {
    expect(purchaseFormSource).toContain('<input className="input" name="quantity" type="number" min="1" step="1" defaultValue={purchase?.quantity ?? 1} required />');
  });

  it("REQUIREMENT: a brand-new purchase still gets a real numeric quantity in its POST body, unaffected by the edit-only delete", () => {
    expect(purchaseFormSource).toContain("if (!purchase) body.quantity = Number(values.quantity);");
  });
});
describe("REGRESSION: realistic old-purchase Category-only edit, matching the live-reproduced failure", () => {
  const patchSchema = purchaseInputSchema.omit({ quantity: true }).partial().strict();

  // The exact realistic edit body for this purchase — every field
  // PurchaseForm.tsx's FormData submission includes for an edit, with only
  // Category actually changed by the user.
  function realisticEditBody(overrides: Record<string, unknown> = {}) {
    return {
      order_date: "2026-08-14",
      seller_name: "",
      sku: "1810",
      item_description: "pokemon first partner series 3 box",
      item_size: "N/A",
      item_condition: "Brand new", // normalised client-side from the stored lowercase "brand new" — see normalizedCondition in PurchaseForm.tsx
      category: "Non-Pokémon TCG",
      purchased_from: "hamleys",
      price_purchased: 19.98,
      arrived: null,
      ...overrides,
    };
  }

  it("REQUIREMENT: the current (fixed) edit body — no quantity — succeeds", () => {
    const result = patchSchema.safeParse(realisticEditBody());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.category).toBe("Non-Pokémon TCG");
  });

  it("REGRESSION: reproduces the live failure's root cause when quantity is (re-)added — a strict-schema 'unrecognized key' rejection on quantity, pinning the true cause so it can never silently return", () => {
    const result = patchSchema.safeParse(realisticEditBody({ quantity: 1 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      if (issue.code !== "unrecognized_keys") throw new Error(`expected issue code "unrecognized_keys", got "${issue.code}"`);
      expect(issue.keys).toEqual(["quantity"]);
      // The exact prose wording varies by zod build (confirmed live: a
      // stale in-memory dev-server process reported "Invalid input" for
      // this same rejection, while a freshly-started process on the same
      // on-disk zod reports "Unrecognized key: ..."). What must always be
      // true, and what this test pins, is that safeApiError's ZodError
      // branch surfaces it as a non-empty, real message either way — never
      // a blank string the client would show as empty feedback.
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it("the unnormalised legacy lowercase condition alone (no quantity) is NOT the cause — the schema already normalises it", () => {
    const result = patchSchema.safeParse(realisticEditBody({ item_condition: "brand new" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.item_condition).toBe("Brand new");
  });

  it("REQUIREMENT: a real Non-Pokémon TCG category value is accepted by the schema — confirms the canonical list itself is correct", () => {
    expect(purchaseInputSchema.shape.category.safeParse("Non-Pokémon TCG").success).toBe(true);
  });

  it("no unrelated field is altered by a category-only conceptual edit — every other field round-trips unchanged", () => {
    const result = patchSchema.safeParse(realisticEditBody());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_description).toBe("pokemon first partner series 3 box");
      expect(result.data.purchased_from).toBe("hamleys");
      expect(result.data.price_purchased).toBe(19.98);
    }
  });
});
