import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { extractEbayListing } from "@/lib/listing-studio/ebay-extractor";
import { buildDraftImageStoragePath, LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { deleteStorageObjects, uploadStorageObject } from "@/lib/listing-studio/storage-rest";
import { z } from "zod";
import { isEbayImportMigrationMissing } from "@/lib/listing-studio/ebay-import";
import { extractBearerToken, verifyBatchToken } from "@/lib/listing-studio/extension-batch-tokens";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import type { EbayExtractedListing } from "@/lib/listing-studio/ebay-extractor";

export const runtime = "nodejs";
export const maxDuration = 60;

type ImportItem = { id: string; batch_id: string; source_url: string; status: string; draft_id: string | null; attempt_count: number };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const browserListingSchema = z.object({
  itemId: z.string().regex(/^\d{9,15}$/), url: z.string().url(), title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000), imageUrls: z.array(z.string().url()).min(1).max(24),
  pricePence: z.number().int().nonnegative().nullable(), currency: z.string().max(10).nullable(),
  condition: z.string().max(200).nullable(), category: z.string().max(500).nullable(), brand: z.string().max(300).nullable(),
  size: z.string().max(200).nullable(), colours: z.array(z.string().max(200)).max(2), material: z.string().max(300).nullable(),
  quantity: z.number().int().nonnegative().nullable(), itemSpecifics: z.record(z.string(), z.string().max(5_000)),
});

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

async function requestOwner(request: Request): Promise<{ ownerId: string; extension: boolean }> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return { ownerId: (await requireOwner()).id, extension: false };
  const { batchId } = await verifyBatchToken(token);
  const rows = await supabaseRequestAll<{ owner_id: string }>(`vinted_extension_batches?id=eq.${batchId}&select=owner_id&order=created_at.desc`);
  if (!rows[0]?.owner_id) throw new Error("The extension connection has expired. Pair it with Listing Studio again.");
  return { ownerId: rows[0].owner_id, extension: true };
}

async function patchItem(itemId: string, ownerId: string, values: Record<string, unknown>) {
  await supabaseRequest(`ebay_import_items?id=eq.${itemId}&owner_id=eq.${ownerId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) });
}

async function finishBatch(batchId: string, ownerId: string) {
  const items = await supabaseRequestAll<{ status: string }>(`ebay_import_items?batch_id=eq.${batchId}&owner_id=eq.${ownerId}&select=status&order=created_at.asc`);
  const complete = items.length > 0 && items.every(item => item.status === "imported" || item.status === "failed");
  await supabaseRequest(`ebay_import_batches?id=eq.${batchId}&owner_id=eq.${ownerId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: complete ? "completed" : "processing", updated_at: new Date().toISOString() }) });
}

function imageHostAllowed(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "ebayimg.com" || host.endsWith(".ebayimg.com") || host === "ebaystatic.com" || host.endsWith(".ebaystatic.com");
}

async function downloadImage(urlValue: string): Promise<{ bytes: ArrayBuffer; mimeType: string; filename: string }> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || !imageHostAllowed(url)) throw new Error("An eBay photo used an unsupported image host.");
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; TrottersAttireListingImporter/1.0)" } });
  if (!response.ok) throw new Error(`A listing photo could not be downloaded (${response.status}).`);
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new Error("An eBay photo was not a supported JPG, PNG or WEBP image.");
  const size = Number(response.headers.get("content-length") || 0);
  if (size > MAX_IMAGE_BYTES) throw new Error("An eBay photo was larger than 15 MB.");
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("An eBay photo was empty or larger than 15 MB.");
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return { bytes, mimeType, filename: `ebay-photo.${extension}` };
}

function normaliseCondition(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^https?:\/\/schema\.org\//i, "").replace(/Condition$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || null;
}

export async function POST(request: Request, context: { params: Promise<{ batchId: string; itemId: string }> }) {
  let ownerId = ""; let itemId = ""; let batchId = ""; let draftId: string | null = null; let extensionRequest = false; const storedPaths: string[] = [];
  try {
    const auth = await requestOwner(request); ownerId = auth.ownerId; extensionRequest = auth.extension;
    ({ batchId, itemId } = z.object({ batchId: z.string().uuid(), itemId: z.string().uuid() }).parse(await context.params));
    const rows = await supabaseRequestAll<ImportItem>(`ebay_import_items?id=eq.${itemId}&batch_id=eq.${batchId}&owner_id=eq.${ownerId}&select=id,batch_id,source_url,status,draft_id,attempt_count&order=created_at.asc`);
    const item = rows[0];
    if (!item) return NextResponse.json({ error: "Import item not found." }, { status: 404 });
    if (item.status === "imported" && item.draft_id) return NextResponse.json({ ok: true, draftId: item.draft_id, alreadyImported: true });
    await patchItem(itemId, ownerId, { status: "extracting", safe_error: null, started_at: new Date().toISOString(), completed_at: null, attempt_count: item.attempt_count + 1 });
    await supabaseRequest(`ebay_import_batches?id=eq.${batchId}&owner_id=eq.${ownerId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "processing", updated_at: new Date().toISOString() }) });

    const body = extensionRequest ? await request.json() : null;
    const listing: EbayExtractedListing = extensionRequest ? browserListingSchema.parse(body?.listing) : await extractEbayListing(item.source_url);
    if (listing.itemId !== item.source_url.match(/\/itm\/(\d{9,15})/)?.[1]) throw new Error("The eBay page did not match the queued listing.");
    await patchItem(itemId, ownerId, { status: "downloading_photos", title: listing.title });
    draftId = crypto.randomUUID();
    await supabaseRequest("listing_drafts", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      id: draftId, owner_id: ownerId, title: listing.title, description: listing.description, brand: listing.brand,
      product_type: listing.category, condition: normaliseCondition(listing.condition), uk_size: listing.size,
      colours: listing.colours, material: listing.material, generated_title: listing.title,
      generated_description: listing.description, suggested_price_pence: listing.pricePence,
      status: "needs_review", overall_confidence: "unconfirmed",
      source_type: "ebay_uk", source_url: listing.url, source_item_id: listing.itemId,
      ai_result_json: { source: "ebay_uk", sourceUrl: listing.url, sourceItemId: listing.itemId, importedAt: new Date().toISOString(), currency: listing.currency, quantity: listing.quantity, itemSpecifics: listing.itemSpecifics },
    }) });

    const imageRows: Record<string, unknown>[] = [];
    for (let position = 0; position < listing.imageUrls.length; position++) {
      const photo = await downloadImage(listing.imageUrls[position]);
      const imageId = crypto.randomUUID();
      const filename = `${listing.itemId}-${position + 1}.${photo.filename.split(".").pop()}`;
      const storagePath = buildDraftImageStoragePath(ownerId, draftId, imageId, filename);
      await uploadStorageObject(LISTING_STUDIO_BUCKET, storagePath, photo.bytes, photo.mimeType);
      storedPaths.push(storagePath);
      imageRows.push({ id: imageId, draft_id: draftId, owner_id: ownerId, storage_path: storagePath, original_filename: filename, mime_type: photo.mimeType, file_size: photo.bytes.byteLength, sort_order: position, upload_state: "uploaded", preview_available: true, ai_metadata_json: { sourceUrl: listing.imageUrls[position], source: "ebay_uk" } });
    }
    await patchItem(itemId, ownerId, { status: "processing", photo_count: imageRows.length });
    await supabaseRequest("listing_draft_images", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(imageRows) });
    await patchItem(itemId, ownerId, { status: "imported", draft_id: draftId, photo_count: imageRows.length, completed_at: new Date().toISOString() });
    await finishBatch(batchId, ownerId);
    const success = { ok: true, draftId, title: listing.title, photoCount: imageRows.length };
    return extensionRequest ? extensionCorsJson(request, success) : NextResponse.json(success);
  } catch (error) {
    if (isEbayImportMigrationMissing(error)) return extensionRequest ? extensionCorsJson(request, { error: "The eBay importer database update is not installed yet. Run supabase-ebay-import-stage-one.sql, then try again." }, 503) : NextResponse.json({ error: "The eBay importer database update is not installed yet. Run supabase-ebay-import-stage-one.sql, then try again." }, { status: 503 });
    if (storedPaths.length && ownerId) await deleteStorageObjects(LISTING_STUDIO_BUCKET, storedPaths).catch(() => {});
    if (draftId && ownerId) await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${ownerId}`, { method: "DELETE" }).catch(() => {});
    const safeMessage = error instanceof Error && /eBay|listing|photo|human verification|URL/i.test(error.message) ? error.message.slice(0, 240) : "This listing could not be imported. Please retry.";
    if (itemId && ownerId) await patchItem(itemId, ownerId, { status: "failed", safe_error: safeMessage, draft_id: null, completed_at: new Date().toISOString() }).catch(() => {});
    if (batchId && ownerId) await finishBatch(batchId, ownerId).catch(() => {});
    if (itemId) return extensionRequest ? extensionCorsJson(request, { error: safeMessage }, 422) : NextResponse.json({ error: safeMessage }, { status: 422 });
    return extensionRequest ? extensionSafeApiError(request, error, "Could not import this eBay listing.") : safeApiError(error, "Could not import this eBay listing.");
  }
}
