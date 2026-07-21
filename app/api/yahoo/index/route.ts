import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { audit, enforceRateLimit } from "@/lib/security/activity";
import { runIndexSync } from "@/lib/email-index/sync";
import type { SyncOutcome } from "@/lib/email-index/sync-plan";

export const runtime = "nodejs";
export const maxDuration = 60;
const schema = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().refine(value => value.startDate <= value.endDate, "Invalid date range.");

export async function GET() {
  try {
    const user = await requireOwner();
    const [rows, coverage, running, partial, failed] = await Promise.all([
      supabaseRequest(`email_metadata_index?owner_id=eq.${user.id}&select=id`, { headers: { Prefer: "count=exact", Range: "0-0" } }),
      supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}&status=eq.completed&select=range_start,range_end,completed_at,messages_indexed&order=completed_at.desc&limit=25`),
      supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}&status=eq.running&select=range_start,range_end,created_at&order=created_at.desc&limit=1`),
      supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}&status=eq.partial&select=range_start,range_end,completed_at,messages_indexed&order=completed_at.desc&limit=1`),
      supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}&status=eq.failed&select=range_start,range_end,completed_at,safe_error&order=completed_at.desc&limit=1`),
    ]);
    const ranges = await coverage.json() as { range_start: string; range_end: string; completed_at: string; messages_indexed: number }[];
    const runningRows = await running.json() as { range_start: string; range_end: string; created_at: string }[];
    const partialRows = await partial.json() as { range_start: string; range_end: string; completed_at: string; messages_indexed: number }[];
    const failedRows = await failed.json() as { range_start: string; range_end: string; completed_at: string; safe_error: string | null }[];
    return NextResponse.json({
      count: Number((rows.headers.get("content-range") || "").split("/")[1] || 0),
      ranges,
      lastSyncedAt: ranges[0]?.completed_at || null,
      currentlyIndexing: runningRows[0] ? { rangeStart: runningRows[0].range_start, rangeEnd: runningRows[0].range_end, startedAt: runningRows[0].created_at } : null,
      inProgress: partialRows[0] ? { rangeStart: partialRows[0].range_start, rangeEnd: partialRows[0].range_end, indexedSoFar: partialRows[0].messages_indexed, lastPassAt: partialRows[0].completed_at } : null,
      lastFailure: failedRows[0] ? { rangeStart: failedRows[0].range_start, rangeEnd: failedRows[0].range_end, occurredAt: failedRows[0].completed_at, reason: failedRows[0].safe_error } : null,
    });
  } catch (error) { return safeApiError(error, "Email index status could not be loaded safely."); }
}

function summarizePass(pass: SyncOutcome["historical"] | SyncOutcome["today"]) {
  if (!pass) return null;
  if (pass.status === "already_covered") return { status: "already_covered" as const };
  if (pass.status === "skipped") return { status: "already_running" as const };
  if (pass.status === "failed") return { status: "failed" as const, rangeStart: pass.rangeStart, rangeEnd: pass.rangeEnd, reason: pass.reason };
  if (pass.status === "partial") return { status: "partial" as const, rangeStart: pass.rangeStart, rangeEnd: pass.rangeEnd, indexed: pass.indexed, note: pass.note };
  return { status: "completed" as const, rangeStart: pass.rangeStart, rangeEnd: pass.rangeEnd, indexed: pass.indexed };
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner(); await enforceRateLimit(user.id, "email_index_sync", 4, 300);
    const value = schema.parse(await request.json());
    const outcome = await runIndexSync(user.id, value.startDate, value.endDate, "manual");
    const historical = summarizePass(outcome.historical);
    const today = summarizePass(outcome.today);
    const anySkipped = historical?.status === "already_running" || today?.status === "already_running";
    if (anySkipped) return NextResponse.json({ error: "A sync is already running. Try again shortly." }, { status: 409 });
    const anyFailed = historical?.status === "failed" || today?.status === "failed";
    if (anyFailed) {
      const failedReason = historical?.status === "failed" ? historical.reason : today?.status === "failed" ? today.reason : "Unknown reason.";
      return NextResponse.json({ error: `Could not safely complete part of this range: ${failedReason}`, historical, today }, { status: 500 });
    }
    return NextResponse.json({ historical, today });
  } catch (error) { return safeApiError(error, "Email metadata sync could not be completed safely."); }
}

export async function DELETE() {
  try {
    const user = await requireOwner();
    await Promise.all([supabaseRequest(`email_metadata_index?owner_id=eq.${user.id}`, { method: "DELETE" }), supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}`, { method: "DELETE" })]);
    await audit(user.id, "email_metadata_index_cleared");
    return NextResponse.json({ cleared: true });
  } catch (error) { return safeApiError(error, "Email metadata index could not be cleared safely."); }
}
