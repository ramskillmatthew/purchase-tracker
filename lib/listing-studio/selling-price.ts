import { poundsToPence } from "@/lib/purchase-import/allocate";

/**
 * Milestone 6 (purchase-price lookup and manual Vinted selling price) — the
 * user-entered "what I'm listing this for on Vinted" price. Reuses
 * listing_drafts.confirmed_price_pence (defined in Milestone 1's schema,
 * never populated or read by any feature since — confirmed via a live
 * database query before writing this) rather than adding a new column.
 * suggested_price_pence is deliberately never touched here — this feature
 * has no AI-suggested price, only a user-entered one.
 *
 * Pure and DB-free, like vinted-category-selection.ts's own pure half —
 * used both server-side (the authoritative save-time validation) and
 * client-side (instant feedback before a network round-trip even starts).
 */

// A generous ceiling for a single resold item on Vinted — well beyond any
// realistic sneaker/streetwear resale price this app tracks, but still a
// meaningful guard against a fat-finger/overflow entry (e.g. an extra
// digit). Not tied to the database column's own check (`>= 0`, no upper
// bound) — that constraint only guards column overflow, this guards
// real-world sense.
export const MAX_SELLING_PRICE_PENCE = 100_000_00; // £100,000

export type SellingPriceParseResult =
  | { valid: true; pence: number }
  | { valid: false; error: string };

/**
 * Parses a user-entered pounds amount (as typed — "45", "45.00", "45.5",
 * a leading "£", surrounding whitespace) into integer pence. The single
 * source of truth for what counts as a valid selling price — the save
 * route calls this itself rather than trusting any pence value the client
 * might compute, so a listing can never be persisted with a value this
 * function itself wouldn't accept.
 *
 * Rejects: blank, negative, more than 2 decimal places (a fractional
 * penny — matches lib/purchase-import/pence.ts's isWholePennyAmount
 * reasoning, never accepted for money), zero, and anything above
 * MAX_SELLING_PRICE_PENCE. Never uses floating-point arithmetic for the
 * persisted value — poundsToPence rounds once, at the very end.
 */
export function parseSellingPricePounds(input: string): SellingPriceParseResult {
  const trimmed = input.trim().replace(/^£\s*/, "");
  if (!trimmed) return { valid: false, error: "Enter a selling price." };
  if (trimmed.startsWith("-")) return { valid: false, error: "Selling price cannot be negative." };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { valid: false, error: "Enter a valid amount, e.g. 45.00." };

  const pence = poundsToPence(Number(trimmed));
  if (pence <= 0) return { valid: false, error: "Enter a selling price greater than £0." };
  if (pence > MAX_SELLING_PRICE_PENCE) {
    return { valid: false, error: `Enter a selling price under £${(MAX_SELLING_PRICE_PENCE / 100).toLocaleString("en-GB")}.` };
  }
  return { valid: true, pence };
}

/** `null`/non-finite formats as "" — callers decide their own "not set" copy; this never invents a £0.00. */
export function formatPenceAsGBP(pence: number | null | undefined): string {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return "";
  return `£${(pence / 100).toFixed(2)}`;
}
