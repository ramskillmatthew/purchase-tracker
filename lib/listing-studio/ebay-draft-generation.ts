import "server-only";
import {
  buildEbayTitle, validateEbayTitle, verifiedWordsFromFacts, mapVintedAudienceToEbayGender,
  type EbayTitleFacts, type EbayItemFamily,
} from "@/lib/listing-studio/ebay-title-builder";
import { renderEbayDescription, resolveEbayConditionText, type EbayDescriptionFacts } from "@/lib/listing-studio/ebay-description-renderer";
import { validateEbayDescription, repairEbayDescription } from "@/lib/listing-studio/ebay-description-validator";
import { runEbayListingGeneration } from "@/lib/listing-studio/ebay-listing-generation-ai";
import { describeEbayListingGenerationFailure } from "@/lib/listing-studio/ebay-listing-generation-schemas";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { suggestPackageSize, type PackageSizeSuggestion } from "@/lib/listing-studio/ebay-package-suggestion";
import { buildGeneratedRecord, buildFallbackRecord, type EbayContentGenerationRecord } from "@/lib/listing-studio/ebay-content-generation-state";
import type { MarketplaceDraftStatus, MarketplaceValidationMessage, MarketplaceReadiness } from "@/lib/listing-studio/marketplace-types";
import type { ListingGenerationFields, VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import type { DraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { buildEbayProductFacts, type EbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";

/**
 * Stage 6 (genuinely eBay-specific generation, fixing the reported Fault 1
 * "looks like Vinted content"). Builds an eBay UK marketplace draft from
 * the SAME structured product fields the Vinted generator already
 * extracted from photos — no second photo upload — but runs its OWN
 * separate, text-only AI call (lib/listing-studio/ebay-listing-generation-ai.ts)
 * for the genuinely eBay-specific ADDITIONAL facts (manufacturer style
 * code, buyer-search keywords, condition evidence). The AI never writes
 * the final title or description string itself — ebay-title-builder.ts
 * and ebay-description-renderer.ts are the only two places that ever
 * assemble final customer-facing text (Problem 2/3 fix), and Vinted's own
 * generated title/description (lib/listing-studio/listing-template.ts) is
 * never reused in any form.
 *
 * Category and eBay-native category ID are deliberately left unset here —
 * Stage 4/5 (category suggestion + dynamic aspects) resolve those
 * separately, wired to run automatically immediately after this (see the
 * generate route's own eBay branch) rather than requiring a manual click
 * first.
 */

function mapItemFamily(family: DraftItemFamily): EbayItemFamily {
  return family;
}

/** Concise, UI-facing condition label — deliberately short (this is what
 * "Condition: {value}" displays), distinct from the full sentence the
 * description renders. `null` for "needs_review" is deliberate: every
 * existing readiness/validation-message gate across this feature already
 * keys off `!!conditionValue`, so a needs-review condition correctly
 * keeps the draft not-ready with zero changes needed at any of those call
 * sites — see ebay-description-renderer.ts's resolveEbayConditionText. */
function conditionValueLabel(state: "very_good_preowned" | "new" | "needs_review"): string | null {
  switch (state) {
    case "very_good_preowned": return "Used – Very Good";
    case "new": return "New";
    case "needs_review": return null;
  }
}

export type EbayDraftGenerationResult = {
  title: string;
  description: string;
  conditionValue: string | null;
  // Problem 8 fix, extended by the live-diagnostic follow-up fix (proven
  // root cause of "item specifics are not automatically populated") — the
  // FULL structured facts this generation used to compose the title/
  // description, kept alongside it so category/aspect automation always
  // has real facts to map from, regardless of whether Vinted was ALSO
  // targeted (which is the only place these used to be persisted).
  // Persisted into dynamic_data_json.__productFacts by the caller (the
  // same reserved-pseudo-aspect pattern as __packageSize/
  // __contentGeneration — no schema migration needed).
  productFacts: EbayProductFacts;
  status: MarketplaceDraftStatus;
  readiness: MarketplaceReadiness;
  validationMessages: MarketplaceValidationMessage[];
  categorySearchTermsHint: string[];
  packageSuggestion: PackageSizeSuggestion;
  // Phase 3 fix — the authoritative content-generation state for this
  // attempt (GENERATED only on a genuine AI success; FALLBACK — never
  // GENERATED — when the AI call failed and this deterministic recovery
  // text was used instead). The caller persists this into
  // dynamic_data_json.__contentGeneration; see
  // ebay-content-generation-state.ts's own top comment for why no schema
  // migration is needed for it.
  contentGeneration: EbayContentGenerationRecord;
};

function fallbackDescription(fields: ListingGenerationFields, ukSize: string | null): string {
  // Used ONLY when the dedicated eBay AI call itself fails (not when it
  // succeeds) — deliberately minimal and entirely deterministic, so it can
  // never contain Vinted-style promotional wording by construction.
  const namePart = [fields.brand.value, fields.model.value, fields.productType.value].filter(Boolean).join(" ");
  const sentences: string[] = [];
  if (namePart) sentences.push(`${namePart}.`);
  if (fields.colours.value.length) sentences.push(`Colour: ${fields.colours.value.join(", ")}.`);
  if (fields.material.value) sentences.push(`Material: ${fields.material.value}.`);
  if (ukSize) sentences.push(`Size: UK ${ukSize}.`);
  return sentences.join(" ") || "Full details to follow.";
}

export async function buildEbayDraftFromGeneratedFields(input: {
  fields: ListingGenerationFields;
  ukSize: string | null;
  /** The already-determined (and footwear-children's-wording-corrected)
   * Vinted audience — the SAME value the route derives once and would
   * otherwise only use for Vinted's own category resolution. Reused here
   * as the eBay title/description's gender fact rather than asking the
   * eBay AI call to guess it a second, independently-fallible way. */
  vintedAudience: VintedAudienceValue | null;
  itemFamily: DraftItemFamily;
  hasPhoto: boolean;
  pricePence: number | null;
  quantity: number | null;
  knownConditionEvidence: string | null;
  /** Phase 3 fix — the attempt count already recorded for this draft
   * (0 for a brand-new draft, or the prior attempt count on a Retry) —
   * this function only ever increments it by one for the attempt it's
   * making right now; it never resets or fabricates a count itself. */
  previousAttemptCount: number;
}): Promise<EbayDraftGenerationResult> {
  const { fields } = input;
  const now = new Date().toISOString();
  const itemFamily = mapItemFamily(input.itemFamily);
  const gender = mapVintedAudienceToEbayGender(input.vintedAudience);
  const primaryColour = fields.colours.value[0] ?? null;
  const secondaryColour = fields.colours.value[1] ?? null;
  // Footwear uses the deterministically-derived/converted UK shoe size;
  // clothing has no such conversion table (size-conversion.ts is footwear
  // only) — the raw label value as read is the best available fact.
  const ukShoeSize = itemFamily === "footwear" ? input.ukSize : null;
  const clothingSize = itemFamily !== "footwear" ? fields.sourceSize.value : null;

  const aiOutcome = await runEbayListingGeneration({
    brand: fields.brand.value, model: fields.model.value, productType: fields.productType.value,
    colours: fields.colours.value, material: fields.material.value, ukSize: input.ukSize,
    vintedAudience: fields.vintedAudience.value, notes: fields.notes, knownConditionEvidence: input.knownConditionEvidence,
  });

  const aiWarnings: MarketplaceValidationMessage[] = [];
  let styleCode: string | null = null;
  let categorySearchTermsHint: string[] = [];
  let conditionEvidence: string | null = input.knownConditionEvidence;
  let contentGeneration: EbayContentGenerationRecord;

  if (aiOutcome.status === "success") {
    // Never invented, never leaked at low confidence — only a "high"
    // confidence, genuinely evidenced style/product code is ever included
    // in the title or description (Problem 2's explicit requirement).
    styleCode = aiOutcome.data.styleCodeConfidence === "high" ? aiOutcome.data.styleCode : null;
    categorySearchTermsHint = aiOutcome.data.categorySearchTerms;
    conditionEvidence = aiOutcome.data.conditionEvidence ?? input.knownConditionEvidence;
    for (const warning of aiOutcome.data.warnings) aiWarnings.push({ code: "ai_warning", message: warning, field: null, severity: "suggestion" });
    contentGeneration = buildGeneratedRecord({ model: process.env.ANTHROPIC_MODEL ?? null, warnings: aiOutcome.data.warnings, previousAttemptCount: input.previousAttemptCount, now });
  } else {
    // Bug fix (Phase 3/9) — this used to be surfaced ONLY as a
    // warning-severity validation message ("ebay_generation_degraded"),
    // which is exactly why fallback content could still read as broadly
    // successful ("5/8 complete", green-adjacent). It's now ALSO recorded
    // as the authoritative FALLBACK content-generation state — never
    // GENERATED, always distinguishable, always blocking readiness (see
    // hasGeneratedContent below) and always eligible for Retry.
    aiWarnings.push({ code: "ebay_generation_degraded", message: describeEbayListingGenerationFailure(aiOutcome.status), field: null, severity: "warning" });
    contentGeneration = buildFallbackRecord({ code: aiOutcome.code, message: describeEbayListingGenerationFailure(aiOutcome.status), previousAttemptCount: input.previousAttemptCount, now });
  }

  const titleFacts: EbayTitleFacts = {
    brand: fields.brand.value, model: fields.model.value, gender, productType: fields.productType.value,
    ukShoeSize, clothingSize, primaryColour, secondaryColour, material: fields.material.value,
    styleCode, itemFamily, otherKeywords: aiOutcome.status === "success" ? aiOutcome.data.otherKeywords : [],
  };
  let title = buildEbayTitle(titleFacts);
  const verifiedWords = verifiedWordsFromFacts(titleFacts);
  let titleIssues = validateEbayTitle(title, verifiedWords);
  if (titleIssues.length > 0) {
    // Repair path per the product spec's own steps: drop lower-priority
    // attributes (otherKeywords, then style code) and revalidate — never
    // truncate mid-word, never touch brand/model/gender/size.
    const repairedFacts = { ...titleFacts, otherKeywords: [], styleCode: null };
    const repairedTitle = buildEbayTitle(repairedFacts);
    const repairedIssues = validateEbayTitle(repairedTitle, verifiedWordsFromFacts(repairedFacts));
    if (repairedIssues.length < titleIssues.length) { title = repairedTitle; titleIssues = repairedIssues; }
  }
  for (const issue of titleIssues) aiWarnings.push({ code: `title_${issue.code}`, message: issue.message, field: "title", severity: "warning" });

  let description: string;
  let conditionValue: string | null;
  let conditionState: "very_good_preowned" | "new" | "needs_review" = "needs_review";
  if (aiOutcome.status === "success") {
    const conditionResolution = resolveEbayConditionText(conditionEvidence);
    conditionValue = conditionValueLabel(conditionResolution.state);
    conditionState = conditionResolution.state;
    if (conditionResolution.state === "needs_review") {
      aiWarnings.push({ code: "condition_needs_review", message: "The available condition evidence suggests a defect that needs a human-written condition description — please review and confirm the condition before this draft is ready.", field: "condition", severity: "warning" });
    }
    const descriptionFacts: EbayDescriptionFacts = {
      brand: fields.brand.value, model: fields.model.value, gender, productType: fields.productType.value,
      ukShoeSize, clothingSize, primaryColour, secondaryColour, material: fields.material.value,
      styleCode, internalSku: fields.sku.value, includesText: null, itemFamily,
      conditionText: conditionResolution.text ?? "Condition needs review — please confirm before listing.",
    };
    description = renderEbayDescription(descriptionFacts);
  } else {
    description = fallbackDescription(fields, input.ukSize);
    conditionValue = null;
  }

  let descriptionIssues = validateEbayDescription(description);
  if (descriptionIssues.length > 0) {
    const repaired = repairEbayDescription(description);
    if (repaired && repaired !== description) {
      description = repaired;
      descriptionIssues = validateEbayDescription(description);
    }
  }
  for (const issue of descriptionIssues) aiWarnings.push({ code: `description_${issue.code}`, message: issue.message, field: "description", severity: "warning" });

  const readiness = computeMarketplaceReadiness({
    hasCategory: false, hasCondition: Boolean(conditionValue), hasTitle: title.length > 0, hasDescriptionOrGenerationPath: description.length > 0,
    hasPhoto: input.hasPhoto, hasPrice: input.pricePence != null, hasQuantity: input.quantity != null,
    hasSufficientSellingSettings: true, hasGeneratedContent: contentGeneration.state === "generated",
    requiredAspectsFilled: [], recommendedAspectsFilled: [],
  });

  const validationMessages: MarketplaceValidationMessage[] = [
    { code: "category_not_set", message: "This product needs a category before its eBay details can be prepared.", field: "category", severity: "blocking" },
    ...aiWarnings,
  ];
  if (!conditionValue) {
    // "condition_needs_review" (pushed above, warning severity) already
    // explains the needs-review case with real specificity — this
    // blocking message covers every other reason condition ended up
    // unset (most commonly: the AI call itself failed, so no evidence was
    // ever gathered this attempt).
    const alreadyFlaggedNeedsReview = aiWarnings.some(message => message.code === "condition_needs_review");
    if (!alreadyFlaggedNeedsReview) validationMessages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
  }
  // Stage 6 correction — price is no longer required for eBay CONTENT
  // readiness (see marketplace-readiness.ts's own comment): it's entered
  // later, per-listing, in Listings Review, and only ever blocks the
  // separate "Create eBay drafts" action there (see
  // lib/listing-studio/ebay-draft-eligibility.ts), never this draft's
  // generated-content status. A missing price at generation time is
  // entirely normal and is surfaced as a low-severity suggestion only, not
  // a blocking issue.
  if (input.pricePence == null) validationMessages.push({ code: "price_not_set", message: "No eBay selling price yet — set it in Listings Review before creating a draft.", field: "price", severity: "suggestion" });
  if (input.quantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });
  if (!fields.brand.value && !fields.model.value && !fields.productType.value) {
    validationMessages.push({ code: "no_identified_product", message: "No product details could be identified from the photos yet.", field: null, severity: "warning" });
  }

  const packageSuggestion = suggestPackageSize({
    productType: fields.productType.value, brand: fields.brand.value, model: fields.model.value, material: fields.material.value,
    quantity: input.quantity,
  });

  const productFacts = buildEbayProductFacts({
    brand: fields.brand.value, model: fields.model.value, productType: fields.productType.value,
    colours: fields.colours.value, material: fields.material.value, ukShoeSize, clothingSize, gender,
    itemFamily, internalSku: fields.sku.value, styleCode, conditionState,
  });

  return {
    title, description, conditionValue, productFacts, status: readiness.ready ? "ready" : "needs_information", readiness,
    validationMessages, categorySearchTermsHint, packageSuggestion, contentGeneration,
  };
}
