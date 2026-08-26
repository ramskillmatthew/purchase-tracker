import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { clampLimit, clampOffset, searchAvailablePurchases } from "@/lib/sales/available-purchases";

/**
 * Search endpoint behind Quick Sale / Order Sale's product search — never
 * loads every purchase into the browser (see lib/sales/available-purchases.ts's
 * own comment on why this stays server-side, paginated, and scoped to
 * genuinely sellable units only).
 */
export async function GET(request: Request) {
  try {
    await requireOwner();
    const { searchParams } = new URL(request.url);
    const term = searchParams.get("q") ?? "";
    const limit = clampLimit(searchParams.get("limit"));
    const offset = clampOffset(searchParams.get("offset"));
    const { results, total } = await searchAvailablePurchases(term, limit, offset);
    return NextResponse.json({ results, total, limit, offset });
  } catch (error) { return safeApiError(error, "Could not search available purchases."); }
}
