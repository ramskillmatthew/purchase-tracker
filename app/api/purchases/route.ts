import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { purchaseInputSchema } from "@/lib/validation/purchase";
import { loadPurchaseProtectionMap } from "@/lib/purchases-protection";
import { isFullyProtectedResult, PURCHASE_PROTECTED_MESSAGE, safeDeletePurchases, safeDeletePurchasesInBatches } from "@/lib/purchases-delete";
import { sortPurchasesForDisplay } from "@/lib/purchase-order";
import type { Purchase, PurchaseListItem } from "@/lib/types";

export async function GET() {
  // A single unbounded request here used to be silently capped at
  // PostgREST's configured db-max-rows (1000) — every purchase beyond
  // that was invisible to the Home dashboard and Purchases page alike.
  // supabaseRequestAll pages through the full table instead. `id.desc` is
  // appended purely so supabaseRequestAll's OWN internal Range-based
  // pagination is deterministic even when many rows share both order_date
  // and created_at (routine for a Bulk Input batch, now that rows are no
  // longer given artificially staggered created_at values) — it has no
  // bearing on the final display order below, which is authoritative and
  // computed fresh over the complete fetched set.
  try {
    await requireOwner();
    const [rows, protection] = await Promise.all([
      supabaseRequestAll<Purchase>("purchases?select=*&order=order_date.desc,created_at.desc,id.desc"),
      loadPurchaseProtectionMap(),
    ]);
    // The authoritative display order (see lib/purchase-order.ts) is
    // applied here, once, over the complete dataset — never left for the
    // browser to reconstruct, and never just the raw PostgREST fetch order
    // above (which exists only to keep supabaseRequestAll's own pagination
    // correct, not to represent the final sort). Every consumer of this
    // route (the Purchases page, the Home dashboard's recent list, the
    // global search) receives rows already in the correct order.
    const withProtection: PurchaseListItem[] = sortPurchasesForDisplay(rows).map(row => ({ ...row, protectedSaleId: protection.get(row.id) ?? null }));
    return NextResponse.json(withProtection);
  }
  catch (e) { return safeApiError(e); }
}

export async function POST(request: Request) {
  try {
    await requireOwner();
    const purchase = purchaseInputSchema.parse(await request.json());
    const quantity = purchase.quantity;

    const purchases = Array.from({ length: quantity }, () => ({ ...purchase, quantity: 1 }));
    await supabaseRequest("purchases", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(purchases),
    });
    return NextResponse.json({ ok: true, created: quantity }, { status: 201 });
  }
  catch (e) { return safeApiError(e, "Could not save purchase."); }
}

export async function PATCH(request: Request) {
  try {
    await requireOwner();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Purchase ID is required." }, { status: 400 });
    await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(purchaseInputSchema.omit({ quantity: true }).partial().strict().parse(await request.json())),
    });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not update purchase."); }
}

/**
 * Both branches share the exact same safe-deletion RPC as single delete and
 * bulk-delete (see lib/purchases-delete.ts) — Clear All is never a separate,
 * unsafe "delete everything unconditionally" statement. A purchase
 * currently linked to an active or completed sale is silently skipped, not
 * force-deleted: Clear All's whole point is "delete everything currently
 * safe to delete", so a protected purchase existing is never itself a
 * failure here, only reflected in the returned counts.
 */
export async function DELETE(request: Request) {
  try {
    await requireOwner();
    const params = new URL(request.url).searchParams;
    if (params.get("clear") === "all") {
      const allIds = await supabaseRequestAll<{ id: string }>("purchases?select=id");
      const result = await safeDeletePurchasesInBatches(allIds.map(row => row.id));
      return NextResponse.json({ ok: true, ...result });
    }
    const id = params.get("id");
    if (!id) return NextResponse.json({ error: "Purchase ID is required." }, { status: 400 });
    const result = await safeDeletePurchases([id]);
    if (isFullyProtectedResult(result)) {
      return NextResponse.json({ error: PURCHASE_PROTECTED_MESSAGE, reason: "purchase_linked_to_completed_sale", protectedCount: result.protectedCount, protectedIds: result.protectedIds }, { status: 409 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) { return safeApiError(e, "Could not delete purchase."); }
}
