import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayAspectDefinitions } from "@/lib/listing-studio/ebay-aspect-service";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { autoResolveAndPersistEbayAspects } from "@/lib/listing-studio/ebay-aspect-persistence";
import { describeEbayAspectsFailure } from "@/lib/listing-studio/ebay-error-codes";
import { marketplaceAspectValueSchema } from "@/lib/validation/listing-studio-marketplace";
import { isAspectValueFilled, isAspectCountableForReadiness } from "@/lib/listing-studio/ebay-aspect-matching";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { withoutMessageCodePrefix, withoutMessageCodes, buildSellingSettingsMessages, SELLING_SETTINGS_MESSAGE_CODES } from "@/lib/listing-studio/ebay-validation-messages";
import type { MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";

export const runtime = "nodejs";

/**
 * Read-only: current aspect definitions + whatever values are already
 * stored, with NO candidate matching and NO AI call — see
 * getEbayAspectDefinitions's own comment on why this exists separately
 * from POST below. This is what the eBay details editor calls when it
 * opens; POST is only ever called by an explicit "Suggest item specifics"
 * action.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const ebayDraft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!ebayDraft) return NextResponse.json({ error: "Generate an eBay draft for this product before viewing item specifics." }, { status: 404 });
    if (!ebayDraft.categoryId) return NextResponse.json({ required: [], recommended: [], optional: [], dynamicData: ebayDraft.dynamicData, stale: false });

    const outcome = await getEbayAspectDefinitions(ebayDraft.categoryId);
    if (outcome.status !== "success") {
      const reason = outcome.status === "not_configured" ? "not_configured" : outcome.reason;
      const { code, message } = describeEbayAspectsFailure(reason);
      return NextResponse.json({ error: message, code }, { status: reason === "not_configured" ? 503 : code === "EBAY_RATE_LIMITED" ? 429 : 502 });
    }
    return NextResponse.json({ required: outcome.grouped.required, recommended: outcome.grouped.recommended, optional: outcome.grouped.optional, dynamicData: ebayDraft.dynamicData, stale: outcome.stale });
  } catch (error) { return safeApiError(error, "Could not load this product's eBay item specifics."); }
}

/**
 * Stage 5 — fetches this draft's currently-selected eBay category's real
 * aspect definitions, matches every one against real known product
 * evidence (never inventing), and persists the result. Requires a category
 * to already be selected (Stage 4) — item specifics are meaningless
 * without one, since they're entirely category-specific. Only ever called
 * by an explicit "Suggest item specifics" action — never automatically.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const ebayDraft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!ebayDraft) return NextResponse.json({ error: "Generate an eBay draft for this product before completing item specifics." }, { status: 404 });
    if (!ebayDraft.categoryId) return NextResponse.json({ error: "This product needs a category before its eBay details can be prepared." }, { status: 400 });

    const outcome = await autoResolveAndPersistEbayAspects(user.id, draftId, ebayDraft);
    if (outcome.status !== "applied") {
      return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: outcome.reason === "not_configured" ? 503 : outcome.code === "EBAY_RATE_LIMITED" ? 429 : 502 });
    }

    const refreshed = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    const definitions = await getEbayAspectDefinitions(ebayDraft.categoryId);
    return NextResponse.json({
      required: definitions.status === "success" ? definitions.grouped.required : [],
      recommended: definitions.status === "success" ? definitions.grouped.recommended : [],
      optional: definitions.status === "success" ? definitions.grouped.optional : [],
      dynamicData: refreshed?.dynamicData ?? {}, readiness: outcome.readiness,
      stale: definitions.status === "success" ? definitions.stale : false,
    });
  } catch (error) { return safeApiError(error, "Could not prepare this product's eBay item specifics."); }
}

const patchRequestSchema = z.object({ aspectName: z.string().trim().min(1).max(120), value: marketplaceAspectValueSchema.shape.value, confirm: z.boolean().default(true) });

/**
 * Manual edit/confirm of one aspect. Setting userConfirmed=true (the
 * default) is what lets a low-confidence suggestion — or a value the owner
 * typed themselves — count toward readiness (see
 * lib/listing-studio/ebay-aspect-matching.ts's isAspectValueFilled). The
 * value itself is NOT re-validated against eBay's allowed-value list here
 * (unlike category selection): a SELECTION_ONLY aspect's own already-
 * fetched allowed values are enforced client-side by only ever rendering a
 * choice control for those, and this route trusts the owner's own
 * confirmed choice/edit the same way Edit Fields already trusts a manual
 * correction elsewhere in this app.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const { aspectName, value, confirm } = patchRequestSchema.parse(await request.json());

    const ebayDraft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!ebayDraft) return NextResponse.json({ error: "eBay draft not found." }, { status: 404 });

    const nextDynamicData = {
      ...ebayDraft.dynamicData,
      [aspectName]: {
        value, confidence: value ? "high" as const : "unknown" as const, source: "manual",
        appliedAutomatically: false, needsReview: false, userConfirmed: confirm, updatedAt: new Date().toISOString(),
      },
    };

    // Live-diagnostic follow-up fix (Phase 5 — "recalculate readiness
    // immediately after every saved change") — a manual edit/confirm of a
    // single aspect (this includes __packageSize, saved through this same
    // route) used to leave the draft's stored readiness/validationMessages
    // stale until a separate "Suggest item specifics" re-run. Best-effort:
    // a hiccup fetching the aspect schema never blocks the save itself —
    // falls back to an empty required/recommended count, same as before
    // this fix existed.
    let requiredAspectsFilled: boolean[] = [];
    let recommendedAspectsFilled: boolean[] = [];
    if (ebayDraft.categoryId) {
      let definitions: Awaited<ReturnType<typeof getEbayAspectDefinitions>> | undefined;
      try { definitions = await getEbayAspectDefinitions(ebayDraft.categoryId); } catch { /* stats-only — never blocks the save */ }
      if (definitions?.status === "success") {
        requiredAspectsFilled = definitions.grouped.required
          .filter(a => isAspectCountableForReadiness(nextDynamicData[a.name]))
          .map(a => isAspectValueFilled(nextDynamicData[a.name] ?? { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" }));
        recommendedAspectsFilled = definitions.grouped.recommended
          .filter(a => isAspectCountableForReadiness(nextDynamicData[a.name]))
          .map(a => isAspectValueFilled(nextDynamicData[a.name] ?? { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" }));
      }
    }
    const hasGeneratedContent = readContentGenerationState(ebayDraft.dynamicData, {
      sourceType: ebayDraft.sourceType, contentMode: ebayDraft.contentMode,
      hasTitle: Boolean(ebayDraft.title), hasDescription: Boolean(ebayDraft.description),
    }).state === "generated";
    const readiness = computeMarketplaceReadiness({
      hasCategory: !!ebayDraft.categoryId, hasCondition: !!ebayDraft.conditionValue, hasTitle: !!ebayDraft.title, hasDescriptionOrGenerationPath: !!ebayDraft.description,
      hasPhoto: true, hasPrice: ebayDraft.pricePence != null, hasQuantity: ebayDraft.quantity != null,
      hasSufficientSellingSettings: true, hasGeneratedContent, requiredAspectsFilled, recommendedAspectsFilled,
    });
    let validationMessages: MarketplaceValidationMessage[] = withoutMessageCodePrefix(ebayDraft.validationMessages, "aspect_");
    validationMessages = withoutMessageCodes(validationMessages, SELLING_SETTINGS_MESSAGE_CODES);
    validationMessages.push(...buildSellingSettingsMessages(ebayDraft));

    await patchMarketplaceDraft(user.id, ebayDraft.id, {
      dynamic_data_json: nextDynamicData,
      status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
    });
    return NextResponse.json({ aspectName, value: nextDynamicData[aspectName], readiness });
  } catch (error) { return safeApiError(error, "Could not save this item specific."); }
}
