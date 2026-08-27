import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getCachedCategoryTreeId } from "@/lib/listing-studio/ebay-taxonomy-cache";
import { getCategorySuggestions } from "@/lib/listing-studio/ebay-taxonomy-client";

export const runtime = "nodejs";

const searchRequestSchema = z.object({ query: z.string().trim().min(1).max(300) });

/**
 * Stage 4 — "Manual change" browsing. Runs a fresh, owner-typed search
 * directly against eBay's real get_category_suggestions endpoint (never a
 * cached/stale list) and returns the ranked results for the owner to pick
 * from. Deliberately does NOT persist anything — confirming a choice goes
 * through the sibling PATCH .../ebay-category route, which independently
 * re-verifies the chosen id against a fresh eBay response before saving,
 * so a result shown here can never be trusted purely because it was once
 * displayed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const { query } = searchRequestSchema.parse(await request.json());

    const treeResult = await getCachedCategoryTreeId("EBAY_GB");
    if (!treeResult.ok) return NextResponse.json({ error: "eBay category access has not been configured yet." }, { status: 503 });

    const suggestionsResult = await getCategorySuggestions(treeResult.data.categoryTreeId, query);
    if (!suggestionsResult.ok) return NextResponse.json({ error: "We could not retrieve eBay categories. Try again shortly." }, { status: 502 });

    const results = suggestionsResult.data
      .map(s => ({
        categoryId: s.category.categoryId, categoryName: s.category.categoryName,
        categoryPath: [...(s.categoryTreeNodeAncestors ?? []).map(a => a.categoryName), s.category.categoryName].join(" > "),
        relevancy: s.relevancy ? Number.parseFloat(s.relevancy) : null,
      }))
      .sort((a, b) => (b.relevancy ?? 0) - (a.relevancy ?? 0));

    return NextResponse.json({ query, results, stale: treeResult.data.stale });
  } catch (error) { return safeApiError(error, "Could not search eBay categories."); }
}
