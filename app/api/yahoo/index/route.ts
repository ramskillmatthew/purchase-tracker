import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { scanYahooMetadata } from "@/lib/yahoo/client";
import { classifyIndexedEmail, entityFromSender, extractMetadata } from "@/lib/email-index/classify";
import { audit, enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";
export const maxDuration = 60;
const schema = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().refine(value => value.startDate <= value.endDate, "Invalid date range.");

export async function GET() {
  try {
    const user = await requireOwner();
    const [rows, coverage] = await Promise.all([
      supabaseRequest(`email_metadata_index?owner_id=eq.${user.id}&select=id`, { headers: { Prefer: "count=exact", Range: "0-0" } }),
      supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}&status=eq.completed&select=range_start,range_end,completed_at,messages_indexed&order=completed_at.desc&limit=25`),
    ]);
    const ranges = await coverage.json() as { range_start: string; range_end: string; completed_at: string; messages_indexed: number }[];
    return NextResponse.json({ count: Number((rows.headers.get("content-range") || "").split("/")[1] || 0), ranges, lastSyncedAt: ranges[0]?.completed_at || null });
  } catch (error) { return safeApiError(error, "Email index status could not be loaded safely."); }
}

export async function POST(request: Request) {
  let coverageId: string | null = null;
  try {
    const user = await requireOwner(); await enforceRateLimit(user.id, "email_index_sync", 4, 300);
    const value = schema.parse(await request.json());
    const created = await supabaseRequest("email_index_coverage", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, range_start: value.startDate, range_end: value.endDate, status: "running" }) });
    coverageId = ((await created.json()) as { id: string }[])[0]?.id || null;
    const scanned = await scanYahooMetadata(value.startDate, value.endDate);
    const indexed = scanned.rows.map(row => ({ ...row, ...extractMetadata(row.subject), owner_id: user.id, email_type: classifyIndexedEmail(row.subject), entity_name: entityFromSender(row.sender_name, row.sender_address), updated_at: new Date().toISOString() }));
    for (let offset = 0; offset < indexed.length; offset += 250) await supabaseRequest("email_metadata_index?on_conflict=owner_id,message_fingerprint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(indexed.slice(offset, offset + 250)) });
    if (coverageId) await supabaseRequest(`email_index_coverage?id=eq.${coverageId}`, { method: "PATCH", body: JSON.stringify({ status: scanned.truncated ? "failed" : "completed", messages_indexed: indexed.length, completed_at: new Date().toISOString(), safe_error: scanned.truncated ? "The range exceeded the safe per-run limit. Sync a smaller date range." : null }) });
    await audit(user.id, "email_metadata_indexed", { count: indexed.length, startDate: value.startDate, endDate: value.endDate, truncated: scanned.truncated });
    return NextResponse.json({ indexed: indexed.length, truncated: scanned.truncated, foldersSearched: scanned.foldersSearched });
  } catch (error) {
    if (coverageId) try { await supabaseRequest(`email_index_coverage?id=eq.${coverageId}`, { method: "PATCH", body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), safe_error: "Metadata sync failed safely." }) }); } catch {}
    return safeApiError(error, "Email metadata sync could not be completed safely.");
  }
}

export async function DELETE() {
  try {
    const user = await requireOwner();
    await Promise.all([supabaseRequest(`email_metadata_index?owner_id=eq.${user.id}`, { method: "DELETE" }), supabaseRequest(`email_index_coverage?owner_id=eq.${user.id}`, { method: "DELETE" })]);
    await audit(user.id, "email_metadata_index_cleared");
    return NextResponse.json({ cleared: true });
  } catch (error) { return safeApiError(error, "Email metadata index could not be cleared safely."); }
}
