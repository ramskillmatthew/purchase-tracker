import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import type { DraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import type { MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

/**
 * Live-diagnostic follow-up fix (proven root cause of "item specifics are
 * not automatically populated") — the eBay-specific structured facts
 * (brand, model, product type, colours, material, UK size, gender, style
 * code, condition) were only ever persisted to `listing_drafts`' own
 * shared base columns, and ONLY when Vinted was targeted (the correct,
 * deliberate behaviour of the marketplace-isolation fix). For an
 * eBay-only generated product, that means these facts exist ONLY as
 * embedded prose inside the composed title/description — nowhere a later
 * automatic aspect-mapping pass can read them back out of. This reserved
 * pseudo-aspect (same zero-schema-migration pattern as `__packageSize`/
 * `__contentGeneration`) is the ONE place these facts are persisted
 * regardless of which marketplace(s) were targeted, so eBay's own
 * category/aspect automation never depends on Vinted having been
 * generated too.
 */
export const EBAY_PRODUCT_FACTS_KEY = "__productFacts";

export type EbayProductFacts = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  colours: string[];
  material: string | null;
  /** Footwear only — a bare UK shoe-size value, e.g. "9". */
  ukShoeSize: string | null;
  /** Clothing only — the raw size label as read, e.g. "Large" or "L". */
  clothingSize: string | null;
  /** The SAME already-determined Vinted audience reused for eBay's own
   * title/description gender and (via this) Department aspect mapping —
   * never re-guessed independently. "unknown" is stored as null: a
   * genuinely undetermined gender contributes no Department candidate,
   * never a guess. */
  gender: Exclude<VintedAudienceValue, "unknown"> | null;
  itemFamily: DraftItemFamily;
  /** The seller's own internal inventory SKU — read via the SAME evidence
   * pipeline as Vinted's own SKU field. Carried here ONLY so aspect
   * mapping can positively distinguish it from a manufacturer style code
   * — it must NEVER itself be offered as a candidate value for MPN/Style
   * Code or any other aspect. */
  internalSku: string | null;
  /** Manufacturer style/product code — only ever set when confidently
   * established (see ebay-draft-generation.ts's own "high confidence
   * only" gate). Genuinely distinct from internalSku above. */
  styleCode: string | null;
  conditionState: "very_good_preowned" | "new" | "needs_review";
  updatedAt: string;
};

export function buildEbayProductFacts(params: {
  brand: string | null; model: string | null; productType: string | null; colours: string[]; material: string | null;
  ukShoeSize: string | null; clothingSize: string | null; gender: Exclude<VintedAudienceValue, "unknown"> | null;
  itemFamily: DraftItemFamily; internalSku: string | null; styleCode: string | null;
  conditionState: "very_good_preowned" | "new" | "needs_review";
}): EbayProductFacts {
  return { ...params, updatedAt: new Date().toISOString() };
}

/** Safe reader — returns null for a draft generated before this fix
 * existed (no `__productFacts` key at all) or any malformed value, never
 * throws. Callers fall back to the base listing_drafts row's own shared
 * columns in that case (the pre-existing behaviour), so an old draft is
 * never worse off than before this fix. */
export function readEbayProductFacts(dynamicData: MarketplaceDynamicData | null | undefined): EbayProductFacts | null {
  const raw = (dynamicData as Record<string, unknown> | null | undefined)?.[EBAY_PRODUCT_FACTS_KEY];
  if (!raw || typeof raw !== "object") return null;
  const facts = raw as Partial<EbayProductFacts>;
  if (typeof facts.updatedAt !== "string") return null;
  return {
    brand: facts.brand ?? null, model: facts.model ?? null, productType: facts.productType ?? null,
    colours: Array.isArray(facts.colours) ? facts.colours : [], material: facts.material ?? null,
    ukShoeSize: facts.ukShoeSize ?? null, clothingSize: facts.clothingSize ?? null, gender: facts.gender ?? null,
    itemFamily: facts.itemFamily ?? "uncertain", internalSku: facts.internalSku ?? null, styleCode: facts.styleCode ?? null,
    conditionState: facts.conditionState ?? "needs_review", updatedAt: facts.updatedAt,
  };
}
