import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { LISTING_STUDIO_BUCKET, parseDraftImageStoragePath } from "@/lib/listing-studio/storage-paths";
import { deleteStorageObjects } from "@/lib/listing-studio/storage-rest";

export const runtime = "nodejs";
export const maxDuration = 30;

type DraftRow = {
  id: string; title: string | null; status: string; created_at: string; updated_at: string;
  // Milestone 4 (AI listing generation) — brand/model/sku are reused
  // Stage 1 columns; product_type/uk_size/generated_title/
  // generated_description are new. `title` above remains this group's own
  // editable display name — unrelated to `generated_title`.
  // Milestone 6 (Vinted-aware colours/materials): `colour` (free text) is
  // superseded by `colours` (up to 2 exact Vinted enum values) and
  // `material` (a single exact Vinted enum value or null).
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null; generated_title: string | null; generated_description: string | null;
  // Milestone 7 (Vinted category catalogue sync).
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
  vinted_category_status: string | null;
  // Follow-up correction (2026-08-04).
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
};
type ImageRow = {
  id: string; draft_id: string; original_filename: string; mime_type: string; file_size: number;
  width: number | null; height: number | null; sort_order: number;
  detected_role: string | null; confirmed_role: string | null; upload_state: string; preview_available: boolean;
};

/**
 * Fetches everything the Create view needs to render: every non-archived
 * group and every image in them, ordered for direct rendering (groups by
 * creation order, images by their persisted sort_order — never inferred
 * from anything else). Deliberately never selects the underlying Storage
 * key column — the client only ever needs /api/listing-studio/images/{id}
 * /view for display.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const [drafts, images] = await Promise.all([
      supabaseRequestAll<DraftRow>(
        `listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id,title,status,created_at,updated_at,brand,model,product_type,colours,material,uk_size,sku,generated_title,generated_description,vinted_category_id,vinted_category_path,vinted_category_source,vinted_category_status,vinted_audience&order=created_at.asc`,
      ),
      supabaseRequestAll<ImageRow>(
        `listing_draft_images?owner_id=eq.${user.id}&select=id,draft_id,original_filename,mime_type,file_size,width,height,sort_order,detected_role,confirmed_role,upload_state,preview_available&order=sort_order.asc`,
      ),
    ]);
    return NextResponse.json({ drafts, images });
  } catch (error) { return safeApiError(error); }
}

/**
 * "Clear all" — deletes every Listing Studio photo and product group (Unsorted
 * included) this owner has, in one deliberate action. Deliberately the
 * REVERSE order from a single-group delete (listing_studio_delete_group,
 * used by DELETE /api/listing-studio/groups/[draftId]): that route deletes
 * the database rows first and only then best-effort cleans up Storage,
 * because losing track of one photo's Storage object among thousands is a
 * bounded, minor cleanup debt. Here, potentially hundreds of Storage
 * objects are at stake, so this route resolves every owner-owned image's
 * Storage path FIRST, deletes those Storage objects, and ONLY once that
 * fully succeeds does it call the transactional database-clearing RPC —
 * so a Storage failure leaves every database row exactly as it was
 * (nothing deleted, nothing orphaned), and a retry simply re-resolves the
 * same still-present rows and tries again. Storage's own delete-by-prefix
 * is a no-op (not an error) for a path that's already gone, so re-running
 * this after a database-stage failure (Storage already deleted, database
 * delete failed) is equally safe — it just repeats a harmless no-op
 * Storage pass and retries the database delete.
 *
 * No new cross-request locking is added here — the client disables the
 * "Clear all" action while an upload or auto-group run is in flight (see
 * GroupingWorkspace.tsx), which covers the realistic case. A genuine
 * concurrent request from a second tab is not specially guarded against;
 * the worst case is benign (a photo uploaded in the small window between
 * this route's own resolve-images query and its Storage delete either
 * survives this run, or has its now-orphaned-but-not-yet-uploaded database
 * row removed a moment before its own upload would have completed) — never
 * cross-owner, never silently corrupting, never a reason to build a new
 * locking mechanism this codebase has nowhere else.
 */
export async function DELETE() {
  try {
    const user = await requireOwner();

    const images = await supabaseRequestAll<{ id: string; storage_path: string }>(
      `listing_draft_images?owner_id=eq.${user.id}&select=id,storage_path&order=id.asc`,
    );

    // Every path here comes from this owner's own database rows — never
    // from the client — but is still independently re-validated against
    // the expected owner-scoped shape before being handed to Storage,
    // exactly like every other path this feature ever deletes.
    const warnings: string[] = [];
    const validPaths: string[] = [];
    for (const image of images) {
      const parsed = parseDraftImageStoragePath(image.storage_path);
      if (!parsed || parsed.ownerId !== user.id) {
        warnings.push(`Skipped an image with an unexpected storage path (image id ${image.id}).`);
        continue;
      }
      validPaths.push(image.storage_path);
    }
    const uniquePaths = [...new Set(validPaths)];

    if (uniquePaths.length > 0) {
      try {
        await deleteStorageObjects(LISTING_STUDIO_BUCKET, uniquePaths);
      } catch {
        return NextResponse.json({
          error: "Could not clear photos from storage. Nothing was deleted — please try again.",
          stage: "storage",
        }, { status: 502 });
      }
    }

    let counts: { deleted_image_count: number; deleted_group_count: number; deleted_analysis_run_count: number; deleted_status_history_count: number };
    try {
      const response = await supabaseRequest("rpc/listing_studio_clear_workspace", {
        method: "POST",
        body: JSON.stringify({ p_owner_id: user.id }),
      });
      const rows = await response.json() as (typeof counts)[];
      counts = rows[0] ?? { deleted_image_count: 0, deleted_group_count: 0, deleted_analysis_run_count: 0, deleted_status_history_count: 0 };
    } catch {
      // Storage objects are already gone at this point — a retry is still
      // safe (see this function's own doc comment), but this specific
      // failure means real photos were removed from Storage while their
      // database rows remain, so the message is deliberately distinct from
      // the "nothing was deleted" storage-stage failure above.
      return NextResponse.json({
        error: "Photos were removed from storage, but clearing the remaining records failed. Please try again to finish.",
        stage: "database",
      }, { status: 502 });
    }

    return NextResponse.json({
      deletedImageCount: counts.deleted_image_count,
      deletedGroupCount: counts.deleted_group_count,
      // Same underlying listing_drafts table as deletedGroupCount — this
      // schema has no separate "draft" table distinct from a product
      // group, so there is nothing additional a deletedDraftCount could
      // ever count beyond what deletedGroupCount already reports.
      deletedDraftCount: counts.deleted_group_count,
      deletedStorageObjectCount: uniquePaths.length,
      warnings,
    });
  } catch (error) { return safeApiError(error, "Could not clear the workspace."); }
}
