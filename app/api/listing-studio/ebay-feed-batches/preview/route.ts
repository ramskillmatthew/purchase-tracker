import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { buildFeedDraftPreviewForProduct } from "@/lib/listing-studio/ebay-feed/feed-batches";
import { TEMPLATE_VERSION, ONLY_ALLOWED_ACTION } from "@/lib/listing-studio/ebay-feed/template-contract";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_PREVIEW_LISTINGS = 25;
// Corrective pass — `.min(1)` alone already rejected a genuinely empty
// array before this incident; kept, and now also mirrored server-side at
// every LATER stage (batch creation, CSV generation, upload) so no single
// layer is ever the only thing standing between a client and a zero-row
// submission — see feed-batches.ts's own createEbayFeedBatch and
// csv-generator.ts's own generateFeedDraftCsv for the matching guards.
const requestSchema = z.object({ draftIds: z.array(uuidSchema).min(1, "Select at least one listing.").max(MAX_PREVIEW_LISTINGS) }).strict();

/**
 * The pre-submission preview the confirmation dialog shows before any real
 * batch is created. Server-authoritative: every count the dialog displays
 * (`eligibleCount`, the button's own row count) comes from THIS response,
 * never from the client's own earlier selection — see
 * lib/listing-studio/ebay-feed/feed-batches.ts's own buildFeedDraftPreviewForProduct,
 * which never throws (a single listing's failure can never blank out every
 * other listing's own valid preview — the corrective-pass bug this route
 * used to have). Read-only: never creates a task, never uploads anything,
 * never touches eBay at all.
 *
 * Returns one entry for EVERY requested id — either a real preview row or
 * a precise blocking reason — never silently drops one.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request.", requestedCount: 0, eligibleCount: 0, ineligibleCount: 0, rows: [], blockers: [] }, { status: 400 });
    }
    const uniqueDraftIds = [...new Set(parsed.data.draftIds)];

    const results = await Promise.all(uniqueDraftIds.map(draftId => buildFeedDraftPreviewForProduct(user.id, draftId)));

    const rows = results.filter(r => r.ok).map(r => r.row);
    const blockers = uniqueDraftIds
      .map((draftId, index) => ({ draftId, result: results[index] }))
      .filter(({ result }) => !result.ok)
      .map(({ draftId, result }) => ({ draftId, reason: (result as { ok: false; reason: string }).reason }));

    return NextResponse.json({
      requestedCount: uniqueDraftIds.length,
      eligibleCount: rows.length,
      ineligibleCount: blockers.length,
      templateVersion: TEMPLATE_VERSION,
      marketplace: "EBAY_UK",
      action: ONLY_ALLOWED_ACTION,
      rows,
      blockers,
    });
  } catch (error) { return safeApiError(error, "Could not build a preview for these listings."); }
}
