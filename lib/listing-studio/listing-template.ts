/**
 * Milestone 4 (AI listing generation) — the ONLY place a marketplace
 * listing title/description is ever produced. Pure, deterministic, no AI
 * call: the AI (lib/listing-studio/listing-generation-schemas.ts) returns
 * only structured product fields; these functions derive the title and
 * description from them. This is deliberate architecture, not a
 * convenience — the structured fields are the canonical, editable source
 * of truth (stored on the draft), and title/description are always
 * *derived* from them, never independently edited. If the templates below
 * ever change, re-running these functions against the same stored
 * structured fields regenerates every existing listing instantly, with no
 * new AI call.
 */

export type GeneratedListingFields = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  // Milestone 6 (Vinted-aware colours/materials): up to 2 exact Vinted
  // colour-list values (see lib/listing-studio/listing-generation-schemas.ts's
  // VINTED_COLOURS) — never free text. Empty array, never null, when none
  // is set.
  colours: string[];
  // Milestone 6: a single exact Vinted material-list value, or null.
  // Not part of the title/description below (neither ever referenced a
  // material field before this milestone, and neither does now) — it's
  // stored/edited/displayed alongside the other structured fields only.
  material: string | null;
  ukSize: string | null;
  sku: string | null;
};

// "Never vary this wording" — the one fixed, non-editable condition value
// every generated listing uses. Not a structured field: there is nothing
// to store per-draft, since it never changes.
export const LISTING_CONDITION_TEXT = "Very Good Condition";

function normalizePart(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Exact format: `Brand Model Product Type - "Colour" - Very Good Condition - Size UK X`.
 * Any missing structured field (brand/model/productType/colours/ukSize can
 * all legitimately be blank — see the AI schema's own "never guess, leave
 * blank" rules) is simply omitted from its segment rather than producing
 * malformed text like a double space or a bare "Size UK " — this is a
 * graceful-degradation choice, not part of the literal spec (every given
 * example has every field populated).
 *
 * Milestone 6: `fields.colours` is now an array of up to 2 exact Vinted
 * colour-list values rather than one free-text string — joined with the
 * exact same " & " this title already used for a multi-colour free-text
 * value (e.g. "White & Blue"), so a two-colour Vinted-enum result and the
 * old free-text convention it replaced read identically in the title.
 */
export function generateListingTitle(fields: GeneratedListingFields): string {
  const namePart = [normalizePart(fields.brand), normalizePart(fields.model), normalizePart(fields.productType)]
    .filter((part): part is string => part !== null)
    .join(" ");
  const colour = fields.colours.length ? fields.colours.join(" & ") : null;
  const ukSize = normalizePart(fields.ukSize);

  const segments = [
    namePart || null,
    colour ? `"${colour}"` : null,
    LISTING_CONDITION_TEXT,
    ukSize ? `Size UK ${ukSize}` : null,
  ];
  return segments.filter((segment): segment is string => segment !== null).join(" - ");
}

// Exactly 4 blank lines between each paragraph in the given template — a
// single named constant so the spacing (not just the wording) can be
// tuned in one place if it doesn't turn out to match exactly.
const DESCRIPTION_PARAGRAPH_SEPARATOR = "\n\n\n\n\n";

/**
 * Byte-for-byte identical to the given template except the two dynamic
 * values (UK size, SKU) — both substituted as-given (an unset value
 * becomes an empty string after its label, e.g. "Size - UK ", never a
 * conditionally-omitted line), matching the spec's "the only dynamic
 * values are UK Size and SKU; everything else must remain byte-for-byte
 * identical."
 */
export function generateListingDescription(fields: Pick<GeneratedListingFields, "ukSize" | "sku">): string {
  const paragraphs = [
    `Size - UK ${fields.ukSize ?? ""}`,
    "Condition: Very Good Condition, Minor signs of use as pictured ✅",
    "Doesn't come with original packaging ✅",
    "Always authentic & trusted seller ✅",
    "🎱10-20% Discount for Bundles, have a look!",
    "🚚Everything sent Same day or Next day of purchasing📦",
    "Please look at my other items, loads of other Rab, north face, mountain equipment, on clouds, ASICS, Ralph Lauren and adidas available",
    `SKU: ${fields.sku ?? ""}`,
  ];
  return paragraphs.join(DESCRIPTION_PARAGRAPH_SEPARATOR);
}
