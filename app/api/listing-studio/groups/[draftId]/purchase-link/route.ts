import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { findInventoryLinkCandidates } from "@/lib/listing-studio/inventory-link";
import { poundsToPence } from "@/lib/sales/money";

type DraftRow = { id: string; title: string | null; generated_title: string | null; source_type: string | null };
type PurchaseRow = { id: string; sku: string; item_description: string; item_size: string; price_purchased: number | string; stock_status: string };

async function importedDraft(ownerId: string, draftId: string): Promise<DraftRow | null> {
  const rows = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${ownerId}&select=id,title,generated_title,source_type`);
  const draft = rows[0];
  return draft?.source_type === "ebay_uk" ? draft : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
    const draft = await importedDraft(user.id, draftId);
    if (!draft) return NextResponse.json({ error: "Only imported eBay listings can be matched here." }, { status: 404 });
    const query = new URL(request.url).searchParams.get("q")?.trim() || draft.title || draft.generated_title || "";
    return NextResponse.json({ results: await findInventoryLinkCandidates(user.id, query, 20) });
  } catch (error) { return safeApiError(error, "Could not search your in-stock purchases."); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
    if (!await importedDraft(user.id, draftId)) return NextResponse.json({ error: "Only imported eBay listings can be matched here." }, { status: 404 });
    const { purchaseId } = z.object({ purchaseId: z.string().uuid() }).parse(await request.json());
    const rows = await supabaseRequestAll<PurchaseRow>(`purchases?id=eq.${purchaseId}&owner_id=eq.${user.id}&stock_status=eq.in_stock&select=id,sku,item_description,item_size,price_purchased,stock_status`);
    const purchase = rows[0];
    if (!purchase?.sku?.trim()) return NextResponse.json({ error: "That in-stock item has no SKU and cannot be linked." }, { status: 409 });
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ sku: purchase.sku.trim(), updated_at: new Date().toISOString() }),
    });
    return NextResponse.json({
      ok: true,
      sku: purchase.sku.trim(),
      itemDescription: purchase.item_description,
      purchasePricePence: poundsToPence(Number(purchase.price_purchased)),
    });
  } catch (error) { return safeApiError(error, "Could not match this listing to stock."); }
}
