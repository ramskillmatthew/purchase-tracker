import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { createEbayImportSchema, extractEbayItemId, isEbayImportMigrationMissing, validateAndDedupeEbayUrls } from "@/lib/listing-studio/ebay-import";

export const runtime = "nodejs";

type BatchRow = { id: string; status: string; total_count: number; created_at: string; updated_at: string };
type ItemRow = { id: string; batch_id: string; source_url: string; ebay_item_id: string; status: string; title: string | null; photo_count: number; draft_id: string | null; safe_error: string | null; attempt_count: number; created_at: string; updated_at: string };

export async function GET() {
  try {
    const user = await requireOwner();
    const batches = await supabaseRequestAll<BatchRow>(`ebay_import_batches?owner_id=eq.${user.id}&select=id,status,total_count,created_at,updated_at&order=created_at.desc`);
    const active = batches.filter(batch => batch.status !== "completed");
    const visible = [...active, ...batches.filter(batch => batch.status === "completed").slice(0, 5)];
    const items = visible.length ? await supabaseRequestAll<ItemRow>(`ebay_import_items?owner_id=eq.${user.id}&batch_id=in.(${visible.map(row => row.id).join(",")})&select=id,batch_id,source_url,ebay_item_id,status,title,photo_count,draft_id,safe_error,attempt_count,created_at,updated_at&order=created_at.asc`) : [];
    return NextResponse.json({ batches: visible.map(batch => ({ ...batch, items: items.filter(item => item.batch_id === batch.id) })) });
  } catch (error) {
    if (isEbayImportMigrationMissing(error)) return NextResponse.json({ error: "The eBay importer database update is not installed yet. Run supabase-ebay-import-stage-one.sql, then try again." }, { status: 503 });
    return safeApiError(error, "Could not load eBay imports.");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = createEbayImportSchema.parse(await request.json());
    const parsed = validateAndDedupeEbayUrls(input.urls);
    if (parsed.errors.length || !parsed.urls.length) return NextResponse.json({ error: "Some URLs are invalid.", issues: parsed.errors }, { status: 400 });

    const itemIds = parsed.urls.map(url => extractEbayItemId(url)!);
    const existingResponse = await supabaseRequest(`ebay_import_items?owner_id=eq.${user.id}&ebay_item_id=in.(${itemIds.join(",")})&status=in.(waiting,extracting,downloading_photos,processing,imported)&select=source_url,ebay_item_id,draft_id,status`);
    const existing = await existingResponse.json() as { source_url: string; ebay_item_id: string; draft_id: string | null; status: string }[];
    const alreadyQueued = new Map(existing.map(row => [row.ebay_item_id, row]));
    const urls = parsed.urls.filter(url => !alreadyQueued.has(extractEbayItemId(url)!));
    if (!urls.length) return NextResponse.json({ error: "All of these eBay listings are already waiting or have been imported.", duplicates: existing.map(row => row.source_url) }, { status: 409 });

    const batchId = crypto.randomUUID();
    await supabaseRequest("ebay_import_batches", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: batchId, owner_id: user.id, total_count: urls.length }) });
    const items = urls.map(url => ({ id: crypto.randomUUID(), batch_id: batchId, owner_id: user.id, source_url: url, ebay_item_id: extractEbayItemId(url)! }));
    await supabaseRequest("ebay_import_items", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(items) });
    return NextResponse.json({ batch: { id: batchId, status: "waiting", total_count: items.length, items: items.map(item => ({ ...item, status: "waiting", title: null, photo_count: 0, draft_id: null, safe_error: null, attempt_count: 0 })) }, duplicates: existing.map(row => row.source_url) }, { status: 201 });
  } catch (error) {
    if (isEbayImportMigrationMissing(error)) return NextResponse.json({ error: "The eBay importer database update is not installed yet. Run supabase-ebay-import-stage-one.sql, then try again." }, { status: 503 });
    return safeApiError(error, "Could not create the eBay import.");
  }
}

export async function DELETE() {
  try {
    const user = await requireOwner();
    const waiting = await supabaseRequestAll<{ id: string; batch_id: string }>(`ebay_import_items?owner_id=eq.${user.id}&status=eq.waiting&select=id,batch_id&order=created_at.asc`);
    if (waiting.length) {
      await supabaseRequest(`ebay_import_items?owner_id=eq.${user.id}&status=eq.waiting`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      const batchIds = [...new Set(waiting.map(item => item.batch_id))];
      for (const batchId of batchIds) {
        const remaining = await supabaseRequestAll<{ status: string }>(`ebay_import_items?owner_id=eq.${user.id}&batch_id=eq.${batchId}&select=status&order=created_at.asc`);
        if (!remaining.length) await supabaseRequest(`ebay_import_batches?owner_id=eq.${user.id}&id=eq.${batchId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      }
    }
    return NextResponse.json({ ok: true, cleared: waiting.length });
  } catch (error) {
    return safeApiError(error, "Could not clear waiting eBay imports.");
  }
}
