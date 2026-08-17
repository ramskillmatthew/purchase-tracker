import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";

const MAX_BULK_DELETE_IDS = 500;
const bulkDeleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_DELETE_IDS) }).strict();

/**
 * Dedicated multi-select bulk delete — distinct from the clear-everything
 * path in app/api/purchases/route.ts, which wipes every purchase
 * unconditionally and is never reused or triggered here. Deletes only the explicitly
 * supplied, deduplicated ids in one DELETE statement (single-transaction,
 * so it's all-or-nothing) instead of one request per purchase.
 * `Prefer: return=representation` reports back exactly which ids were
 * actually deleted, so the client can reconcile its selection safely even
 * if an id had already been removed by something else.
 */
export async function POST(request: Request) {
  try {
    await requireOwner();
    const { ids } = bulkDeleteSchema.parse(await request.json());
    const uniqueIds = Array.from(new Set(ids));
    const response = await supabaseRequest(`purchases?id=in.(${uniqueIds.join(",")})&select=id`, {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });
    const deleted = (await response.json()) as { id: string }[];
    return NextResponse.json({ deletedIds: deleted.map(row => row.id) });
  } catch (error) { return safeApiError(error, "Could not delete the selected purchases."); }
}
