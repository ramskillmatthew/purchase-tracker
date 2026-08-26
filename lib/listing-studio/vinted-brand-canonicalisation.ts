/**
 * Follow-up correction: the AI listing-generation call sometimes reports
 * the manufacturer as "On" (a natural reading of the logo/label), but
 * Vinted's own selectable manufacturer brand is "On Running" — "On" alone
 * is not a real Vinted brand option, so the extension's exact-match brand
 * search (vinted-draft-queue-extension/shared/form-steps.js's
 * stepSelectBrand) can never find it.
 *
 * This is the ONE deterministic rule, applied after AI parsing and before
 * a generated draft is persisted (lib/listing-studio's own convention —
 * see size-conversion.ts, vinted-category-selection.ts — of correctness
 * never depending solely on prompt wording). Exact, case-insensitive,
 * whitespace-trimmed match only — never a substring/prefix rule — so
 * brands that merely contain "on" (e.g. "On Cloud", "On Line", "London",
 * "Moncler") are left completely untouched.
 */
export function canonicaliseVintedBrand(brand: string | null): string | null {
  if (brand === null) return null;
  return brand.trim().toLowerCase() === "on" ? "On Running" : brand;
}
