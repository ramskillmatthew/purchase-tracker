import type { EmailType } from "@/lib/email/classify";

export type RankedIndexQuery = { ownerId: string; query?: string; type?: EmailType; startDate?: string; endDate?: string; limit?: number };

function nextDay(date: string) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }

export function rankedFilters(value: RankedIndexQuery) {
  return {
    p_owner_id: value.ownerId,
    p_query: value.query || null,
    p_type: value.type || null,
    p_start_at: value.startDate ? `${value.startDate}T00:00:00Z` : null,
    p_end_at: value.endDate ? `${nextDay(value.endDate)}T00:00:00Z` : null,
  };
}
