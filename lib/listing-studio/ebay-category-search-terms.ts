/**
 * Stage 4 — builds the search string sent to eBay's get_category_suggestions
 * endpoint from STRUCTURED product facts, never an uncontrolled raw
 * paragraph (per the product spec's own "Category suggestion input"
 * section). Deterministic, pure, no AI call — the AI's job (Stage 4's
 * ranking layer) starts only after eBay has already returned real
 * candidates for whatever terms this function produces.
 */
export type EbayCategorySearchInput = {
  brand: string | null;
  productType: string | null;
  model: string | null;
  set: string | null;
  configuration: string | null;
  title: string | null;
  knownCategoryName: string | null;
  keyAttributes: string[];
};

const MAX_TERMS = 8;
const MAX_QUERY_LENGTH = 300;

function normalise(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Priority order: brand, productType, model, set, configuration, key
 * attributes, then the existing title/known category as a fallback only
 * when nothing more specific is available — matches the spec's own
 * Prismatic Evolutions Elite Trainer Box example ("Pokémon TCG Prismatic
 * Evolutions Elite Trainer Box sealed"): brand -> "Pokémon TCG", set ->
 * "Prismatic Evolutions", productType -> "Elite Trainer Box", one key
 * attribute -> "sealed". Deduplicates case-insensitively so a fact already
 * covered by an earlier, more specific term is never repeated.
 */
export function buildEbayCategorySearchTerms(input: EbayCategorySearchInput): string {
  const ordered = [
    normalise(input.brand), normalise(input.set), normalise(input.productType), normalise(input.model),
    normalise(input.configuration), ...input.keyAttributes.map(normalise),
  ].filter((term): term is string => term !== null);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of ordered) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }

  // Only fall back to the free-text title/known category when structured
  // facts produced nothing at all usable — never appended alongside real
  // structured terms, which would dilute a precise search with noisy text.
  if (terms.length === 0) {
    const fallback = normalise(input.title) ?? normalise(input.knownCategoryName);
    if (fallback) terms.push(fallback);
  }

  return terms.join(" ").slice(0, MAX_QUERY_LENGTH).trim();
}
