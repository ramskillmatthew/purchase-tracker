import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { runHistoryBackfill } from "@/lib/investments/history-backfill";

export const runtime = "nodejs";
// A first-ever backfill across several assets, each requesting up to a
// couple of years of daily history, genuinely takes longer than the
// ordinary current-price refresh — subsequent runs cost the same (this
// module always requests the full range; see its own comment for why an
// incremental-gap approach turned out to be actively wrong here), so this
// stays generous rather than timing out a legitimate run.
export const maxDuration = 120;

/**
 * Owner-authenticated, idempotent historical-price backfill — see
 * lib/investments/history-backfill.ts for what this actually does and why
 * it's the real fix for the chart's sparse history. Only ever touches the
 * calling owner's own assets (runHistoryBackfill scopes every query by
 * owner_id); never accepts an asset id or provider URL from the request.
 */
export async function POST() {
  try {
    const user = await requireOwner();
    const result = await runHistoryBackfill(user.id);
    return NextResponse.json(result);
  } catch (error) { return safeApiError(error, "Could not backfill price history."); }
}
