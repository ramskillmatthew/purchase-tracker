import "server-only";
import { supabaseRequest } from "@/lib/supabase";
import type { IndexedEmailType } from "./classify";

export type IndexQuery = { ownerId: string; entity?: string; type?: IndexedEmailType; startDate?: string; endDate?: string; limit?: number };
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
  const rows = await (await supabaseRequest(`email_index_coverage?owner_id=eq.${ownerId}&status=eq.completed&range_start=lte.${endDate}&range_end=gte.${startDate}&select=range_start,range_end&order=range_start.asc`)).json() as { range_start: string; range_end: string }[];
  let coveredThrough: string | null = null;
  for (const row of rows) {
    if (row.range_end < startDate) continue;
    if (!coveredThrough) { if (row.range_start > startDate) return false; coveredThrough = row.range_end; }
    else { const allowedStart = nextDay(coveredThrough); if (row.range_start > allowedStart) return false; if (row.range_end > coveredThrough) coveredThrough = row.range_end; }
    if (coveredThrough >= endDate) return true;
  }
  return false;
}

function nextDay(date: string) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }
