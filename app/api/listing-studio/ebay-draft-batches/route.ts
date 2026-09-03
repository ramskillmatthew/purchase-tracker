import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { createEbayDraftBatch, listOwnerEbayBatches, runEbayDraftBatchProcessTick, resolveEbayDraftEligibilityForProducts } from "@/lib/listing-studio/ebay-draft-batches";
import { enforceRateLimit } from "@/lib/security/activity";
import { isMissingSchemaError } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_EBAY_BATCH_LISTINGS = 25;
const RATE_LIMIT_MAX_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/**
 * Stage 6 (eBay draft batches) — the eBay equivalent of
 * app/api/listing-studio/extension-batches/route.ts. GET resumes every
 * batch this owner's session should still be tracking (mirrors that
 * route's own `batchIds`), plus every batch that looks genuinely stuck
 * (`stuck` — no browser-extension pairing exists for eBay, so "stuck"
 * here means "created a while ago and never reached a terminal status",
 * not "no longer paired").
 *
 * POST is deliberately NOT all-or-nothing like the Vinted route — the
 * product spec explicitly wants ineligible selections skipped and
 * reported, never silently included, while whatever IS eligible still
 * proceeds (mirrors handleBulkAssignCategories' own "skip and report"
 * convention elsewhere in this codebase, not Send to extension's
 * all-or-nothing one). Eligibility is re-verified fresh here — the
 * client's own precomputed count is never trusted for the actual create
 * call.
 *
 * Corrective pass — no longer kicks off an unawaited background promise.
 * Batch/item rows are created (status 'queued'), then ONE bounded process
 * tick is run and AWAITED before responding, so the response already
 * reflects genuine initial progress; every further tick is driven by the
 * client's own poll loop (POST .../[batchId]/process) while the page is
 * open, or by the cron sweep once deployed (see
 * app/api/cron/ebay-draft-processing/route.ts) — never by this route
 * continuing to do work after it has already returned.
 */
/**
 * CORRECTIVE PASS — before this fix, a missing `ebay_draft_batches` table
 * (supabase-ebay-draft-batches.sql not yet applied) made this handler
 * throw straight into safeApiError's generic 500 path — an uncontrolled
 * fault, not a deliberate response, even though "the batch migration isn't
 * applied yet" is an entirely expected, recoverable state this route
 * should describe on purpose. `available: false` is that deliberate
 * signal: batch creation/processing/dismissal genuinely cannot work yet,
 * but that must never be confused with "something is broken" — the eBay
 * per-item editor (title/description/category/price/policies) has no
 * dependency on this table at all and keeps working regardless (see
 * lib/listing-studio/marketplace-drafts.ts's own corrective-pass fix).
 * `batchIds`/`stuck` are simply empty in that case, matching what an
 * owner with zero real batches would also see — the client already
 * treats both the same way, but now the UI can also say WHY instead of
 * staying silent. Any OTHER failure (auth, network, a genuine fault) is
 * still a real error and still goes through safeApiError.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const { visible, stuck } = await listOwnerEbayBatches(user.id);
    return NextResponse.json({
      available: true,
      batchIds: visible.map(b => ({ batchId: b.batchId, displayNumber: b.displayNumber })),
      stuck: stuck.map(b => ({ batchId: b.batchId, displayNumber: b.displayNumber, status: b.status, listingCount: b.listingCount, createdAt: b.createdAt })),
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ available: false, batchIds: [], stuck: [] });
    }
    return safeApiError(error, "Could not check for active eBay draft batches.");
  }
}

const createRequestSchema = z.object({ draftIds: z.array(uuidSchema).min(1).max(MAX_EBAY_BATCH_LISTINGS) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds } = createRequestSchema.parse(await request.json());
    await enforceRateLimit(user.id, "ebay_draft_batch_create", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const uniqueDraftIds = [...new Set(draftIds)];
    const eligibility = await resolveEbayDraftEligibilityForProducts(user.id, uniqueDraftIds);

    const eligibleProductIds: string[] = [];
    const eligibleMarketplaceDraftIds: string[] = [];
    const skipped: Array<{ draftId: string; reasons: string[] }> = [];
    for (const draftId of uniqueDraftIds) {
      const entry = eligibility.get(draftId);
      if (entry?.eligible && entry.marketplaceDraftId) {
        eligibleProductIds.push(draftId);
        eligibleMarketplaceDraftIds.push(entry.marketplaceDraftId);
      } else {
        skipped.push({ draftId, reasons: entry?.reasons ?? ["Not eligible"] });
      }
    }

    if (eligibleProductIds.length === 0) {
      return NextResponse.json({ error: "None of the selected listings are eligible for an eBay draft right now.", eligibleCount: 0, skipped }, { status: 400 });
    }

    const { batchId, displayNumber } = await createEbayDraftBatch(user.id, eligibleMarketplaceDraftIds, eligibleProductIds);
    // ONE bounded, awaited tick — never a loop to completion. Its own
    // failure must never fail batch CREATION, which already succeeded;
    // the client's poll loop (or a future cron tick) simply continues
    // from persisted state on the next tick regardless.
    await runEbayDraftBatchProcessTick(user.id, batchId).catch(() => {});

    return NextResponse.json({ batchId, displayNumber, eligibleCount: eligibleProductIds.length, skippedCount: skipped.length, skipped });
  } catch (error) {
    // Corrective pass — creating a batch genuinely requires
    // ebay_draft_batches/ebay_draft_batch_items to exist (unlike GET
    // above, there is no meaningful "available: false" success response
    // here — the whole point of this call is to write a row into a table
    // that isn't there yet). Still a deliberate, clearly-worded 409, never
    // the generic 500 safeApiError would otherwise produce.
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ error: "Batch eBay drafting isn't enabled on this database yet — the required migration hasn't been applied.", available: false }, { status: 409 });
    }
    return safeApiError(error, "Could not create an eBay draft batch.");
  }
}
