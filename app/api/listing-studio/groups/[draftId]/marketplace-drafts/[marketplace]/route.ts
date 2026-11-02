import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { marketplaceSchema, marketplaceDraftSettingsSchema, marketplaceAspectValueSchema } from "@/lib/validation/listing-studio-marketplace";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { getEbayAspectDefinitions } from "@/lib/listing-studio/ebay-aspect-service";
import { isAspectValueFilled, isAspectCountableForReadiness } from "@/lib/listing-studio/ebay-aspect-matching";
import { withoutMessageCodePrefix, withoutMessageCodes, SELLING_SETTINGS_MESSAGE_CODES } from "@/lib/listing-studio/ebay-validation-messages";
import type { MarketplaceDynamicData, MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";
import { getEbayItemConditionPolicies } from "@/lib/listing-studio/ebay-taxonomy-client";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string; marketplace: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId, marketplace } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const marketplaceValue = marketplaceSchema.parse(marketplace);
    const draft = await getMarketplaceDraft(user.id, draftId, marketplaceValue);
    if (!draft) return NextResponse.json({ error: "Marketplace draft not found." }, { status: 404 });
    return NextResponse.json({ draft });
  } catch (error) { return safeApiError(error, "Could not load this marketplace draft."); }
}

// Stage 3 fields only — category/condition/dynamic aspects are edited
// through their own dedicated Stage 4/5 endpoints once those exist, since
// changing a category must trigger aspect-definition revalidation (see the
// product spec's own "Manual change" rules), which this narrow route does
// not attempt.
const editorDynamicDataSchema = z.record(z.string().trim().min(1).max(120), z.unknown()).superRefine((values, context) => {
  for (const [name, value] of Object.entries(values)) {
    // The generated draft deliberately stores internal records such as
    // __productFacts and __contentGeneration beside normal eBay aspects.
    // They are server-created JSON objects, not MarketplaceAspectValue
    // records, and must round-trip unchanged through Save & close.
    if (name.startsWith("__")) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "Reserved listing metadata must be an object." });
      }
      continue;
    }
    const parsed = marketplaceAspectValueSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: [name, ...issue.path] });
    }
  }
}).transform(values => values as MarketplaceDynamicData);

const patchRequestSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(100_000).optional(),
  contentMode: z.enum(["seo_optimised", "exact_copy"]).optional(),
  pricePence: z.number().int().nonnegative().nullable().optional(),
  quantity: z.number().int().positive().max(1000).nullable().optional(),
  conditionValue: z.string().trim().min(1).max(120).nullable().optional(),
  // Reserved editor entries such as __packageSize may carry a small
  // display-only `reason` alongside the canonical aspect shape. Preserve
  // those known server-created extras rather than stripping or rejecting
  // them when the editor submits its one atomic Save & close payload.
  dynamicData: editorDynamicDataSchema.optional(),
  settings: marketplaceDraftSettingsSchema.optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string; marketplace: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId, marketplace } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const marketplaceValue = marketplaceSchema.parse(marketplace);
    const patch = patchRequestSchema.parse(await request.json());

    const existing = await getMarketplaceDraft(user.id, draftId, marketplaceValue);
    if (!existing) return NextResponse.json({ error: "Marketplace draft not found." }, { status: 404 });

    const nextTitle = patch.title !== undefined ? patch.title : existing.title;
    const nextDescription = patch.description !== undefined ? patch.description : existing.description;
    const nextPrice = patch.pricePence !== undefined ? patch.pricePence : existing.pricePence;
    const nextQuantity = patch.quantity !== undefined ? patch.quantity : existing.quantity;
    const nextCondition = patch.conditionValue !== undefined ? patch.conditionValue : existing.conditionValue;
    let nextDynamicData = patch.dynamicData ?? existing.dynamicData;

    // A condition is only accepted if eBay's live UK metadata says the
    // currently selected category supports that exact display value. This
    // prevents a generic “Very Good” label being saved into footwear
    // categories that actually require “Pre-owned - Excellent/Good/Fair”.
    const conditionChanged = patch.conditionValue !== undefined && patch.conditionValue !== existing.conditionValue;
    if (conditionChanged && patch.conditionValue != null) {
      if (marketplaceValue !== "EBAY_UK" || !existing.categoryId) {
        return NextResponse.json({ error: "Choose an eBay category before setting its condition." }, { status: 409 });
      }
      const conditions = await getEbayItemConditionPolicies(existing.categoryId);
      if (!conditions.ok) return NextResponse.json({ error: "Could not verify this condition with eBay. Try again shortly." }, { status: 502 });
      if (!conditions.data.some(condition => condition.conditionDescription === patch.conditionValue)) {
        return NextResponse.json({ error: "That condition is not available for this eBay category." }, { status: 400 });
      }
      nextDynamicData = {
        ...nextDynamicData,
        __conditionSelection: {
          value: patch.conditionValue,
          confidence: "high",
          source: "manual",
          appliedAutomatically: false,
          needsReview: false,
          userConfirmed: true,
          updatedAt: new Date().toISOString(),
        },
      };
    }

    // Live-diagnostic follow-up fix (proven root cause of a price save
    // silently corrupting readiness's required-aspects count) — the old
    // heuristic counted EVERY non-"unknown" dynamicData entry as "required
    // and filled", including reserved pseudo-aspects like __packageSize/
    // __productFacts and genuinely OPTIONAL/RECOMMENDED real aspects. This
    // re-fetches the same (DB-)cached aspect schema Stage 5 already uses
    // and counts only aspects actually marked REQUIRED by eBay itself,
    // excluding intentionally-not-applicable ones (regional shoe sizes).
    // This is stats-only for a price/title/description/quantity save: a
    // hiccup fetching the aspect schema must NEVER block the actual save
    // the owner asked for (falls back to the pre-fix "no aspects counted"
    // behaviour, same as when no category is selected yet).
    let requiredAspectsFilled: boolean[] = [];
    let recommendedAspectsFilled: boolean[] = [];
    if (marketplaceValue === "EBAY_UK" && existing.categoryId) {
      let definitions: Awaited<ReturnType<typeof getEbayAspectDefinitions>> | undefined;
      try { definitions = await getEbayAspectDefinitions(existing.categoryId); } catch { /* stats-only — never blocks the save */ }
      if (definitions?.status === "success") {
        requiredAspectsFilled = definitions.grouped.required
          .filter(a => isAspectCountableForReadiness(nextDynamicData[a.name]))
          .map(a => isAspectValueFilled(nextDynamicData[a.name] ?? { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" }));
        recommendedAspectsFilled = definitions.grouped.recommended
          .filter(a => isAspectCountableForReadiness(nextDynamicData[a.name]))
          .map(a => isAspectValueFilled(nextDynamicData[a.name] ?? { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" }));
      }
    }
    const hasGeneratedContent = readContentGenerationState(nextDynamicData, {
      sourceType: existing.sourceType, contentMode: existing.contentMode,
      hasTitle: Boolean(existing.title), hasDescription: Boolean(existing.description),
    }).state === "generated";
    const readiness = computeMarketplaceReadiness({
      hasCategory: !!existing.categoryId, hasCondition: !!nextCondition,
      hasTitle: !!nextTitle, hasDescriptionOrGenerationPath: !!nextDescription,
      hasPhoto: true, hasPrice: nextPrice != null, hasQuantity: nextQuantity != null,
      hasSufficientSellingSettings: true, hasGeneratedContent, requiredAspectsFilled, recommendedAspectsFilled,
    });
    // Live-diagnostic follow-up fix — this route used to rebuild
    // validationMessages from scratch on every save, silently discarding
    // any existing aspect_*/category_needs_confirmation/ai_warning
    // messages a previous category/aspect pass had already recorded. Now
    // it only replaces the codes it actually recomputes here.
    let validationMessages: MarketplaceValidationMessage[] = withoutMessageCodes(
      withoutMessageCodePrefix(existing.validationMessages, "aspect_")
        .filter(m => m.code !== "category_not_set" && m.code !== "condition_not_set" && m.code !== "condition_needs_review"),
      SELLING_SETTINGS_MESSAGE_CODES,
    );
    if (!existing.categoryId) validationMessages.push({ code: "category_not_set", message: "This product needs a category before its eBay details can be prepared.", field: "category", severity: "blocking" });
    if (!nextCondition) validationMessages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
    // Stage 6 correction — price no longer blocks eBay content readiness
    // (see lib/listing-studio/marketplace-readiness.ts's own comment); it's
    // entered later in Listings Review and only gates draft creation there.
    if (nextPrice == null) validationMessages.push({ code: "price_not_set", message: "No eBay selling price yet — set it in Listings Review before creating a draft.", field: "price", severity: "suggestion" });
    if (nextQuantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });
    if (marketplaceValue === "EBAY_UK" && existing.categoryId) {
      let definitions: Awaited<ReturnType<typeof getEbayAspectDefinitions>> | undefined;
      try { definitions = await getEbayAspectDefinitions(existing.categoryId); } catch { /* validation detail only */ }
      if (definitions?.status === "success") {
        const emptyValue = { value: null, confidence: "unknown" as const, source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" };
        definitions.grouped.required.forEach(aspect => {
          if (isAspectCountableForReadiness(nextDynamicData[aspect.name]) && !isAspectValueFilled(nextDynamicData[aspect.name] ?? emptyValue)) {
            validationMessages.push({ code: `aspect_required_${aspect.name}`, message: `${aspect.name} is required for this eBay category.`, field: aspect.name, severity: "blocking" });
          }
        });
        definitions.grouped.recommended.forEach(aspect => {
          if (isAspectCountableForReadiness(nextDynamicData[aspect.name]) && !isAspectValueFilled(nextDynamicData[aspect.name] ?? emptyValue)) {
            validationMessages.push({ code: `aspect_recommended_${aspect.name}`, message: `${aspect.name} is not provided.`, field: aspect.name, severity: "suggestion" });
          }
        });
      }
    }

    const dbPatch: Record<string, unknown> = {
      status: readiness.ready ? "ready" : "needs_information",
      readiness_json: readiness, validation_messages_json: validationMessages,
    };
    if (patch.title !== undefined) dbPatch.title = patch.title;
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.contentMode !== undefined) dbPatch.content_mode = patch.contentMode;
    if (patch.pricePence !== undefined) dbPatch.price_pence = patch.pricePence;
    if (patch.quantity !== undefined) dbPatch.quantity = patch.quantity;
    if (patch.conditionValue !== undefined) dbPatch.condition_value = patch.conditionValue;
    if (patch.dynamicData !== undefined || patch.conditionValue !== undefined) dbPatch.dynamic_data_json = nextDynamicData;
    if (patch.settings !== undefined) dbPatch.settings_json = { ...existing.settings, ...patch.settings };

    await patchMarketplaceDraft(user.id, existing.id, dbPatch);
    return NextResponse.json({ id: existing.id, status: dbPatch.status, readiness, validationMessages, pricePence: nextPrice, conditionValue: nextCondition, dynamicData: nextDynamicData });
  } catch (error) { return safeApiError(error, "Could not save this marketplace draft."); }
}
