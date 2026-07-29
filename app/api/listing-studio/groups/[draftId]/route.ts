import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { deleteGroupRequestSchema, updateGroupRequestSchema, uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { deleteStorageObject } from "@/lib/listing-studio/storage-rest";
import { classifyListingStudioRpcError } from "@/lib/listing-studio/rpc-errors";

export const runtime = "nodejs";

/** Renames a group. A group's name is stored in the same `title` column the AI pipeline will later populate/confirm (Milestone 3+) — this is just the temporary, user-editable working name for now. */
export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const { title } = updateGroupRequestSchema.parse(await request.json());

    const existing = await supabaseRequestAll<{ id: string }>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id`);
    if (!existing.length) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ title, updated_at: new Date().toISOString() }),
    });

    return NextResponse.json({ ok: true });
  } catch (error) { return safeApiError(error, "Could not rename the group."); }
}

/**
 * Deletes a group. An empty group needs no body/mode at all. A non-empty
 * group requires an explicit `mode` — `move_to_unsorted` (safe default:
 * every photo is moved into the owner's Unsorted inbox group first) or
 * `delete_photos` (destructive: the photos are permanently deleted too).
 * Both are performed atomically by rpc/listing_studio_delete_group (see
 * supabase-listing-studio.sql) so a partial move/delete can never happen.
 * For `delete_photos`, the RPC returns exactly which Storage objects it
 * removed database rows for, and this route deletes those objects from
 * Storage afterward — Postgres itself has no access to Storage, so this
 * is the one part of the cleanup that can't live inside the transaction;
 * a failure here is logged, never left to silently orphan the DB rows
 * (which are already gone) or fail the whole request.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const rawBody = await request.json().catch(() => ({}));
    const { mode } = deleteGroupRequestSchema.parse(rawBody);

    const existing = await supabaseRequestAll<{ id: string }>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id`);
    if (!existing.length) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    const images = await supabaseRequestAll<{ id: string }>(`listing_draft_images?draft_id=eq.${draftId}&owner_id=eq.${user.id}&select=id`);
    if (images.length > 0 && !mode) {
      return NextResponse.json({ error: "This group still has photos. Choose whether to move them to Unsorted or delete them." }, { status: 409 });
    }

    const response = await supabaseRequest("rpc/listing_studio_delete_group", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: user.id, p_draft_id: draftId, p_mode: mode ?? "delete_photos" }),
    });
    const rows = await response.json() as { deleted_storage_paths: string[] | null }[];
    const storagePaths = rows[0]?.deleted_storage_paths ?? [];

    if (storagePaths.length) {
      await Promise.all(storagePaths.map(path => deleteStorageObject(LISTING_STUDIO_BUCKET, path).catch(error => {
        console.error("Could not delete listing-studio Storage object during group deletion", path, error instanceof Error ? error.message : error);
      })));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const known = classifyListingStudioRpcError(error);
    if (known) return NextResponse.json({ error: known }, { status: 409 });
    return safeApiError(error, "Could not delete the group.");
  }
}
