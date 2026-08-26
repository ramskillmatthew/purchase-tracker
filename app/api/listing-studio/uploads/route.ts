import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uploadSessionRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { buildDraftImageStoragePath, LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { createSignedUploadUrl, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";
import { MAX_BATCH_SIZE_BYTES, MAX_FILES_PER_SELECTION, MAX_GROUPS_IN_WORKSPACE, MAX_INDIVIDUAL_FILE_SIZE_BYTES, MAX_TOTAL_ACTIVE_UPLOAD_FILES } from "@/lib/listing-studio/upload-limits";

export const runtime = "nodejs";
export const maxDuration = 30;

// Every freshly uploaded batch with no explicit target group lands in one
// shared "Unsorted" inbox group per owner (Milestone 2 spec §8) — never
// inferred product boundaries, just a predictable, always-there catch-all
// the user divides manually. Looked up by title/status rather than a
// dedicated flag column: if the user renames it, a later upload simply
// creates a fresh Unsorted group instead of silently landing somewhere
// unexpected — never destructive, always recoverable.
const UNSORTED_TITLE = "Unsorted";

type Row = { id: string };

// Machine-readable failure reasons the client (GroupingWorkspace.tsx via
// lib/listing-studio/upload-error-messages.ts) uses to decide whether a
// chunk-registration failure is systemic (stop registering further chunks,
// show one clear global explanation) or scoped to just this chunk (mark
// only these files failed, keep going) — see that module's own top comment
// for the full classification. Every branch below that can fail returns one
// of these alongside its human-readable `error` message; nothing here
// changes an existing check's logic, only how it's reported.
type UploadFailureReason = "too_many_files" | "file_too_large" | "batch_too_large" | "workspace_capacity_exceeded" | "group_limit_exceeded" | "storage_unavailable";

function failure(status: number, reason: UploadFailureReason, error: string) {
  return NextResponse.json({ error, reason }, { status });
}

/**
 * Creates (or reuses) a product group and registers N images against it —
 * server-generated ids and Storage paths, a signed upload URL per image,
 * and nothing else. The browser never receives anything but
 * {imageId, uploadUrl, storagePath}; the actual file bytes never pass
 * through this route (Milestone 2 spec §3: "Do not send full-resolution
 * image bytes through Vercel API routes" — the browser PUTs directly to
 * Storage using the returned signed URL).
 */
export async function POST(request: Request) {
  let cleanupNewlyCreatedDraftId: string | null = null;
  try {
    const user = await requireOwner();
    const rawBody = await request.json().catch(() => ({}));

    // Defensive only — the browser now always chunks a large selection into
    // requests of at most MAX_FILES_PER_SELECTION files each (see
    // lib/listing-studio/upload-chunk-planner.ts), so a real client should
    // never hit this. Checked BEFORE the strict zod parse below purely so
    // this one specific, well-understood failure mode gets a clear,
    // structured reason instead of falling through to zod's generic
    // "Invalid request." — this is the exact failure this whole fix exists
    // to eliminate for genuine users; keeping it caught here too means even
    // a misbehaving future caller gets a useful answer, not a mystery.
    if (Array.isArray((rawBody as { files?: unknown })?.files) && (rawBody as { files: unknown[] }).files.length > MAX_FILES_PER_SELECTION) {
      return failure(400, "too_many_files", `A single upload request can register at most ${MAX_FILES_PER_SELECTION} files. Please try again — large selections are chunked automatically.`);
    }

    const { draftId, files } = uploadSessionRequestSchema.parse(rawBody);

    for (const file of files) {
      if (file.fileSize > MAX_INDIVIDUAL_FILE_SIZE_BYTES) {
        return failure(400, "file_too_large", `${file.filename} exceeds the ${Math.round(MAX_INDIVIDUAL_FILE_SIZE_BYTES / (1024 * 1024))}MB file limit.`);
      }
    }
    const totalBytes = files.reduce((sum, file) => sum + file.fileSize, 0);
    if (totalBytes > MAX_BATCH_SIZE_BYTES) {
      return failure(400, "batch_too_large", `This group exceeds the ${Math.round(MAX_BATCH_SIZE_BYTES / (1024 * 1024))}MB batch limit.`);
    }

    const activeImages = await supabaseRequestAll<Row>(`listing_draft_images?owner_id=eq.${user.id}&select=id`);
    if (activeImages.length + files.length > MAX_TOTAL_ACTIVE_UPLOAD_FILES) {
      const remaining = Math.max(0, MAX_TOTAL_ACTIVE_UPLOAD_FILES - activeImages.length);
      return failure(400, "workspace_capacity_exceeded", `Only ${remaining} more photo${remaining === 1 ? "" : "s"} can be added because this workspace allows ${MAX_TOTAL_ACTIVE_UPLOAD_FILES} active photos.`);
    }

    let targetDraftId = draftId ?? null;
    if (targetDraftId) {
      const existing = await (await supabaseRequest(`listing_drafts?id=eq.${targetDraftId}&owner_id=eq.${user.id}&select=id`)).json() as Row[];
      if (!existing.length) return NextResponse.json({ error: "Group not found." }, { status: 404 });
    } else {
      const unsorted = await (await supabaseRequest(
        `listing_drafts?owner_id=eq.${user.id}&title=eq.${encodeURIComponent(UNSORTED_TITLE)}&status=in.(uploading,grouping)&select=id&order=created_at.desc&limit=1`,
      )).json() as Row[];
      if (unsorted.length) {
        targetDraftId = unsorted[0].id;
      } else {
        const groupCount = await supabaseRequestAll<Row>(`listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id`);
        if (groupCount.length >= MAX_GROUPS_IN_WORKSPACE) {
          return failure(400, "group_limit_exceeded", `This workspace already has ${groupCount.length} groups. The maximum is ${MAX_GROUPS_IN_WORKSPACE}.`);
        }
        const created = await (await supabaseRequest("listing_drafts", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ owner_id: user.id, title: UNSORTED_TITLE, status: "uploading" }),
        })).json() as Row[];
        targetDraftId = created[0].id;
        // Tracked so a total failure below can clean this empty group back
        // up — never leave debris the user never asked for (a group they
        // already had before this request is left untouched either way).
        cleanupNewlyCreatedDraftId = targetDraftId;
        // Best-effort audit entry — a missed history row is never worth
        // failing the actual upload over.
        await supabaseRequest("listing_status_history", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ draft_id: targetDraftId, owner_id: user.id, previous_status: null, new_status: "uploading", reason: "workspace inbox created" }),
        }).catch(() => {});
      }
    }

    // A bounded top-1 existence-style lookup — never supabaseRequestAll,
    // whose own Range-based pagination conflicts with an explicit `limit=`
    // once a group has more than one existing photo (see supabaseRequestAll's
    // doc comment in lib/supabase.ts — this exact combination previously
    // caused a live PGRST103 failure on every upload to a non-empty group).
    const existingSortOrders = await (await supabaseRequest(
      `listing_draft_images?draft_id=eq.${targetDraftId}&owner_id=eq.${user.id}&select=sort_order&order=sort_order.desc&limit=1`,
    )).json() as { sort_order: number }[];
    const baseSortOrder = (existingSortOrders[0]?.sort_order ?? -1) + 1;
    const finalDraftId = targetDraftId;

    // Every signed URL is minted FIRST, in parallel, before anything is
    // written to the database. If any single file fails here, nothing has
    // been inserted yet — there is no partial batch to clean up. (This
    // replaces an earlier version that inserted each row inside the same
    // per-file step as its signed-URL mint, which could leave orphaned
    // "pending" rows the client never learned the ids of if a later file
    // in the same batch failed.)
    const prepared = files.map(file => {
      const imageId = crypto.randomUUID();
      return { file, imageId, storagePath: buildDraftImageStoragePath(user.id, finalDraftId, imageId, file.filename) };
    });
    const signed = await Promise.all(prepared.map(async entry => ({
      ...entry,
      uploadUrl: (await createSignedUploadUrl(LISTING_STUDIO_BUCKET, entry.storagePath)).uploadUrl,
    })));

    // One atomic multi-row insert — a single SQL statement Postgres either
    // fully commits or fully rejects, never a partial set of rows.
    await supabaseRequest("listing_draft_images", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(signed.map((entry, index) => ({
        id: entry.imageId, draft_id: finalDraftId, owner_id: user.id, storage_path: entry.storagePath,
        original_filename: entry.file.filename, mime_type: entry.file.mimeType, file_size: entry.file.fileSize,
        sort_order: baseSortOrder + index, upload_state: "pending",
      }))),
    });

    const images = signed.map(entry => ({ imageId: entry.imageId, uploadUrl: entry.uploadUrl, storagePath: entry.storagePath }));
    return NextResponse.json({ draftId: finalDraftId, images }, { status: 201 });
  } catch (error) {
    if (cleanupNewlyCreatedDraftId) {
      await supabaseRequest(`listing_drafts?id=eq.${cleanupNewlyCreatedDraftId}`, { method: "DELETE" }).catch(() => {});
    }
    if (error instanceof StorageBucketMissingError) return failure(503, "storage_unavailable", error.message);
    return safeApiError(error, "Could not start the upload. Please try again.");
  }
}
