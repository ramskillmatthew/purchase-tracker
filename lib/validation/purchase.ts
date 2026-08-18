import { z } from "zod";

export const conditions = ["Brand new", "Brand new without tags", "Labelled as very good condition", "Good condition from photos", "Decent condition from photos"] as const;

/**
 * Normalises a detailed condition string to its canonical form when it's a
 * recognised case/whitespace variant of one of the five canonical
 * `conditions` (e.g. "brand new", " Brand New " both become "Brand new") —
 * this is what stops the Edit Purchase selector from ever showing both a
 * "Historical: brand new" entry AND the real "Brand new" option side by
 * side. Any other value (including genuinely unknown historical free text,
 * e.g. "Holes in heel") is returned trimmed but otherwise UNCHANGED — never
 * guessed into a canonical bucket. Blank/null/undefined returns "".
 */
export function normalizeConditionText(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const match = conditions.find(condition => condition.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}
// The single source of truth for product category — every form, spreadsheet
// import, Bulk Input column, export, and sales snapshot reuses this exact
// array/type rather than duplicating its own copy. "Other" is deliberately
// last and doubles as the safe default for every pre-existing row and every
// import path that doesn't (yet) supply a category — see
// supabase-purchase-category.sql.
//
// "Lorcana" was replaced by "Non-Pokémon TCG" (a broader, more useful
// bucket) — supabase-purchase-category-v2.sql migrates any existing
// "Lorcana" row to "Non-Pokémon TCG" and safely defaults anything else
// unrecognized to "Other" before tightening the database constraint to this
// exact five-value list. Never reintroduce "Lorcana" as a separate value.
export const purchaseCategories = ["Pokémon", "Non-Pokémon TCG", "Clothing", "Footwear", "Other"] as const;
export type PurchaseCategory = (typeof purchaseCategories)[number];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// stock_status is deliberately optional here, never required and never
// sent by the create/edit form: a brand-new purchase gets it from the
// database column's own default ('in_stock' — see
// supabase-add-stock-status.sql), never from application code. Declaring
// it here is what lets the PATCH route's `.partial().strict()` derivation
// (app/api/purchases/route.ts) accept the row-level stock-status toggle's
// `{ stock_status }` PATCH body without a separate schema.
// Accepts a recognised case/whitespace variant of a canonical condition
// (e.g. "brand new") and normalises it to the canonical form before the
// enum check — so a legacy purchase whose stored condition is a harmless
// variant can still be saved/edited normally, and a fresh manual entry
// typed in the wrong case still resolves correctly. A genuinely unknown
// value (real historical free text) still fails this check, exactly like
// z.enum(conditions) did before — only recognised variants are normalised,
// nothing is guessed.
const itemConditionSchema = z.string().transform(normalizeConditionText).pipe(z.enum(conditions));

export const purchaseInputSchema = z.object({
  order_date: date, purchased_from: z.string().trim().min(1).max(100), seller_name: z.string().trim().max(200).nullable().optional(),
  sku: z.string().trim().max(100), item_description: z.string().trim().min(1).max(500), item_size: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().int().min(1).max(100), item_condition: itemConditionSchema, category: z.enum(purchaseCategories),
  price_purchased: z.coerce.number().nonnegative().max(99999999), arrived: z.boolean().nullable().optional(),
  stock_status: z.enum(["in_stock", "no_longer_in_stock"]).optional(),
}).strict();
export const expenseInputSchema = z.object({ purchase_date: date, purchased_from: z.string().trim().min(1).max(100), arrived: z.boolean().nullable().optional(), item_description: z.string().trim().min(1).max(500), cost: z.coerce.number().nonnegative().max(99999999) }).strict();

/**
 * Purchase-spreadsheet-import ONLY. Historical spreadsheet condition text
 * (e.g. "Holes in heel") carries real information that the five canonical
 * buckets can't represent and must never be guessed into — see the
 * purchase-import-sheet feature. This is a narrow, explicitly-scoped
 * override: every other field is reused verbatim from purchaseInputSchema,
 * which itself stays untouched and remains the only schema manual entry,
 * email import, AI extraction, Vinted import, and Edit Purchase validate
 * against. Never import this schema from any of those paths.
 */
const IMPORT_ITEM_CONDITION_MAX_LENGTH = 200;
// Deliberately matching unsafe/meaningless control characters (excluding \t\n\r, harmless in free text).
const UNSAFE_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
export const purchaseImportItemConditionSchema = z.string().trim().min(1).max(IMPORT_ITEM_CONDITION_MAX_LENGTH)
  .refine(value => !UNSAFE_CONTROL_CHARS.test(value), { message: "Item Condition contains unsupported characters." });
export const purchaseImportInputSchema = purchaseInputSchema
  .omit({ item_condition: true })
  .extend({ item_condition: purchaseImportItemConditionSchema })
  .strict();

/**
 * A stored purchase's item_condition is "historical" if it ISN'T a
 * recognised case/whitespace variant of one of the five canonical values —
 * only ever possible via a purchase spreadsheet import (see
 * purchaseImportInputSchema above), or a legacy row predating this
 * normalisation. Checked against the NORMALISED value (via
 * normalizeConditionText) so a recognised variant like "brand new" is
 * correctly treated as the canonical "Brand new" — never shown as a
 * separate "Historical: brand new" option alongside the real one. Used by
 * PurchaseForm.tsx to show and preserve genuinely unknown historical text
 * during editing, without widening what a *new* manually-entered condition
 * may be. Lives here (not in the component) so it's directly unit-testable
 * in this project's .ts-only vitest setup.
 */
export function isHistoricalCondition(value: string | undefined | null): value is string {
  const normalized = normalizeConditionText(value);
  if (!normalized) return false;
  return !(conditions as readonly string[]).includes(normalized);
}

export type CategoryResolution = { ok: true; value: PurchaseCategory } | { ok: false };

/**
 * Shared blank/typo-tolerant category resolver — reused by both Bulk Input's
 * bulk-save route (app/api/purchases/bulk/route.ts) and the purchase
 * spreadsheet importer (lib/purchase-import-sheet/schema.ts) so the exact
 * same "blank/missing defaults to Other, a non-blank value must
 * case-insensitively match one of the canonical categories" rule can never
 * drift between the two entry points. A typo (e.g. "Pokemon" without the
 * accent) is rejected explicitly rather than silently coerced or guessed.
 */
export function resolveCategoryText(value: string | null | undefined): CategoryResolution {
  const text = value?.trim();
  if (!text) return { ok: true, value: "Other" };
  const match = purchaseCategories.find(category => category.toLowerCase() === text.toLowerCase());
  return match ? { ok: true, value: match } : { ok: false };
}

/** Sensible maximum purchase UUIDs in one safe_delete_purchases call — matches the RPC's own ceiling (see supabase-safe-purchase-deletion.sql). Every purchase deletion path (single, bulk, Clear All) shares this same schema and the same underlying RPC, never a separate/inconsistent implementation. */
export const MAX_DELETE_PURCHASES = 500;

export const deletePurchasesInputSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_DELETE_PURCHASES),
}).strict()
  .refine(data => new Set(data.ids).size === data.ids.length, {
    message: "Duplicate purchase IDs are not allowed in one deletion request.", path: ["ids"],
  });
