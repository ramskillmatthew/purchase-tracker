import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { runEbayFeedBatchProcessTick } from "@/lib/listing-studio/ebay-feed/feed-batches";

export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

type ClaimableBatchRow = { id: string; owner_id: string };

/**
 * The Sell Feed API pipeline's own scheduled sweep — mirrors the retired
 * app/api/cron/ebay-draft-processing/route.ts's original shape (before its
 * own Phase 3 retirement), adapted for batch-level (not item-level)
 * ticking. Bounded: rpc/listing_studio_owners_with_claimable_ebay_feed_work
 * returns at most a handful of owner ids (single-tenant app today), and for
 * each owner this finds every non-terminal Feed batch and runs exactly ONE
 * process tick per batch — never a whole batch to completion.
 *
 * DISCLOSED LIMITATION (Phase 6, this pass) — confirmed via Vercel's own
 * current documentation: the Hobby plan's cron minimum cadence is ONCE PER
 * DAY; anything more frequent is rejected at deploy time. vercel.json
 * therefore registers this at a conservative once-daily schedule
 * (30 4 * * *), not a tight polling interval. This means cron is a SAFETY
 * NET for a batch whose creator closed the browser or whose tab crashed —
 * NOT the primary driver of forward progress. The primary driver, exactly
 * like the legacy pipeline's own already-established design, is the
 * client's own open-tab poll loop against
 * POST /api/listing-studio/ebay-feed-batches/[batchId]/process, which ticks
 * every few seconds while Listings Review is open. A batch created and
 * then abandoned (tab closed) before completion may sit for up to ~24
 * hours before this sweep resumes it — a real, disclosed trade-off of
 * targeting a free hosting tier, not a bug.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const ownersResponse = await supabaseRequest("rpc/listing_studio_owners_with_claimable_ebay_feed_work", {
      method: "POST", body: JSON.stringify({ p_limit: 20 }),
    });
    const owners = await ownersResponse.json() as { owner_id: string }[];
    if (!owners.length) return NextResponse.json({ skipped: "no_claimable_work" });

    let batchesTicked = 0;
    for (const { owner_id: ownerId } of owners) {
      const batches = await supabaseRequestAll<ClaimableBatchRow>(
        `ebay_feed_batches?owner_id=eq.${ownerId}&status=in.(queued,generating_csv,creating_task,uploading,processing,downloading_result,parsing_result)&select=id,owner_id`,
      );
      for (const batch of batches) {
        await runEbayFeedBatchProcessTick(ownerId, batch.id).catch(() => { /* one batch's failure never blocks the others this tick */ });
        batchesTicked += 1;
      }
    }
    return NextResponse.json({ ownersProcessed: owners.length, batchesTicked });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "eBay Feed draft processing sweep failed." }, { status: 500 }); }
}
