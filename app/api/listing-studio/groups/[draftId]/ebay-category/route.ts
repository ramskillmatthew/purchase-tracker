import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getMarketplaceDraft, patchMarketplaceDraft, getMarketplaceSettingsDefaults } from "@/lib/listing-studio/marketplace-drafts";
import { resolveMarketplaceSettings } from "@/lib/listing-studio/marketplace-settings";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { autoSuggestAndPersistEbayCategory } from "@/lib/listing-studio/ebay-category-automation";
import { autoResolveAndPersistEbayAspects } from "@/lib/listing-studio/ebay-aspect-persistence";
import { getCachedCategoryTreeId } from "@/lib/listing-studio/ebay-taxonomy-cache";
import { getCategorySuggestions } from "@/lib/listing-studio/ebay-taxonomy-client";
import { describeEbayApiFailure } from "@/lib/listing-studio/ebay-error-codes";
import { clearRealAspectFields } from "@/lib/listing-studio/ebay-aspect-matching";
import { buildSellingSettingsMessages, withoutMessageCodes, withoutMessageCodePrefix, SELLING_SETTINGS_MESSAGE_CODES } from "@/lib/listing-studio/ebay-validation-messages";
import type { MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";

export const runtime = "nodejs";

/**
 * Stage 4 — runs the real eBay category suggestion pipeline for this
 * product's eBay UK draft (Fault 3 fix: this is now also called
 * AUTOMATICALLY right after an eBay draft is first generated — see
 * app/api/listing-studio/groups/[draftId]/generate/route.ts's own eBay
 * branch — so this route is a RETRY/CHANGE action, never the mandatory
 * first step). Shares its actual suggest+persist logic with that automatic
 * call site via lib/listing-studio/ebay-category-automation.ts, so the two
 * can never drift apart. Never fabricates a category — see that module's
 * own confidence-tiered persistence rules.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const ebayDraft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!ebayDraft) return NextResponse.json({ error: "Generate an eBay draft for this product before choosing a category." }, { status: 404 });

    const accountDefaults = await getMarketplaceSettingsDefaults(user.id, "EBAY_UK");
    const settings = resolveMarketplaceSettings(accountDefaults, null, ebayDraft.settings);
    const outcome = await autoSuggestAndPersistEbayCategory(user.id, draftId, settings.automationMode, ebayDraft);

    if (outcome.status === "failed") {
      // Phase 8 fix — a safe error CODE (never the raw provider error,
      // never a secret) alongside the honest, precise message, so the
      // client can distinguish "not configured" from "auth failed" from
      // "temporarily unavailable" instead of one generic bucket.
      const httpStatus = outcome.reason === "not_configured" ? 503 : outcome.code === "EBAY_AUTH_FAILED" ? 502 : outcome.code === "EBAY_RATE_LIMITED" ? 429 : 502;
      return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: httpStatus });
    }
    // Live-diagnostic follow-up fix (Phase 7 — item specifics no longer
    // require a manual "Suggest item specifics" click as the mandatory
    // next step): once a category is genuinely applied, immediately run
    // the SAME aspect-mapping pipeline generation already triggers, so the
    // manual retry path ("Suggest category") reaches the same fully
    // automated end state. A failure here is never fatal to the category
    // change itself — it's surfaced only as slightly stale readiness; the
    // owner can still retry via "Suggest item specifics".
    let aspectReadiness = outcome.status === "applied" ? outcome.readiness : null;
    if (outcome.status === "applied") {
      try {
        const aspectOutcome = await autoResolveAndPersistEbayAspects(user.id, draftId);
        if (aspectOutcome.status === "applied") aspectReadiness = aspectOutcome.readiness;
      } catch {
        // Never lets an aspect-mapping failure undo or fail the category
        // change that already succeeded and was already persisted above.
      }
    }

    // Re-fetch so the client sees exactly what was persisted (selected
    // category, alternatives, search terms, freshly mapped item
    // specifics) rather than reconstructing it here a second time.
    const refreshed = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    return NextResponse.json({
      selected: outcome.status === "applied" ? { categoryId: refreshed?.categoryId, categoryName: refreshed?.categoryName, categoryPath: refreshed?.categoryPath, confidence: refreshed?.categoryConfidence } : null,
      alternatives: refreshed?.categoryAlternatives ?? [], searchTerms: refreshed?.categorySearchTerms ?? "", readiness: aspectReadiness ?? outcome.readiness,
      dynamicData: refreshed?.dynamicData ?? {},
      leftUnresolved: outcome.status === "left_unresolved",
      // Phase 8 fix — "the live localhost UI must state when it is using
      // fixture mode." True only when no real eBay credentials are
      // configured at all (see ebay-category-service.ts's own useFixture
      // gate) — never true once real credentials exist, even invalid ones.
      usedFixture: outcome.usedFixture,
    });
  } catch (error) { return safeApiError(error, "Could not suggest an eBay category for this product."); }
}

const patchRequestSchema = z.object({ categoryId: z.string().min(1), searchTerms: z.string().min(1).max(300) });

/**
 * Manual category change. NEVER trusts a client-supplied category name/path
 * — re-fetches real suggestions for the given searchTerms and only accepts
 * categoryId if it's genuinely present in that fresh eBay response,
 * exactly mirroring the product spec's "AI cannot submit a category ID
 * that eBay did not return" rule for the human path too. Recomputes
 * readiness and clears any dynamic item-specifics that no longer apply to
 * the new category (Stage 5 will populate these once its aspect-fetching
 * exists; for now this route already always replaces dynamic_data_json
 * with an empty object on a category change, so a later Stage 5 addition
 * never has to retrofit this safety rule).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const { categoryId, searchTerms } = patchRequestSchema.parse(await request.json());

    const ebayDraft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!ebayDraft) return NextResponse.json({ error: "eBay draft not found." }, { status: 404 });

    const treeResult = await getCachedCategoryTreeId("EBAY_GB");
    if (!treeResult.ok) {
      const { code, message } = describeEbayApiFailure(treeResult.error);
      return NextResponse.json({ error: message, code }, { status: treeResult.error === "not_configured" ? 503 : code === "EBAY_RATE_LIMITED" ? 429 : 502 });
    }
    const suggestionsResult = await getCategorySuggestions(treeResult.data.categoryTreeId, searchTerms);
    if (!suggestionsResult.ok) {
      const { code, message } = describeEbayApiFailure(suggestionsResult.error);
      return NextResponse.json({ error: message, code }, { status: suggestionsResult.error === "not_configured" ? 503 : code === "EBAY_RATE_LIMITED" ? 429 : 502 });
    }

    const match = suggestionsResult.data.find(s => s.category.categoryId === categoryId);
    if (!match) return NextResponse.json({ error: "The suggested value is not accepted by eBay. Choose another value." }, { status: 422 });

    const ancestors = match.categoryTreeNodeAncestors ?? [];
    const categoryName = match.category.categoryName;
    const categoryPath = [...ancestors.map(a => a.categoryName), categoryName].join(" > ");
    const previousSelected = ebayDraft.categoryId ? { categoryId: ebayDraft.categoryId, categoryName: ebayDraft.categoryName ?? "", categoryPath: ebayDraft.categoryPath ?? "", rank: 99, confidence: "low" as const, reason: "Previously selected category." } : null;
    const nextAlternatives = [previousSelected, ...ebayDraft.categoryAlternatives ?? []].filter((a): a is NonNullable<typeof a> => !!a && a.categoryId !== categoryId).slice(0, 4);

    const requiredAspectsFilled: boolean[] = [];
    const hasGeneratedContent = readContentGenerationState(ebayDraft.dynamicData, {
      sourceType: ebayDraft.sourceType, contentMode: ebayDraft.contentMode,
      hasTitle: Boolean(ebayDraft.title), hasDescription: Boolean(ebayDraft.description),
    }).state === "generated";
    const readiness = computeMarketplaceReadiness({
      hasCategory: true, hasCondition: !!ebayDraft.conditionValue, hasTitle: !!ebayDraft.title, hasDescriptionOrGenerationPath: !!ebayDraft.description,
      hasPhoto: true, hasPrice: ebayDraft.pricePence != null, hasQuantity: ebayDraft.quantity != null,
      hasSufficientSellingSettings: true, hasGeneratedContent, requiredAspectsFilled, recommendedAspectsFilled: [],
    });
    let validationMessages: MarketplaceValidationMessage[] = withoutMessageCodePrefix(
      ebayDraft.validationMessages.filter(m => m.code !== "category_not_set" && m.code !== "category_needs_confirmation"),
      "aspect_",
    );
    validationMessages = withoutMessageCodes(validationMessages, SELLING_SETTINGS_MESSAGE_CODES);
    validationMessages.push(...buildSellingSettingsMessages(ebayDraft));

    await patchMarketplaceDraft(user.id, ebayDraft.id, {
      category_id: categoryId, category_name: categoryName, category_path: categoryPath,
      category_source: "manual", category_confidence: null,
      category_alternatives_json: nextAlternatives, category_search_terms: searchTerms,
      // Live-diagnostic follow-up fix (proven root cause of package size
      // reverting to "Not set" on every manual category change) — a new
      // category genuinely invalidates the OLD category's real taxonomy
      // aspect values (cleared here), but never the reserved pseudo-
      // aspects (__packageSize/__contentGeneration/__productFacts), which
      // are not category-specific data at all. See clearRealAspectFields.
      dynamic_data_json: clearRealAspectFields(ebayDraft.dynamicData),
      status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
    });

    // Live-diagnostic follow-up fix (Phase 7) — a category genuinely just
    // changed, so its item specifics are re-mapped immediately rather than
    // waiting for a separate manual "Suggest item specifics" click. Best-
    // effort: a failure here doesn't undo/fail the category change already
    // persisted above — the owner can still retry via "Suggest item
    // specifics" if this genuinely fails.
    let finalReadiness = readiness;
    try {
      const aspectOutcome = await autoResolveAndPersistEbayAspects(user.id, draftId);
      if (aspectOutcome.status === "applied") finalReadiness = aspectOutcome.readiness;
    } catch { /* category change already succeeded and was already persisted above */ }

    return NextResponse.json({ categoryId, categoryName, categoryPath, readiness: finalReadiness });
  } catch (error) { return safeApiError(error, "Could not change this product's eBay category."); }
}
