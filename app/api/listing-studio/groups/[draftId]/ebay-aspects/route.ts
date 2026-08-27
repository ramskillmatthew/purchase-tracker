import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { resolveEbayAspects, getEbayAspectDefinitions } from "@/lib/listing-studio/ebay-aspect-service";
import { isAspectValueFilled } from "@/lib/listing-studio/ebay-aspect-matching";
import { getMarketplaceDraft, patchMarketplaceDraft, getMarketplaceSettingsDefaults } from "@/lib/listing-studio/marketplace-drafts";
import { resolveMarketplaceSettings } from "@/lib/listing-studio/marketplace-settings";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { marketplaceAspectValueSchema } from "@/lib/validation/listing-studio-marketplace";
import type { SharedFacts, MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";

export const runtime = "nodejs";

type ProductRow = { brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null; shared_facts_json: SharedFacts | null; ai_result_json: { itemSpecifics?: Record<string, string> } | null };

function flattenSharedFacts(facts: SharedFacts | null): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, fact] of Object.entries(facts ?? {})) if (fact?.value) flat[name] = fact.value;
  return flat;
}

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
      const message = outcome.status === "not_configured" ? "eBay category access has not been configured yet." : "We could not retrieve eBay item specifics. Try again shortly.";
      return NextResponse.json({ error: message, status: outcome.status }, { status: outcome.status === "not_configured" ? 503 : 502 });
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

    const products = await supabaseRequestAll<ProductRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=brand,model,product_type,colours,material,shared_facts_json,ai_result_json`);
    const product = products[0];
    if (!product) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    const accountDefaults = await getMarketplaceSettingsDefaults(user.id, "EBAY_UK");
    const settings = resolveMarketplaceSettings(accountDefaults, null, ebayDraft.settings);

    const outcome = await resolveEbayAspects({
      categoryId: ebayDraft.categoryId, brand: product.brand, productType: product.product_type, model: product.model,
      title: ebayDraft.title, importedItemSpecifics: product.ai_result_json?.itemSpecifics ?? {},
      sharedFacts: flattenSharedFacts(product.shared_facts_json), vintedColours: product.colours ?? [], vintedMaterial: product.material,
      automationMode: settings.automationMode,
    });

    if (outcome.status !== "success") {
      const message = outcome.status === "not_configured" ? "eBay category access has not been configured yet." : "We could not retrieve eBay item specifics. Try again shortly.";
      return NextResponse.json({ error: message, status: outcome.status }, { status: outcome.status === "not_configured" ? 503 : 502 });
    }

    const requiredAspectsFilled = outcome.grouped.required.map(a => isAspectValueFilled(outcome.dynamicData[a.name] ?? { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" }));
    const recommendedAspectsFilled = outcome.grouped.recommended.map(a => isAspectValueFilled(outcome.dynamicData[a.name] ?? { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" }));

    const readiness = computeMarketplaceReadiness({
      hasCategory: true, hasCondition: !!ebayDraft.conditionValue, hasTitle: !!ebayDraft.title, hasDescriptionOrGenerationPath: !!ebayDraft.description,
      hasPhoto: true, hasPrice: ebayDraft.pricePence != null, hasQuantity: ebayDraft.quantity != null,
      hasSufficientSellingSettings: true, requiredAspectsFilled, recommendedAspectsFilled,
    });

    const validationMessages: MarketplaceValidationMessage[] = ebayDraft.validationMessages.filter(m => !m.code.startsWith("aspect_"));
    outcome.grouped.required.forEach((aspect, index) => {
      if (!requiredAspectsFilled[index]) validationMessages.push({ code: `aspect_required_${aspect.name}`, message: `${aspect.name} is required for this eBay category.`, field: aspect.name, severity: "blocking" });
    });
    outcome.grouped.recommended.forEach((aspect, index) => {
      if (!recommendedAspectsFilled[index]) validationMessages.push({ code: `aspect_recommended_${aspect.name}`, message: `${aspect.name} is not provided.`, field: aspect.name, severity: "suggestion" });
    });
    if (!ebayDraft.conditionValue) validationMessages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
    if (ebayDraft.pricePence == null) validationMessages.push({ code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" });
    if (ebayDraft.quantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });

    await patchMarketplaceDraft(user.id, ebayDraft.id, {
      dynamic_data_json: outcome.dynamicData,
      status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
    });

    return NextResponse.json({
      required: outcome.grouped.required, recommended: outcome.grouped.recommended, optional: outcome.grouped.optional,
      dynamicData: outcome.dynamicData, readiness, stale: outcome.stale,
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

    await patchMarketplaceDraft(user.id, ebayDraft.id, { dynamic_data_json: nextDynamicData });
    return NextResponse.json({ aspectName, value: nextDynamicData[aspectName] });
  } catch (error) { return safeApiError(error, "Could not save this item specific."); }
}
