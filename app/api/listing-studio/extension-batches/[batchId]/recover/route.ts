import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { classifyBatchForRecovery } from "@/lib/listing-studio/extension-batch-recovery";

export const runtime = "nodejs";

const recoverRequestSchema = z.object({
  force: z.boolean().optional(),
}).strict();

type BatchRow = {
  id: string; status: string; display_number: number; expires_at: string;
  box_dismissed_at: string | null; last_extension_activity_at: string | null;
};

function rpcErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  for (const code of ["BATCH_NOT_FOUND", "BATCH_STILL_ACTIVE"]) {
    if (error.message.includes(code)) return code;
  }
  return null;
}

/**
 * Owner-scoped fetch of the batch's own current, safely-shareable info —
 * used both to enrich a BATCH_STILL_ACTIVE refusal (so the dialog can show
 * "last activity 2 minutes ago" without a second round trip) and is
 * naturally scoped so a batch belonging to a different owner is
 * indistinguishable from one that doesn't exist at all.
 */
async function loadOwnedBatchSummary(ownerId: string, batchId: string) {
  const batches = await supabaseRequestAll<BatchRow>(
    `vinted_extension_batches?id=eq.${batchId}&owner_id=eq.${ownerId}`
    + `&select=id,status,display_number,expires_at,box_dismissed_at,last_extension_activity_at`,
  );
  return batches[0] ?? null;
}

/**
 * Follow-up correction (orphaned extension batch recovery) — the ONE
 * repair path for a batch that's genuinely stuck: locks and re-reads the
 * batch/items, verifies ownership, refuses ordinary recovery for a batch
 * still proven genuinely active (unless `force` is explicitly set — only
 * ever sent after the owner has already been shown that exact refusal and
 * deliberately confirmed again), then cancels the batch and every
 * unfinished item — all inside rpc/listing_studio_recover_stuck_extension_batch
 * (see supabase-listing-studio.sql for the full atomicity/safety writeup).
 * A completed item with a confirmed Vinted draft id is never touched,
 * regardless of `force`. Idempotent: recovering an already-recovered (or
 * otherwise already-terminal-with-nothing-left) batch is a safe no-op,
 * never an error — see the RPC's own `was_noop` result field.
 */
export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    const { force } = recoverRequestSchema.parse(await request.json().catch(() => ({})));

    let result: { released_item_count: number; preserved_completed_count: number; batch_status: string; was_noop: boolean };
    try {
      const rpcResponse = await supabaseRequest("rpc/listing_studio_recover_stuck_extension_batch", {
        method: "POST",
        body: JSON.stringify({ p_owner_id: user.id, p_batch_id: batchId, p_force: Boolean(force) }),
      });
      const [row] = await rpcResponse.json() as typeof result[];
      result = row;
    } catch (error) {
      const code = rpcErrorCode(error);
      if (code === "BATCH_NOT_FOUND") return NextResponse.json({ error: "Batch not found." }, { status: 404 });
      if (code === "BATCH_STILL_ACTIVE") {
        const summary = await loadOwnedBatchSummary(user.id, batchId);
        // Ownership/existence was already proven by the RPC's own
        // owner-scoped lookup raising this exact exception — a missing
        // summary here would only mean a same-transaction race, never a
        // different owner's batch, so this still never leaks anything.
        const classification = summary ? classifyBatchForRecovery({
          status: summary.status, expiresAt: summary.expires_at,
          lastExtensionActivityAt: summary.last_extension_activity_at, boxDismissedAt: summary.box_dismissed_at,
        }, Date.now()) : null;
        return NextResponse.json({
          error: "This batch still shows genuine, recent extension activity — it may still be running. Confirm again to recover it anyway.",
          stillActive: true,
          batch: summary ? {
            batchId: summary.id, displayNumber: summary.display_number, status: summary.status,
            expiresAt: summary.expires_at, boxDismissedAt: summary.box_dismissed_at,
            lastExtensionActivityAt: summary.last_extension_activity_at,
            isHidden: classification?.isHidden ?? false,
          } : null,
        }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({
      batchId, releasedCount: result.released_item_count, preservedCompletedCount: result.preserved_completed_count,
      batchStatus: result.batch_status, wasNoop: result.was_noop,
    });
  } catch (error) { return safeApiError(error, "Could not recover this batch."); }
}
