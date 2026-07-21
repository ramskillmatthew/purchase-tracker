import { NextResponse } from "next/server";
import { latestCompletedCoverage } from "@/lib/email-index/query";
import { runIndexSync } from "@/lib/email-index/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

// Each automatic tick advances the historical index by at most this many
// days, so a large backlog is walked forward across several daily runs
// instead of one run trying (and timing out) on the whole gap at once.
// This also always requests through "today", so runIndexSync's internal
// historical/today split picks up today's incremental refresh every tick.
const CHUNK_DAYS = 7;

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(date: string, days: number) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Single-tenant app: there is only ever one owner, so the most recently
    // completed coverage row (regardless of which owner_id it names) tells
    // us who to sync for and where to resume from. If nothing has ever been
    // indexed, this deliberately does nothing rather than guessing how far
    // back to backfill — an initial manual "Sync now" establishes the
    // starting point. Today is never part of a completed row (see
    // sync-plan.ts), so this naturally keeps landing on "today" once
    // historical backfill is caught up, and naturally keeps recomputing the
    // same still-incomplete historical chunk until it actually completes —
    // no separate "is something in progress" check is needed here.
    const latest = await latestCompletedCoverage();
    if (!latest) return NextResponse.json({ skipped: "no_initial_coverage" });

    const now = today();
    const start = latest.range_end >= now ? now : addDays(latest.range_end, 1);
    const proposedEnd = addDays(start, CHUNK_DAYS - 1);
    const end = proposedEnd > now ? now : proposedEnd;

    const outcome = await runIndexSync(latest.owner_id, start, end, "cron");
    return NextResponse.json({ outcome });
  } catch (error) {
    console.error("Automatic email index sync failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Automatic sync failed safely." }, { status: 500 });
  }
}
