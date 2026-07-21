import "server-only";
import { supabaseRequest } from "@/lib/supabase";
import type { EmailType } from "@/lib/email/classify";
import { rankedFilters, type RankedIndexQuery } from "./ranked-filters";
import { hasFullCoverage, type CompletedRange } from "./coverage-gaps";

export type IndexQuery = { ownerId: string; entity?: string; type?: EmailType; startDate?: string; endDate?: string; limit?: number };
const safe = (value: string) => value.replace(/[%*,()]/g, "").trim();

export async function queryIndex(value: IndexQuery) {
  const filters = ["select=*", `owner_id=eq.${value.ownerId}`, "order=email_date.desc", `limit=${Math.min(value.limit || 25, 100)}`];
  if (value.startDate) filters.push(`email_date=gte.${value.startDate}T00:00:00Z`);
  if (value.endDate) filters.push(`email_date=lt.${nextDay(value.endDate)}T00:00:00Z`);
  if (value.type) filters.push(`email_type=eq.${value.type}`);
  if (value.entity) { const term = encodeURIComponent(safe(value.entity)); filters.push(`or=(entity_name.ilike.*${term}*,sender_name.ilike.*${term}*,sender_address.ilike.*${term}*,subject.ilike.*${term}*)`); }
  return await (await supabaseRequest(`email_metadata_index?${filters.join("&")}`)).json() as Record<string, unknown>[];
}

export async function countIndex(value: IndexQuery) {
  const filters = ["select=id", `owner_id=eq.${value.ownerId}`];
  if (value.startDate) filters.push(`email_date=gte.${value.startDate}T00:00:00Z`);
  if (value.endDate) filters.push(`email_date=lt.${nextDay(value.endDate)}T00:00:00Z`);
  if (value.type) filters.push(`email_type=eq.${value.type}`);
  if (value.entity) { const term = encodeURIComponent(safe(value.entity)); filters.push(`or=(entity_name.ilike.*${term}*,sender_name.ilike.*${term}*,sender_address.ilike.*${term}*,subject.ilike.*${term}*)`); }
  const response = await supabaseRequest(`email_metadata_index?${filters.join("&")}`, { headers: { Prefer: "count=exact", Range: "0-0" } });
  const range = response.headers.get("content-range") || "";
  return Number(range.split("/")[1] || 0);
}

export async function hasCoverage(ownerId: string, startDate?: string, endDate?: string) {
  if (!startDate || !endDate) return false;
  const rows = await (await supabaseRequest(`email_index_coverage?owner_id=eq.${ownerId}&status=eq.completed&range_start=lte.${endDate}&range_end=gte.${startDate}&select=range_start,range_end&order=range_start.asc`)).json() as CompletedRange[];
  return hasFullCoverage(rows, startDate, endDate);
}

function nextDay(date: string) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }

/** The single owner's most recently completed coverage row, if any — used by the cron route to resume from. This app is single-tenant, so there is only ever one owner. */
export async function latestCompletedCoverage() {
  const rows = await (await supabaseRequest("email_index_coverage?status=eq.completed&select=owner_id,range_end&order=range_end.desc&limit=1")).json() as { owner_id: string; range_end: string }[];
  return rows[0] || null;
}

type EmailIndexRow = {
  id: string; folder: string; yahoo_uid: number; uid_validity: string; sender_name: string | null; sender_address: string | null;
  subject: string; email_date: string; email_type: EmailType; entity_name: string | null; unread: boolean; has_attachments: boolean;
};

/** Typo-tolerant (pg_trgm) ranked search over indexed metadata only — no message body is read or stored. */
export async function searchIndexRanked(value: RankedIndexQuery) {
  const body = { ...rankedFilters(value), p_limit: Math.min(value.limit || 25, 100) };
  return await (await supabaseRequest("rpc/search_email_index", { method: "POST", body: JSON.stringify(body) })).json() as EmailIndexRow[];
}

/** Typo-tolerant (pg_trgm) ranked count over indexed metadata only — no message body is read or stored. */
export async function countIndexRanked(value: RankedIndexQuery) {
  const body = rankedFilters(value);
  return Number(await (await supabaseRequest("rpc/count_email_index", { method: "POST", body: JSON.stringify(body) })).json());
}
