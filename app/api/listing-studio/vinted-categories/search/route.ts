import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { searchActiveSelectableVintedCategories } from "@/lib/listing-studio/vinted-categories-data";

export const runtime = "nodejs";

/**
 * Backs the Edit Fields category picker's search box. Only ever returns
 * active + selectable categories (never the whole catalogue at once —
 * bounded and query-driven) — see
 * lib/listing-studio/vinted-categories-data.ts's own top comment.
 */
export async function GET(request: Request) {
  try {
    await requireOwner();
    const url = new URL(request.url);
    const query = url.searchParams.get("query");
    const audience = url.searchParams.get("audience");
    const itemFamily = url.searchParams.get("itemFamily");
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;

    const outcome = await searchActiveSelectableVintedCategories({
      query, audience, itemFamily,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    });

    if (outcome.status === "query_too_short") {
      return NextResponse.json({ error: "Type at least 2 characters to search categories." }, { status: 400 });
    }
    return NextResponse.json({ results: outcome.results });
  } catch (error) { return safeApiError(error, "Could not search Vinted categories."); }
}
