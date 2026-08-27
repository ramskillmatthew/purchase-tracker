import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { suggestEbayCategory, describeEbayCategorySuggestionFailure } from "@/lib/listing-studio/ebay-category-service";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import type { SharedFacts, MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";
import { getCachedCategoryTreeId } from "@/lib/listing-studio/ebay-taxonomy-cache";
import { getCategorySuggestions } from "@/lib/listing-studio/ebay-taxonomy-client";

export const runtime = "nodejs";

type ProductRow = { brand: string | null; model: string | null; product_type: string | null; shared_facts_json: SharedFacts | null };

function sharedFactValue(facts: SharedFacts | null, name: string): string | null {
  return facts?.[name]?.value ?? null;
}

/**
 * Stage 4 — runs the real eBay category suggestion pipeline for this
 * product's eBay UK draft, using structured facts already extracted for it
 * (the same brand/model/productType Vinted generation already produced,
 * plus any Stage-2 shared facts) — never a raw title paragraph. Persists
 * the result (and honestly reports when eBay access isn't configured yet,
 * or is temporarily unavailable) rather than ever fabricating a category.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const products = await supabaseRequestAll<ProductRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=brand,model,product_type,shared_facts_json`);
    const product = products[0];
    if (!product) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    const ebayDraft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!ebayDraft) return NextResponse.json({ error: "Generate an eBay draft for this product before choosing a category." }, { status: 404 });

    const facts = product.shared_facts_json ?? null;
    const outcome = await suggestEbayCategory({
      brand: product.brand, productType: product.product_type, model: product.model,
      set: sharedFactValue(facts, "set"), configuration: sharedFactValue(facts, "configuration"),
      title: ebayDraft.title, knownCategoryName: ebayDraft.categoryName, keyAttributes: [],
    });

    if (outcome.status !== "success") {
      return NextResponse.json({ error: describeEbayCategorySuggestionFailure(outcome), status: outcome.status }, { status: outcome.status === "not_configured" ? 503 : 502 });
    }

    const requiredAspectsFilled = Object.values(ebayDraft.dynamicData).filter(a => a.confidence !== "unknown").map(() => true);
    const readiness = computeMarketplaceReadiness({
      hasCategory: true, hasCondition: !!ebayDraft.conditionValue, hasTitle: !!ebayDraft.title, hasDescriptionOrGenerationPath: !!ebayDraft.description,
      hasPhoto: true, hasPrice: ebayDraft.pricePence != null, hasQuantity: ebayDraft.quantity != null,
      hasSufficientSellingSettings: true, requiredAspectsFilled, recommendedAspectsFilled: [],
    });
    const validationMessages: MarketplaceValidationMessage[] = ebayDraft.validationMessages.filter(m => m.code !== "category_not_set");
    if (outcome.selected.confidence === "low") {
      validationMessages.push({ code: "category_needs_confirmation", message: "The suggested eBay category is uncertain — please confirm it.", field: "category", severity: "warning" });
    }
    if (!ebayDraft.conditionValue) validationMessages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
    if (ebayDraft.pricePence == null) validationMessages.push({ code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" });
    if (ebayDraft.quantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });

    await patchMarketplaceDraft(user.id, ebayDraft.id, {
      category_id: outcome.selected.categoryId, category_name: outcome.selected.categoryName, category_path: outcome.selected.categoryPath,
      category_source: "ai", category_confidence: outcome.selected.confidence,
      category_alternatives_json: outcome.alternatives, category_search_terms: outcome.searchTerms,
      status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
    });

    return NextResponse.json({ selected: outcome.selected, alternatives: outcome.alternatives, searchTerms: outcome.searchTerms, stale: outcome.stale, readiness });
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
    if (!treeResult.ok) return NextResponse.json({ error: "eBay category access has not been configured yet." }, { status: 503 });
    const suggestionsResult = await getCategorySuggestions(treeResult.data.categoryTreeId, searchTerms);
    if (!suggestionsResult.ok) return NextResponse.json({ error: "We could not retrieve eBay categories. Try again shortly." }, { status: 502 });

    const match = suggestionsResult.data.find(s => s.category.categoryId === categoryId);
    if (!match) return NextResponse.json({ error: "The suggested value is not accepted by eBay. Choose another value." }, { status: 422 });

    const ancestors = match.categoryTreeNodeAncestors ?? [];
    const categoryName = match.category.categoryName;
    const categoryPath = [...ancestors.map(a => a.categoryName), categoryName].join(" > ");
    const previousSelected = ebayDraft.categoryId ? { categoryId: ebayDraft.categoryId, categoryName: ebayDraft.categoryName ?? "", categoryPath: ebayDraft.categoryPath ?? "", rank: 99, confidence: "low" as const, reason: "Previously selected category." } : null;
    const nextAlternatives = [previousSelected, ...ebayDraft.categoryAlternatives ?? []].filter((a): a is NonNullable<typeof a> => !!a && a.categoryId !== categoryId).slice(0, 4);

    const requiredAspectsFilled: boolean[] = [];
    const readiness = computeMarketplaceReadiness({
      hasCategory: true, hasCondition: !!ebayDraft.conditionValue, hasTitle: !!ebayDraft.title, hasDescriptionOrGenerationPath: !!ebayDraft.description,
      hasPhoto: true, hasPrice: ebayDraft.pricePence != null, hasQuantity: ebayDraft.quantity != null,
      hasSufficientSellingSettings: true, requiredAspectsFilled, recommendedAspectsFilled: [],
    });
    const validationMessages: MarketplaceValidationMessage[] = ebayDraft.validationMessages.filter(m => m.code !== "category_not_set" && m.code !== "category_needs_confirmation");
    if (!ebayDraft.conditionValue) validationMessages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
    if (ebayDraft.pricePence == null) validationMessages.push({ code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" });
    if (ebayDraft.quantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });

    await patchMarketplaceDraft(user.id, ebayDraft.id, {
      category_id: categoryId, category_name: categoryName, category_path: categoryPath,
      category_source: "manual", category_confidence: null,
      category_alternatives_json: nextAlternatives, category_search_terms: searchTerms,
      // A new category invalidates any previously-fetched aspect definitions.
      dynamic_data_json: {},
      status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
    });

    return NextResponse.json({ categoryId, categoryName, categoryPath, readiness });
  } catch (error) { return safeApiError(error, "Could not change this product's eBay category."); }
}
