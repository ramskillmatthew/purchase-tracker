import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

type BatchRow = {
  id: string; status: string; listing_count: number;
  created_at: string; claimed_at: string | null; expires_at: string; completed_at: string | null;
  extension_id: string | null; extension_version: string | null;
};
type ItemRow = {
  id: string; draft_id: string; queue_position: number; status: string; attempt_count: number;
  error_code: string | null; error_message: string | null; vinted_draft_id: string | null;
  started_at: string | null; completed_at: string | null;
  current_step: string | null; step_detail: string | null;
};
type DraftTitleRow = { id: string; generated_title: string | null; sku: string | null };

/**
 * Milestone 7 (Chrome extension draft queue) — the OWNER-side polling
 * endpoint Listings Review uses to show live batch/queue progress. This is
 * a completely separate access path from /api/extension/* (which the
 * extension itself calls using its own restricted batch token, never an
 * owner session) — this route uses requireOwner() and is scoped to
 * batches this owner created, exactly like every other listing-studio
 * route.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

    const batches = await supabaseRequestAll<BatchRow>(
      `vinted_extension_batches?id=eq.${batchId}&owner_id=eq.${user.id}`
      + `&select=id,status,listing_count,created_at,claimed_at,expires_at,completed_at,extension_id,extension_version`,
    );
    const batch = batches[0];
    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });

    // current_step/step_detail only exist once the migration in
    // supabase-listing-studio.sql has been run — until then, fall back to
    // the same query without those two columns (reported as null) rather
    // than failing this whole poll with a confusing schema-cache error.
    const items = await supabaseRequestAll<ItemRow>(
      `vinted_extension_batch_items?batch_id=eq.${batchId}`
      + `&select=id,draft_id,queue_position,status,attempt_count,error_code,error_message,vinted_draft_id,started_at,completed_at,current_step,step_detail`
      + `&order=queue_position.asc`,
    ).catch(async error => {
      if (error instanceof Error && "status" in error && (error as Error & { status: number }).status === 400 && /column .* does not exist|schema cache/i.test(error.message)) {
        const fallback = await supabaseRequestAll<Omit<ItemRow, "current_step" | "step_detail">>(
          `vinted_extension_batch_items?batch_id=eq.${batchId}`
          + `&select=id,draft_id,queue_position,status,attempt_count,error_code,error_message,vinted_draft_id,started_at,completed_at`
          + `&order=queue_position.asc`,
        );
        return fallback.map(item => ({ ...item, current_step: null, step_detail: null }));
      }
      throw error;
    });
    const draftIds = items.map(i => i.draft_id);
    const draftTitles = draftIds.length ? await supabaseRequestAll<DraftTitleRow>(
      `listing_drafts?id=in.(${draftIds.join(",")})&owner_id=eq.${user.id}&select=id,generated_title,sku`,
    ) : [];
    const titlesByDraftId = new Map(draftTitles.map(d => [d.id, d]));

    return NextResponse.json({
      batchId: batch.id, status: batch.status, listingCount: batch.listing_count,
      createdAt: batch.created_at, claimedAt: batch.claimed_at, expiresAt: batch.expires_at, completedAt: batch.completed_at,
      extensionId: batch.extension_id, extensionVersion: batch.extension_version,
      items: items.map(item => ({
        itemId: item.id, draftId: item.draft_id, queuePosition: item.queue_position, status: item.status,
        attemptCount: item.attempt_count, errorCode: item.error_code, errorMessage: item.error_message,
        vintedDraftId: item.vinted_draft_id, startedAt: item.started_at, completedAt: item.completed_at,
        currentStep: item.current_step, detail: item.step_detail,
        generatedTitle: titlesByDraftId.get(item.draft_id)?.generated_title ?? null,
        sku: titlesByDraftId.get(item.draft_id)?.sku ?? null,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not load this batch."); }
}

/** Cooperative cancel — the extension checks batch status on its own polling cadence and stops starting new items once it sees "cancelled"; already-in-flight items are unaffected (a mid-save action is never interrupted). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

    const batches = await supabaseRequestAll<{ id: string; status: string }>(
      `vinted_extension_batches?id=eq.${batchId}&owner_id=eq.${user.id}&select=id,status`,
    );
    const batch = batches[0];
    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    if (batch.status === "completed" || batch.status === "cancelled" || batch.status === "expired") {
      return NextResponse.json({ batchId: batch.id, status: batch.status });
    }

    await supabaseRequest(`vinted_extension_batches?id=eq.${batchId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "cancelled", completed_at: new Date().toISOString() }),
    });
    // Only QUEUED items are cancelled here — anything already preparing/
    // filling/saving is left alone; the extension itself is responsible
    // for finishing (or itself failing) an item already in flight, never
    // interrupted mid-action by a server-side status flip.
    await supabaseRequest(`vinted_extension_batch_items?batch_id=eq.${batchId}&status=eq.queued`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "cancelled" }),
    });

    return NextResponse.json({ batchId, status: "cancelled" });
  } catch (error) { return safeApiError(error, "Could not cancel this batch."); }
}
