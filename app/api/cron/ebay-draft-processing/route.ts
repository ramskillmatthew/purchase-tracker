import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { runEbayDraftBatchProcessTick } from "@/lib/listing-studio/ebay-draft-batches";

export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

type ClaimableBatchRow = { id: string; owner_id: string };

/**
 * Corrective pass — the scheduler hook the persistent/resumable eBay
 * draft-batch processor needs so forward progress does NOT depend on a
 * browser tab staying open (see lib/listing-studio/ebay-draft-batches.ts's
 * own header comment for the full design; this route is the "future/
 * cron-driven sweep" that comment names). Mirrors
 * app/api/cron/investments-refresh/route.ts's own CRON_SECRET bearer-auth
 * convention exactly.
 *
 * Bounded: rpc/listing_studio_owners_with_claimable_ebay_work returns at
 * most a handful of owner ids (this is a single-tenant app today, so in
 * practice at most one — see yahoo-index/route.ts's own "single-tenant"
 * comment), and for each owner this finds every non-terminal batch with
 * currently-claimable work and runs exactly ONE process tick per batch —
 * never a whole batch to completion, never an unbounded loop. Registered
 * in vercel.json; NOT wired up or triggered by this corrective pass
 * itself (nothing is deployed) — see the final report for exactly what
 * remains before this genuinely runs on a schedule (a real deployment,
 * plus confirming the configured cron interval suits the target Vercel
 * plan).
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const ownersResponse = await supabaseRequest("rpc/listing_studio_owners_with_claimable_ebay_work", {
      method: "POST", body: JSON.stringify({ p_limit: 20 }),
    });
    const owners = await ownersResponse.json() as { owner_id: string }[];
    if (!owners.length) return NextResponse.json({ skipped: "no_claimable_work" });

    let batchesTicked = 0;
    for (const { owner_id: ownerId } of owners) {
      const batches = await supabaseRequestAll<ClaimableBatchRow>(
        `ebay_draft_batches?owner_id=eq.${ownerId}&status=in.(pending,in_progress)&select=id,owner_id`,
      );
      for (const batch of batches) {
        await runEbayDraftBatchProcessTick(ownerId, batch.id).catch(() => { /* one batch's failure never blocks the others this tick */ });
        batchesTicked += 1;
      }
    }
    return NextResponse.json({ ownersProcessed: owners.length, batchesTicked });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "eBay draft processing sweep failed." }, { status: 500 }); }
}
