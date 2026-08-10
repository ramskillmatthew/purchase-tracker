import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ZipArchive } from "archiver";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { getVintedCategoriesByIds, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";
import { normaliseFootwearVintedAudience, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { buildListingWarnings, type ReadinessCheckFields } from "@/lib/listing-studio/listing-review";
import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";
import { buildPurchaseMatchIndex, matchSkuToPurchase, buildPurchaseSkuLookupQueries, type PurchaseMatchRecord } from "@/lib/listing-studio/purchase-match";
import {
  MAX_EXPORT_LISTINGS_PER_BATCH, MAX_EXPORT_PHOTOS_PER_LISTING, MAX_EXPORT_TOTAL_BYTES, EXPORT_SCHEMA_VERSION,
  buildProductFolderName, buildExportManifest, buildExportReadmeText, buildExportRootFolderName, validateExportedListing,
  type ExportedListing,
} from "@/lib/listing-studio/vinted-export-schema";
import { prepareExportPhotos, ExportPhotoError, type ExportPhotoInput } from "@/lib/listing-studio/vinted-export-photos";
import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";

export const runtime = "nodejs";
export const maxDuration = 60;

const exportRequestSchema = z.object({
  draftIds: z.array(uuidSchema).min(1).max(MAX_EXPORT_LISTINGS_PER_BATCH),
}).strict();

type DraftRow = {
  id: string;
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  vinted_audience: VintedAudienceValue | null;
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_status: string | null;
  confirmed_price_pence: number | null;
};
type ImageRow = { id: string; draft_id: string; storage_path: string; mime_type: string; file_size: number; sort_order: number };
type RejectedListing = { draftId: string; sku: string | null; reasons: string[] };

function buildZipBuffer(entries: { path: string; bytes: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("warning", (warning) => { if (warning.code !== "ENOENT") reject(warning); });
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) archive.append(entry.bytes, { name: entry.path });
    void archive.finalize();
  });
}

/**
 * Milestone 7 (revised) — "Save to Vinted drafts" now means "export a ZIP
 * package a human (or another assistant, in a real logged-in browser) can
 * use to manually transfer this listing into Vinted and save it as a
 * Vinted draft themselves." This route never talks to Vinted, never
 * publishes anything, and never creates a Vinted draft automatically —
 * see vinted-export-schema.ts's own top comment.
 *
 * All-or-nothing: if ANY selected listing fails server-side re-validation
 * (Ready status, ownership, existence) the WHOLE request is rejected with
 * a clear per-listing reason list and no ZIP is built at all — never a
 * partial package silently missing a listing the browser thought was
 * included. The browser's own last-known Ready status is never trusted;
 * every check here is recomputed fresh from the database, exactly the
 * same buildListingWarnings function the UI and the mark-ready route both
 * already use, so this can never disagree with what "Ready" means
 * anywhere else in the app.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds } = exportRequestSchema.parse(await request.json());
    // De-dupes defensively — a client bug sending the same id twice must
    // never produce two folders for the same product.
    const uniqueDraftIds = [...new Set(draftIds)];

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=in.(${uniqueDraftIds.join(",")})&owner_id=eq.${user.id}`
      + `&select=id,brand,model,product_type,colours,material,uk_size,sku,condition,generated_title,generated_description,vinted_audience,vinted_category_id,vinted_category_path,vinted_category_status,confirmed_price_pence`,
    );
    const draftsById = new Map(drafts.map(d => [d.id, d]));

    // Any requested id not returned above either doesn't exist or (since
    // the query is already scoped to owner_id=eq.${user.id}) belongs to a
    // different owner — both cases are reported identically, never
    // distinguishing "not yours" from "doesn't exist" to an unauthenticated
    // or cross-owner caller.
    const rejected: RejectedListing[] = uniqueDraftIds
      .filter(id => !draftsById.has(id))
      .map(id => ({ draftId: id, sku: null, reasons: ["Listing not found."] }));

    const foundIds = uniqueDraftIds.filter(id => draftsById.has(id));

    const images = foundIds.length ? await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=in.(${foundIds.join(",")})&owner_id=eq.${user.id}&upload_state=eq.uploaded`
      + `&select=id,draft_id,storage_path,mime_type,file_size,sort_order&order=sort_order.asc`,
    ) : [];
    const imagesByDraftId = new Map<string, ImageRow[]>();
    for (const image of images) {
      const list = imagesByDraftId.get(image.draft_id);
      if (list) list.push(image); else imagesByDraftId.set(image.draft_id, [image]);
    }

    const categoryIds = foundIds.map(id => draftsById.get(id)!.vinted_category_id).filter((id): id is number => id !== null);
    const categoriesById = await getVintedCategoriesByIds(categoryIds);

    const purchaseQueries = buildPurchaseSkuLookupQueries(foundIds.map(id => draftsById.get(id)!.sku));
    const purchaseRecordChunks = await Promise.all(purchaseQueries.map(query => supabaseRequestAll<PurchaseMatchRecord>(query)));
    const purchaseIndex = buildPurchaseMatchIndex(purchaseRecordChunks.flat());

    // --- Server-side re-validation: never trust the browser's Ready status. ---
    for (const id of foundIds) {
      const draft = draftsById.get(id)!;
      const draftImages = imagesByDraftId.get(id) ?? [];
      const itemFamily = deriveDraftItemFamily(draft.product_type);
      const audience = normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily);
      const category = draft.vinted_category_id ? categoriesById.get(draft.vinted_category_id) ?? null : null;

      const readinessFields: ReadinessCheckFields = {
        brand: draft.brand, model: draft.model, productType: draft.product_type, colours: draft.colours ?? [], material: draft.material,
        ukSize: draft.uk_size, sku: draft.sku,
        generatedTitle: draft.generated_title ?? "", generatedDescription: draft.generated_description ?? "",
        condition: draft.condition,
        vintedAudience: audience,
        vintedCategoryId: draft.vinted_category_id, vintedCategoryValid: isPublishableVintedCategory(category), vintedCategoryStatus: draft.vinted_category_status,
        hasPhoto: draftImages.length > 0,
        sellingPricePence: draft.confirmed_price_pence,
      };
      const warnings = buildListingWarnings(readinessFields);
      if (warnings.length > 0) { rejected.push({ draftId: id, sku: draft.sku, reasons: warnings }); continue; }
      if (draftImages.length > MAX_EXPORT_PHOTOS_PER_LISTING) {
        rejected.push({ draftId: id, sku: draft.sku, reasons: [`Too many photos (${draftImages.length}) — at most ${MAX_EXPORT_PHOTOS_PER_LISTING} per listing are supported.`] });
      }
    }

    if (rejected.length > 0) {
      return NextResponse.json({ error: "One or more selected listings are not ready to export.", rejected }, { status: 400 });
    }

    // Total ORIGINAL photo bytes, checked before downloading anything —
    // fails fast/cheaply rather than starting a large download run only to
    // risk exhausting memory partway through.
    const totalBytes = foundIds.reduce((sum, id) => sum + (imagesByDraftId.get(id) ?? []).reduce((s, img) => s + img.file_size, 0), 0);
    if (totalBytes > MAX_EXPORT_TOTAL_BYTES) {
      return NextResponse.json({
        error: `This export is too large (${Math.round(totalBytes / (1024 * 1024))}MB, limit ${Math.round(MAX_EXPORT_TOTAL_BYTES / (1024 * 1024))}MB). Select fewer listings and try again.`,
      }, { status: 400 });
    }

    // --- Build the export payload for every accepted listing. ---
    const exportId = randomUUID();
    const createdAt = new Date().toISOString();
    const rootFolder = buildExportRootFolderName(createdAt);
    const zipEntries: { path: string; bytes: Buffer }[] = [];
    const exportedListings: ExportedListing[] = [];

    for (let index = 0; index < foundIds.length; index++) {
      const draftId = foundIds[index];
      const draft = draftsById.get(draftId)!;
      const draftImages = imagesByDraftId.get(draftId) ?? [];
      const folderName = buildProductFolderName(index, draft.sku, draftId);

      let prepared;
      try {
        prepared = await prepareExportPhotos(
          draftImages.map((img): ExportPhotoInput => ({ imageId: img.id, storagePath: img.storage_path, mimeType: img.mime_type, fileSize: img.file_size })),
          LISTING_STUDIO_BUCKET,
        );
      } catch (error) {
        if (error instanceof ExportPhotoError) {
          return NextResponse.json({ error: `Could not prepare photos for ${draft.sku ?? draftId}: ${error.message}` }, { status: 502 });
        }
        throw error;
      }

      const photoFiles = prepared.map(p => `photos/${p.fileName}`);
      const purchaseMatch = matchSkuToPurchase(draft.sku, purchaseIndex);
      const purchasePricePence = purchaseMatch.status === "matched" ? purchaseMatch.purchasePricePence : null;
      const category = categoriesById.get(draft.vinted_category_id!)!;
      const itemFamily = deriveDraftItemFamily(draft.product_type);
      const audience = normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily);

      const listingEntry = validateExportedListing({
        schemaVersion: EXPORT_SCHEMA_VERSION,
        draftId,
        sku: draft.sku,
        title: draft.generated_title!,
        description: draft.generated_description!,
        brand: draft.brand!,
        model: draft.model,
        productType: draft.product_type!,
        condition: draft.condition!,
        ukSize: draft.uk_size,
        audience: audience!,
        colours: draft.colours ?? [],
        materials: draft.material ? [draft.material] : [],
        pricePence: draft.confirmed_price_pence!,
        priceDisplay: formatPenceAsGBP(draft.confirmed_price_pence),
        purchasePricePence,
        purchasePriceDisplay: purchasePricePence !== null ? formatPenceAsGBP(purchasePricePence) : null,
        vintedCategoryId: draft.vinted_category_id!,
        vintedCategoryPath: category.full_path,
        photoFiles,
      });
      exportedListings.push(listingEntry);

      zipEntries.push({ path: `${rootFolder}/products/${folderName}/listing.json`, bytes: Buffer.from(JSON.stringify(listingEntry, null, 2)) });
      for (const photo of prepared) zipEntries.push({ path: `${rootFolder}/products/${folderName}/photos/${photo.fileName}`, bytes: photo.bytes });
    }

    const manifest = buildExportManifest(exportId, createdAt, exportedListings);
    zipEntries.push({ path: `${rootFolder}/manifest.json`, bytes: Buffer.from(JSON.stringify(manifest, null, 2)) });
    zipEntries.push({ path: `${rootFolder}/README.txt`, bytes: Buffer.from(buildExportReadmeText(exportedListings.length)) });

    const zipBuffer = await buildZipBuffer(zipEntries);

    // Recorded ONLY after the ZIP was fully, successfully generated — this
    // marks "an export package was generated for this listing", never
    // "a Vinted draft was created" (vinted_draft_created_at is untouched
    // here, and always will be by this route — that is a separate,
    // future, real-Vinted-interaction milestone). Best-effort: a failure
    // to record this never fails the download the user is already
    // receiving.
    await Promise.all(foundIds.map(id => supabaseRequest(`listing_drafts?id=eq.${id}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ vinted_exported_at: createdAt, vinted_export_id: exportId }),
    }).catch(() => {})));

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${rootFolder}.zip"`,
      },
    });
  } catch (error) { return safeApiError(error, "Could not export these listings."); }
}
