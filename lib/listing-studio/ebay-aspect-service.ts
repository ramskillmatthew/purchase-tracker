import "server-only";
import { getCachedCategoryTreeId, getCachedItemAspects } from "@/lib/listing-studio/ebay-taxonomy-cache";
import { groupEbayAspects, type GroupedAspect, type GroupedAspects } from "@/lib/listing-studio/ebay-aspect-grouping";
import { matchAspectValue, type AspectCandidate } from "@/lib/listing-studio/ebay-aspect-matching";
import { applyAutomationMode } from "@/lib/listing-studio/ebay-aspect-automation";
import { runEbayAspectSuggestion } from "@/lib/listing-studio/ebay-aspect-suggestion-ai";
import type { EbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";
import { requiresWomensDepartment } from "@/lib/listing-studio/footwear-department-rule";
import { runningActivityValueCandidates } from "@/lib/listing-studio/ebay-performance-activity-rule";
import type { EbayGender } from "@/lib/listing-studio/ebay-title-builder";
import type { MarketplaceDynamicData, AutomationMode } from "@/lib/listing-studio/marketplace-types";
import type { EbayApiFailure } from "@/lib/listing-studio/ebay-taxonomy-client";

export const EBAY_GB_MARKETPLACE_ID = "EBAY_GB";

export type EbayAspectResolutionInput = {
  categoryId: string;
  brand: string | null;
  productType: string | null;
  model: string | null;
  title: string | null;
  /** Exact imported eBay item specifics, keyed by eBay's own specific name
   * — the single strongest possible candidate source, since it's literally
   * eBay's own prior data for this exact listing. Empty for a
   * freshly-photo-generated (never-imported) product. */
  importedItemSpecifics: Record<string, string>;
  /** Confirmed/suggested shared product facts (Stage 2's shared_facts_json),
   * keyed by fact name. */
  sharedFacts: Record<string, string>;
  /** Vinted-confirmed colours/material, when this product also has a
   * Vinted draft — a real, already-verified signal, never re-guessed. */
  vintedColours: string[];
  vintedMaterial: string | null;
  /** Live-diagnostic follow-up fix (proven root cause of "item specifics
   * are not automatically populated") — the SAME verified structured
   * facts already used to compose this product's eBay title/description
   * (dynamic_data_json.__productFacts), persisted regardless of whether
   * Vinted was ALSO generated. This is now the PRIMARY candidate source
   * for every aspect below — brand/model/productType/vintedColours/
   * vintedMaterial above are kept only as a fallback for a draft
   * generated before this fix existed. Null for such a legacy draft. */
  productFacts: EbayProductFacts | null;
  automationMode: AutomationMode;
};

export type EbayAspectResolutionOutcome =
  | { status: "success"; grouped: GroupedAspects; dynamicData: MarketplaceDynamicData; stale: boolean; aiCost: { model: string; inputTokens: number; outputTokens: number } | null }
  | { status: "not_configured" }
  | { status: "upstream_unavailable"; reason: EbayApiFailure["error"] };

// Alias-normalisation — case-insensitive, UK/US-spelling-tolerant,
// punctuation/whitespace-insensitive, matching the SAME normalisation
// convention ebay-aspect-matching.ts's own findAllowedMatch already uses
// for VALUES, applied here to aspect NAMES instead. A "/" or "&" separator
// is collapsed to a space too, so eBay's own "Performance/Activity" (and
// the "Performance & Activity" / "Performance Activity" variants seen
// across categories) all normalise to the one key "performance activity" —
// the proven reason the running-trainer mapping below never fired.
function normaliseAspectName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_/&-]+/g, " ").replace(/[.,]/g, "").trim();
}

// This business only ever states UK shoe size (read directly off the
// product's own size label, brand-aware conversion tables already applied
// once, deterministically, in size-conversion.ts) — US/AU/EU Shoe Size are
// DELIBERATELY never populated, never guessed via a generic conversion
// table, and never sent to the AI fallback step either. See
// resolveEbayAspects below and ebay-aspect-matching.ts's own
// isAspectCountableForReadiness for how these stay out of the completion
// score too.
const REGIONAL_SHOE_SIZE_ASPECT_NAMES = new Set(["us shoe size", "au shoe size", "eu shoe size"]);

const DEPARTMENT_VALUE_FOR_GENDER: Record<EbayGender, string> = {
  mens: "Men", womens: "Women", boys: "Boys", girls: "Girls", unisex: "Unisex",
};

/**
 * Reusable clothing/footwear aspect-mapping system (never hardcoded to
 * one product) — tries, in priority order: (1) eBay's own prior data for
 * this exact listing (imported item specifics); (2) a confirmed shared
 * fact with a matching name; (3) this generation's own VERIFIED
 * structured facts (__productFacts) — HIGH confidence, since these are
 * the exact same facts already used to compose the title/description,
 * covering the full alias list the product spec requires (Brand,
 * Department, Type, Colour/Color, Upper Material, Material, UK Shoe
 * Size, Model, Product Line, Style Code, MPN, Vintage, Customised/
 * Customized); (4) a lower-confidence heuristic inference (Style,
 * Performance/Activity, from product type text) — never an exact-match
 * claim; (5) the legacy base-row facts (brand/productType/model/
 * vintedColours/vintedMaterial), kept only as a fallback for a draft
 * generated before __productFacts existed, at the same "medium"
 * confidence this app has always used for that weaker signal.
 *
 * Vintage/Customised are deterministic, universal application defaults
 * for a used/pre-owned resale listing — "No" — supplied here as a
 * high-confidence candidate rather than a special-cased bypass, so they
 * flow through the exact same matchAspectValue/applyAutomationMode
 * pipeline (and therefore the exact same automation-mode/Strict-mode
 * rules) as every other aspect, never an AI guess.
 *
 * The internal SKU is deliberately NEVER offered as a candidate for any
 * aspect (MPN/Style Code included) — it is carried on __productFacts only
 * to positively distinguish it from styleCode, never to be confused with
 * a manufacturer identifier.
 */
function candidatesForAspect(aspect: GroupedAspect, input: EbayAspectResolutionInput): AspectCandidate[] {
  const candidates: AspectCandidate[] = [];
  const nameKey = normaliseAspectName(aspect.name);
  const pf = input.productFacts;

  const exactSpecific = Object.entries(input.importedItemSpecifics).find(([key]) => normaliseAspectName(key) === nameKey);
  if (exactSpecific) candidates.push({ value: exactSpecific[1], source: "imported_ebay_item_specifics", confidence: "high" });

  const sharedFact = Object.entries(input.sharedFacts).find(([key]) => normaliseAspectName(key) === nameKey);
  if (sharedFact) candidates.push({ value: sharedFact[1], source: "shared_facts", confidence: "medium" });

  if (nameKey === "brand" && pf?.brand) candidates.push({ value: pf.brand, source: "product_facts", confidence: "high" });
  if ((nameKey === "model" || nameKey === "product line") && pf?.model) candidates.push({ value: pf.model, source: "product_facts", confidence: "high" });
  if ((nameKey === "type" || nameKey === "product type") && pf?.productType) candidates.push({ value: pf.productType, source: "product_facts", confidence: "high" });
  if ((nameKey === "colour" || nameKey === "color" || nameKey === "manufacturer colour" || nameKey === "manufacturer color") && pf?.colours.length) {
    candidates.push({ value: pf.colours, source: "product_facts", confidence: "high" });
  }
  if ((nameKey === "material" || nameKey === "upper material" || nameKey === "fabric type") && pf?.material) {
    candidates.push({ value: pf.material, source: "product_facts", confidence: "high" });
  }
  if (nameKey === "uk shoe size" && pf?.ukShoeSize) candidates.push({ value: pf.ukShoeSize, source: "product_facts", confidence: "high" });
  if (nameKey === "department") {
    // Live-diagnostic follow-up fix — the deterministic below-UK-7
    // footwear rule (lib/listing-studio/footwear-department-rule.ts) is
    // tried FIRST, ahead of the ordinary gender-derived candidate below,
    // so it wins regardless of what vintedAudience/gender happened to
    // resolve to. Never an AI guess — this only ever fires on an already-
    // confirmed UK shoe size fact.
    if (pf && requiresWomensDepartment(pf.itemFamily, pf.ukShoeSize)) {
      candidates.push({ value: "Women", source: "footwear_size_rule", confidence: "high" });
    }
    if (pf?.gender) candidates.push({ value: DEPARTMENT_VALUE_FOR_GENDER[pf.gender], source: "product_facts", confidence: "high" });
  }
  if ((nameKey === "style code" || nameKey === "mpn") && pf?.styleCode) candidates.push({ value: pf.styleCode, source: "product_facts", confidence: "high" });
  // Deterministic, universal defaults — never AI-guessed, never withheld
  // pending an owner decision that has no real ambiguity to resolve.
  if (nameKey === "vintage") candidates.push({ value: "No", source: "default", confidence: "high" });
  if (nameKey === "customised" || nameKey === "customized") candidates.push({ value: "No", source: "default", confidence: "high" });
  // Lower-confidence heuristic inference — a real signal, but an
  // INFERENCE rather than an exact structured fact for this aspect, so it
  // stays "medium" (review-flagged in Fast/Balanced automation modes,
  // never auto-trusted the way an exact fact is).
  if (nameKey === "style" && pf?.productType) {
    candidates.push({ value: pf.productType, source: "product_facts_heuristic", confidence: "medium" });
  }
  if (nameKey === "performance activity") {
    // Deterministic, evidence-gated running-footwear mapping FIRST — HIGH
    // confidence, but matchAspectValue still requires an exact normalised
    // match to one of THIS category's own allowed values (e.g. "Running &
    // Jogging" / "Running"). If the schema offers none, this yields
    // nothing and the aspect keeps a genuine, visible review requirement.
    for (const activity of runningActivityValueCandidates(pf ? { itemFamily: pf.itemFamily, productType: pf.productType } : null, input.title)) {
      candidates.push({ value: activity, source: "footwear_activity_rule", confidence: "high" });
    }
    // Ordinary heuristic fallback for non-running footwear.
    if (pf?.productType) candidates.push({ value: pf.productType, source: "product_facts_heuristic", confidence: "medium" });
  }

  // Legacy fallback — only ever reached when __productFacts didn't cover
  // this aspect (an older draft, or a manual base-row edit not yet
  // reflected there).
  if (nameKey === "brand" && input.brand) candidates.push({ value: input.brand, source: "product_brand", confidence: "medium" });
  if ((nameKey === "type" || nameKey === "product type") && input.productType) candidates.push({ value: input.productType, source: "product_type", confidence: "medium" });
  if (nameKey === "model" && input.model) candidates.push({ value: input.model, source: "product_model", confidence: "medium" });
  if ((nameKey === "colour" || nameKey === "color") && input.vintedColours.length) candidates.push({ value: input.vintedColours, source: "vinted_colours", confidence: "medium" });
  if (nameKey === "material" && input.vintedMaterial) candidates.push({ value: input.vintedMaterial, source: "vinted_material", confidence: "medium" });

  return candidates;
}

export type EbayAspectDefinitionsOutcome =
  | { status: "success"; grouped: GroupedAspects; stale: boolean }
  | { status: "not_configured" }
  | { status: "upstream_unavailable"; reason: EbayApiFailure["error"] };

/**
 * Fetches and groups this category's real aspect DEFINITIONS only — no
 * candidate matching, no AI call. This is what an editor uses to render
 * its controls when it opens, so opening it never itself triggers the AI
 * suggestion step (see the product spec's own "avoid triggering AI merely
 * by opening an editor" requirement) — resolveEbayAspects below is only
 * ever invoked by an explicit "Suggest item specifics" action.
 */
export async function getEbayAspectDefinitions(categoryId: string): Promise<EbayAspectDefinitionsOutcome> {
  const treeResult = await getCachedCategoryTreeId(EBAY_GB_MARKETPLACE_ID);
  if (!treeResult.ok) return treeResult.error === "not_configured" ? { status: "not_configured" } : { status: "upstream_unavailable", reason: treeResult.error };

  const aspectsResult = await getCachedItemAspects(treeResult.data.categoryTreeId, treeResult.data.categoryTreeVersion, categoryId);
  if (!aspectsResult.ok) return aspectsResult.error === "not_configured" ? { status: "not_configured" } : { status: "upstream_unavailable", reason: aspectsResult.error };

  return { status: "success", grouped: groupEbayAspects(aspectsResult.data.aspects), stale: treeResult.data.stale || aspectsResult.data.stale };
}

/**
 * Stage 5's full pipeline: fetch this category's real, currently-cached
 * aspect definitions, group them, deterministically match every aspect
 * against real known evidence, then send only the still-unresolved
 * REQUIRED/RECOMMENDED SELECTION_ONLY aspects to one bounded AI call
 * (never optional ones — kept out of AI scope to bound cost, matching the
 * spec's own "do not automatically regenerate/spend on every edit"
 * instruction; an optional aspect a deterministic candidate didn't match
 * simply stays blank, which is always an acceptable, honest outcome for
 * an optional field). automationMode then decides which resolved values
 * are applied silently vs. flagged for review vs. held back.
 */
export async function resolveEbayAspects(input: EbayAspectResolutionInput): Promise<EbayAspectResolutionOutcome> {
  const treeResult = await getCachedCategoryTreeId(EBAY_GB_MARKETPLACE_ID);
  if (!treeResult.ok) return treeResult.error === "not_configured" ? { status: "not_configured" } : { status: "upstream_unavailable", reason: treeResult.error };

  const aspectsResult = await getCachedItemAspects(treeResult.data.categoryTreeId, treeResult.data.categoryTreeVersion, input.categoryId);
  if (!aspectsResult.ok) return aspectsResult.error === "not_configured" ? { status: "not_configured" } : { status: "upstream_unavailable", reason: aspectsResult.error };

  const grouped = groupEbayAspects(aspectsResult.data.aspects);
  const dynamicData: MarketplaceDynamicData = {};
  const unresolvedForAi: GroupedAspect[] = [];

  for (const aspect of [...grouped.required, ...grouped.recommended, ...grouped.optional]) {
    if (REGIONAL_SHOE_SIZE_ASPECT_NAMES.has(normaliseAspectName(aspect.name))) {
      // Deliberately, permanently left blank — never populated, never
      // guessed via a conversion table, never sent to the AI fallback
      // below. `source: "not_applicable"` (rather than "none") is what
      // lets readiness/completion computations exclude this aspect from
      // the meaningful score entirely (see isAspectCountableForReadiness)
      // instead of counting it as a real, still-outstanding gap.
      dynamicData[aspect.name] = {
        value: null, confidence: "unknown", source: "not_applicable",
        appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: new Date().toISOString(),
      };
      continue;
    }
    const matched = matchAspectValue(aspect, candidatesForAspect(aspect, input));
    if (matched.confidence === "unknown" && aspect.mode === "SELECTION_ONLY" && aspect.usage !== "OPTIONAL") {
      unresolvedForAi.push(aspect);
      continue;
    }
    dynamicData[aspect.name] = applyAutomationMode(aspect, matched, input.automationMode);
  }

  let aiCost: { model: string; inputTokens: number; outputTokens: number } | null = null;
  if (unresolvedForAi.length) {
    const aiOutcome = await runEbayAspectSuggestion({ brand: input.brand, productType: input.productType, model: input.model, title: input.title, knownFacts: input.sharedFacts }, unresolvedForAi);
    if (aiOutcome.status === "success") {
      aiCost = aiOutcome.inputTokens || aiOutcome.outputTokens ? { model: aiOutcome.model, inputTokens: aiOutcome.inputTokens, outputTokens: aiOutcome.outputTokens } : null;
      for (const aspect of unresolvedForAi) {
        const raw = aiOutcome.values[aspect.name];
        const hasValue = Array.isArray(raw) ? raw.length > 0 : raw != null;
        // The AI's answer is treated as just another candidate — it still
        // has to normalise-exactly-match one of eBay's own allowed values
        // for this SELECTION_ONLY aspect (matchAspectValue enforces that),
        // never stored verbatim as a paraphrase eBay would reject. An
        // unsupported AI value therefore falls through to unknown, exactly
        // like an unmatched deterministic candidate.
        const matched = hasValue
          ? matchAspectValue(aspect, [{ value: raw as string | string[], source: "ai_suggestion", confidence: "medium" }])
          : { value: null, confidence: "unknown" as const, source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: new Date().toISOString() };
        dynamicData[aspect.name] = applyAutomationMode(aspect, matched, input.automationMode);
      }
    } else {
      for (const aspect of unresolvedForAi) {
        dynamicData[aspect.name] = applyAutomationMode(aspect, { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: new Date().toISOString() }, input.automationMode);
      }
    }
  }

  return { status: "success", grouped, dynamicData, stale: treeResult.data.stale || aspectsResult.data.stale, aiCost };
}
