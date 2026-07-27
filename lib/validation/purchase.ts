import { z } from "zod";

export const conditions = ["Brand new", "Brand new without tags", "Labelled as very good condition", "Good condition from photos", "Decent condition from photos"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const purchaseInputSchema = z.object({
  order_date: date, purchased_from: z.string().trim().min(1).max(100), seller_name: z.string().trim().max(200).nullable().optional(),
  sku: z.string().trim().max(100), item_description: z.string().trim().min(1).max(500), item_size: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().int().min(1).max(100), item_condition: z.enum(conditions), price_purchased: z.coerce.number().nonnegative().max(99999999), arrived: z.boolean().nullable().optional(),
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
 * A stored purchase's item_condition is "historical" if it isn't one of
 * the five canonical values — only ever possible via a purchase
 * spreadsheet import (see purchaseImportInputSchema above). Used by
 * PurchaseForm.tsx to show and preserve it during editing without
 * widening what a *new* manually-entered condition may be. Lives here
 * (not in the component) so it's directly unit-testable in this
 * project's .ts-only vitest setup.
 */
export function isHistoricalCondition(value: string | undefined | null): value is string {
  if (!value) return false;
  return !(conditions as readonly string[]).includes(value);
}
