import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { marketplaceSchema, marketplaceDraftSettingsSchema } from "@/lib/validation/listing-studio-marketplace";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import type { MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";

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
const patchRequestSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(100_000).optional(),
  contentMode: z.enum(["seo_optimised", "exact_copy"]).optional(),
  pricePence: z.number().int().nonnegative().nullable().optional(),
  quantity: z.number().int().positive().max(1000).nullable().optional(),
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

    // Recomputed from the draft's current known state — category/condition
    // and dynamic aspects are whatever Stage 4/5 (or a manual choice) has
    // already set on this row; this route never invents or clears them.
    const requiredAspectsFilled = Object.values(existing.dynamicData).filter(a => a.confidence !== "unknown").map(() => true);
    const readiness = computeMarketplaceReadiness({
      hasCategory: !!existing.categoryId, hasCondition: !!existing.conditionValue,
      hasTitle: !!nextTitle, hasDescriptionOrGenerationPath: !!nextDescription,
      hasPhoto: true, hasPrice: nextPrice != null, hasQuantity: nextQuantity != null,
      hasSufficientSellingSettings: true, requiredAspectsFilled, recommendedAspectsFilled: [],
    });
    const validationMessages: MarketplaceValidationMessage[] = [];
    if (!existing.categoryId) validationMessages.push({ code: "category_not_set", message: "This product needs a category before its eBay details can be prepared.", field: "category", severity: "blocking" });
    if (!existing.conditionValue) validationMessages.push({ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" });
    if (nextPrice == null) validationMessages.push({ code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" });
    if (nextQuantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });

    const dbPatch: Record<string, unknown> = {
      status: readiness.ready ? "ready" : "needs_information",
      readiness_json: readiness, validation_messages_json: validationMessages,
    };
    if (patch.title !== undefined) dbPatch.title = patch.title;
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.contentMode !== undefined) dbPatch.content_mode = patch.contentMode;
    if (patch.pricePence !== undefined) dbPatch.price_pence = patch.pricePence;
    if (patch.quantity !== undefined) dbPatch.quantity = patch.quantity;
    if (patch.settings !== undefined) dbPatch.settings_json = { ...existing.settings, ...patch.settings };

    await patchMarketplaceDraft(user.id, existing.id, dbPatch);
    return NextResponse.json({ id: existing.id, status: dbPatch.status, readiness, validationMessages });
  } catch (error) { return safeApiError(error, "Could not save this marketplace draft."); }
}
