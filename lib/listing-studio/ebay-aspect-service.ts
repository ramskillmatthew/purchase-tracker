import "server-only";
import { getCachedCategoryTreeId, getCachedItemAspects } from "@/lib/listing-studio/ebay-taxonomy-cache";
import { groupEbayAspects, type GroupedAspect, type GroupedAspects } from "@/lib/listing-studio/ebay-aspect-grouping";
import { matchAspectValue, type AspectCandidate } from "@/lib/listing-studio/ebay-aspect-matching";
import { applyAutomationMode } from "@/lib/listing-studio/ebay-aspect-automation";
import { runEbayAspectSuggestion } from "@/lib/listing-studio/ebay-aspect-suggestion-ai";
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
  automationMode: AutomationMode;
};

export type EbayAspectResolutionOutcome =
  | { status: "success"; grouped: GroupedAspects; dynamicData: MarketplaceDynamicData; stale: boolean; aiCost: { model: string; inputTokens: number; outputTokens: number } | null }
  | { status: "not_configured" }
  | { status: "upstream_unavailable"; reason: EbayApiFailure["error"] };

function candidatesForAspect(aspect: GroupedAspect, input: EbayAspectResolutionInput): AspectCandidate[] {
  const candidates: AspectCandidate[] = [];
  const nameLower = aspect.name.toLowerCase();

  const exactSpecific = Object.entries(input.importedItemSpecifics).find(([key]) => key.toLowerCase() === nameLower);
  if (exactSpecific) candidates.push({ value: exactSpecific[1], source: "imported_ebay_item_specifics", confidence: "high" });

  const sharedFact = Object.entries(input.sharedFacts).find(([key]) => key.toLowerCase() === nameLower);
  if (sharedFact) candidates.push({ value: sharedFact[1], source: "shared_facts", confidence: "medium" });

  if (nameLower === "brand" && input.brand) candidates.push({ value: input.brand, source: "product_brand", confidence: "medium" });
  if ((nameLower === "type" || nameLower === "product type") && input.productType) candidates.push({ value: input.productType, source: "product_type", confidence: "medium" });
  if (nameLower === "model" && input.model) candidates.push({ value: input.model, source: "product_model", confidence: "medium" });
  if ((nameLower === "colour" || nameLower === "color") && input.vintedColours.length) candidates.push({ value: input.vintedColours, source: "vinted_colours", confidence: "medium" });
  if (nameLower === "material" && input.vintedMaterial) candidates.push({ value: input.vintedMaterial, source: "vinted_material", confidence: "medium" });

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
        const matched = hasValue
          ? { value: raw, confidence: "medium" as const, source: "ai_suggestion", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: new Date().toISOString() }
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
