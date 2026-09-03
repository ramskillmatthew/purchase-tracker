import "server-only";
import { supabaseRequestAll } from "@/lib/supabase";
import { suggestEbayCategory, describeEbayCategorySuggestionFailureDetailed, type EbayCategorySuggestionOutcome } from "@/lib/listing-studio/ebay-category-service";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { buildSellingSettingsMessages, withoutMessageCodes, SELLING_SETTINGS_MESSAGE_CODES } from "@/lib/listing-studio/ebay-validation-messages";
import { readEbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";
import { requiresWomensDepartment, categoryTextIndicatesWomens } from "@/lib/listing-studio/footwear-department-rule";
import { resolveCategoryReviewState, readCategoryConfirmation } from "@/lib/listing-studio/ebay-category-review";
import type { EbayErrorCode } from "@/lib/listing-studio/ebay-error-codes";
import type { SharedFacts, MarketplaceValidationMessage, MarketplaceDraft, AutomationMode, EbayCategoryAlternative } from "@/lib/listing-studio/marketplace-types";

/**
 * Shared "suggest + persist a category" logic (Fault 3 fix) — reused by
 * BOTH the explicit "Suggest category" action
 * (app/api/listing-studio/groups/[draftId]/ebay-category/route.ts's POST)
 * AND automatic execution right after an eBay draft is first generated
 * (app/api/listing-studio/groups/[draftId]/generate/route.ts), so the two
 * call sites can never drift apart. Confidence -> persistence behaviour
 * (the product spec's own "Automatic category execution"/"Confidence"
 * sections):
 *   high    -> select automatically; Strict mode still flags for review.
 *   medium  -> select automatically, always flagged for review.
 *   low     -> NEVER auto-selected — left unresolved, alternatives (the
 *              low-confidence top pick included) stored so "top choices"
 *              are visible, exactly as the spec requires ("Low confidence:
 *              leave unresolved and show top choices").
 */
export type EbayCategoryAutomationOutcome =
  // Phase 8 fix — usedFixture rides along on every real outcome so the UI
  // can honestly disclose "these are local fixture categories, not real
  // eBay data" whenever it's true, rather than presenting fixture output
  // as though it were a genuine eBay response.
  // "low" is now possible here too — the deterministic below-UK-7
  // footwear rule can auto-apply a genuinely Women's category even when
  // eBay's own raw taxonomy confidence for it was low; see
  // footwearRuleSatisfied below for the one narrow case this happens.
  | { status: "applied"; confidence: "high" | "medium" | "low"; needsReview: boolean; readiness: ReturnType<typeof computeMarketplaceReadiness>; usedFixture: boolean }
  | { status: "left_unresolved"; readiness: ReturnType<typeof computeMarketplaceReadiness>; usedFixture: boolean }
  | { status: "failed"; reason: EbayCategorySuggestionOutcome["status"]; code: EbayErrorCode; message: string };

type ProductRow = { brand: string | null; model: string | null; product_type: string | null; shared_facts_json: SharedFacts | null };

function sharedFactValue(facts: SharedFacts | null, name: string): string | null {
  return facts?.[name]?.value ?? null;
}

export async function autoSuggestAndPersistEbayCategory(ownerId: string, productDraftId: string, automationMode: AutomationMode, ebayDraft?: MarketplaceDraft): Promise<EbayCategoryAutomationOutcome> {
  const resolvedDraft = ebayDraft ?? await getMarketplaceDraft(ownerId, productDraftId, "EBAY_UK");
  if (!resolvedDraft) return { status: "failed", reason: "no_results", code: "EBAY_NO_CATEGORY", message: "No eBay draft exists yet for this product." };

  const products = await supabaseRequestAll<ProductRow>(`listing_drafts?id=eq.${productDraftId}&owner_id=eq.${ownerId}&select=brand,model,product_type,shared_facts_json`);
  const product = products[0];
  const facts = product?.shared_facts_json ?? null;

  const outcome = await suggestEbayCategory({
    brand: product?.brand ?? null, productType: product?.product_type ?? null, model: product?.model ?? null,
    set: sharedFactValue(facts, "set"), configuration: sharedFactValue(facts, "configuration"),
    title: resolvedDraft.title, knownCategoryName: resolvedDraft.categoryName, keyAttributes: [],
  });

  if (outcome.status !== "success") {
    const { code, message } = describeEbayCategorySuggestionFailureDetailed(outcome);
    return { status: "failed", reason: outcome.status, code, message };
  }

  // Phase 4/5 fix — readiness must reflect genuine content generation,
  // not merely "a title/description exist" (a FALLBACK draft has both).
  const hasGeneratedContent = readContentGenerationState(resolvedDraft.dynamicData, {
    sourceType: resolvedDraft.sourceType, contentMode: resolvedDraft.contentMode,
    hasTitle: Boolean(resolvedDraft.title), hasDescription: Boolean(resolvedDraft.description),
  }).state === "generated";

  // Live-diagnostic follow-up fix (proven root cause of "price_not_set"
  // appearing 4+ times in one draft's stored validationMessages) — the
  // shared filter/builder pair strips ALL selling-settings codes this
  // function is about to recompute, not just the category codes this
  // function directly owns, so repeated runs (generate, then Suggest
  // category again) can never accumulate duplicates.
  const baseValidationMessages = withoutMessageCodes(
    resolvedDraft.validationMessages.filter(m => m.code !== "category_not_set" && m.code !== "category_needs_confirmation"),
    SELLING_SETTINGS_MESSAGE_CODES,
  );
  const sellingSettingsMessages = () => buildSellingSettingsMessages(resolvedDraft);

  // Live-diagnostic follow-up fix — the deterministic below-UK-7 footwear
  // rule (lib/listing-studio/footwear-department-rule.ts) is applied to
  // the CATEGORY SELECTION itself here, not just to the Department item
  // specific: for a qualifying product, a Women's category among eBay's
  // own real suggestions (selected or alternative — NEVER a fabricated
  // one) is preferred over a Men's/Children's/unisex-only top pick, and is
  // trusted outright regardless of eBay's own raw taxonomy confidence —
  // including bypassing the "low confidence -> leave unresolved" safety
  // net below, since the deterministic rule is stronger evidence than an
  // uncertain AI/taxonomy match score for this one specific, narrow case.
  const productFacts = readEbayProductFacts(resolvedDraft.dynamicData);
  const footwearRuleApplies = requiresWomensDepartment(productFacts?.itemFamily ?? "uncertain", productFacts?.ukShoeSize ?? null);

  let effectiveSelected: EbayCategoryAlternative = outcome.selected;
  let effectiveAlternatives: EbayCategoryAlternative[] = outcome.alternatives;
  if (footwearRuleApplies && !categoryTextIndicatesWomens(`${effectiveSelected.categoryName} ${effectiveSelected.categoryPath}`)) {
    const womensAlternative = effectiveAlternatives.find(a => categoryTextIndicatesWomens(`${a.categoryName} ${a.categoryPath}`));
    if (womensAlternative) {
      effectiveAlternatives = [effectiveSelected, ...effectiveAlternatives.filter(a => a.categoryId !== womensAlternative.categoryId)];
      effectiveSelected = womensAlternative;
    }
  }
  const footwearRuleSatisfied = footwearRuleApplies && categoryTextIndicatesWomens(`${effectiveSelected.categoryName} ${effectiveSelected.categoryPath}`);

  if (effectiveSelected.confidence === "low" && !footwearRuleSatisfied) {
    // Left unresolved — category_id stays whatever it already was (null
    // for a fresh draft), but the real alternatives (including this low-
    // confidence top pick) are stored so the owner sees genuine top
    // choices rather than an empty dialog.
    const validationMessages: MarketplaceValidationMessage[] = [
      { code: "category_not_set", message: "This product needs a category before its eBay details can be prepared.", field: "category", severity: "blocking" },
      ...baseValidationMessages, ...sellingSettingsMessages(),
    ];
    const readiness = computeMarketplaceReadiness({
      hasCategory: false, hasCondition: !!resolvedDraft.conditionValue, hasTitle: !!resolvedDraft.title, hasDescriptionOrGenerationPath: !!resolvedDraft.description,
      hasPhoto: true, hasPrice: resolvedDraft.pricePence != null, hasQuantity: resolvedDraft.quantity != null,
      hasSufficientSellingSettings: true, hasGeneratedContent, requiredAspectsFilled: [], recommendedAspectsFilled: [],
    });
    await patchMarketplaceDraft(ownerId, resolvedDraft.id, {
      category_alternatives_json: [effectiveSelected, ...effectiveAlternatives].slice(0, 4), category_search_terms: outcome.searchTerms,
      status: "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
    });
    return { status: "left_unresolved", readiness, usedFixture: outcome.usedFixture ?? false };
  }

  // Live-diagnostic follow-up fix (proven root cause of an unexplained
  // "Needs review" badge with zero visible reason) — review is now
  // decided by the ONE shared resolver the dialog's own review summary
  // reads from too, never a bespoke "confidence===medium" check here that
  // the UI has no way to explain. The raw AI confidence is still persisted
  // exactly as eBay reported it (never rewritten to "high" — see that
  // module's own comment on why); only the REVIEW REQUIREMENT is affected
  // by the deterministic rule. Strict automation mode's own blanket
  // confirmation requirement is likewise never applied when the
  // deterministic rule already resolved this category with certainty —
  // "do not require manual review" is unconditional for a qualifying
  // product, matching the business rule's own wording.
  const reviewState = resolveCategoryReviewState({
    categoryId: effectiveSelected.categoryId, categoryName: effectiveSelected.categoryName, categoryPath: effectiveSelected.categoryPath,
    categoryConfidence: effectiveSelected.confidence, categorySource: "ai",
    itemFamily: productFacts?.itemFamily ?? "uncertain", ukShoeSize: productFacts?.ukShoeSize ?? null,
    // A freshly (re-)suggested category is a new AI outcome — any earlier
    // confirmation was for a specific category id, which may no longer be
    // this one; resolveCategoryReviewState only ever honours a
    // confirmation matching the CURRENT category id, so passing the
    // stored confirmation through here is safe even when it's now stale.
    confirmedForCategoryId: readCategoryConfirmation(resolvedDraft.dynamicData),
  });
  const needsReview = reviewState.needsReview || (automationMode === "strict" && reviewState.provenance !== "footwear_size_rule");
  const validationMessages: MarketplaceValidationMessage[] = [...baseValidationMessages, ...sellingSettingsMessages()];
  if (needsReview) {
    validationMessages.push({
      code: "category_needs_confirmation",
      message: reviewState.reason ?? (automationMode === "strict" ? "Confirm the automatically selected eBay category (Strict automation mode)." : "The suggested eBay category is a good match — please confirm it."),
      field: "category", severity: "warning",
    });
  }

  const readiness = computeMarketplaceReadiness({
    hasCategory: true, hasCondition: !!resolvedDraft.conditionValue, hasTitle: !!resolvedDraft.title, hasDescriptionOrGenerationPath: !!resolvedDraft.description,
    hasPhoto: true, hasPrice: resolvedDraft.pricePence != null, hasQuantity: resolvedDraft.quantity != null,
    hasSufficientSellingSettings: true, hasGeneratedContent, requiredAspectsFilled: [], recommendedAspectsFilled: [],
  });
  await patchMarketplaceDraft(ownerId, resolvedDraft.id, {
    category_id: effectiveSelected.categoryId, category_name: effectiveSelected.categoryName, category_path: effectiveSelected.categoryPath,
    category_source: "ai", category_confidence: effectiveSelected.confidence,
    category_alternatives_json: effectiveAlternatives, category_search_terms: outcome.searchTerms,
    status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
  });
  return { status: "applied", confidence: effectiveSelected.confidence, needsReview, readiness, usedFixture: outcome.usedFixture };
}
