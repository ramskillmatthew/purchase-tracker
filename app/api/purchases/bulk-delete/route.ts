import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { deletePurchasesInputSchema } from "@/lib/validation/purchase";
import { isFullyProtectedResult, PURCHASES_PROTECTED_MESSAGE, safeDeletePurchases } from "@/lib/purchases-delete";

/**
 * Dedicated multi-select bulk delete — distinct from the clear-everything
 * path in app/api/purchases/route.ts, which shares the same underlying
 * safe_delete_purchases RPC (see lib/purchases-delete.ts) rather than a
 * separate/inconsistent implementation. Deletes only the explicitly
 * supplied, deduplicated ids, in one atomic RPC call — never one request
 * per purchase, and never a raw multi-row DELETE that a single protected id
 * would abort entirely for the whole batch.
 */
export async function POST(request: Request) {
  try {
    await requireOwner();
    const { ids } = deletePurchasesInputSchema.parse(await request.json());
    const result = await safeDeletePurchases(ids);
    if (isFullyProtectedResult(result)) {
      return NextResponse.json({ error: PURCHASES_PROTECTED_MESSAGE, reason: "purchase_linked_to_completed_sale", protectedCount: result.protectedCount, protectedIds: result.protectedIds }, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (error) { return safeApiError(error, "Could not delete the selected purchases."); }
}
