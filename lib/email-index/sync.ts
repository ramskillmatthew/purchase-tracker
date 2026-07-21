import "server-only";
import { supabaseRequest } from "@/lib/supabase";
import { scanYahooMetadataWithCursor, type FolderCursor as YahooFolderCursor, type YahooMetadata } from "@/lib/yahoo/client";
import { classifySubject, entityFromSender, extractMetadata } from "@/lib/email/classify";
import { audit } from "@/lib/security/activity";
import { firstUncoveredDate as computeFirstUncoveredDate, type CompletedRange } from "./coverage-gaps";
import { isStaleRunning, planAndRunSync, type FolderCursor, type SyncDeps, type SyncOutcome } from "./sync-plan";

export type { SyncOutcome };

function makeDeps(ownerId: string, trigger: "manual" | "cron"): SyncDeps {
  return {
    async firstUncoveredDate(start, end) {
      const rows = await (await supabaseRequest(`email_index_coverage?owner_id=eq.${ownerId}&status=eq.completed&range_start=lte.${end}&range_end=gte.${start}&select=range_start,range_end&order=range_start.asc`)).json() as CompletedRange[];
      return computeFirstUncoveredDate(rows, start, end);
    },
    async reapStaleRunning() {
      const rows = await (await supabaseRequest(`email_index_coverage?owner_id=eq.${ownerId}&status=eq.running&select=id,created_at`)).json() as { id: string; created_at: string }[];
      for (const row of rows) {
        if (!isStaleRunning(row.created_at)) continue;
        await supabaseRequest(`email_index_coverage?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), safe_error: "Run did not complete in time and was reset." }) });
      }
    },
    async beginOrResumeRun(start, end) {
      // Claim the one authoritative row for this exact range if it already
      // exists (left partial or failed by a prior pass) — a database unique
      // constraint on (owner_id, range_start, range_end) guarantees there is
      // never more than one such row, so this can never pick a stale
      // duplicate over a valid one. If two callers race, Postgres's row
      // locking ensures only one UPDATE actually matches; the loser falls
      // through to the insert below and hits a 409.
      const claimed = await supabaseRequest(`email_index_coverage?owner_id=eq.${ownerId}&range_start=eq.${start}&range_end=eq.${end}&status=in.(partial,failed)`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "running" }) });
      const claimedRows = await claimed.json() as { id: string }[];
      if (claimedRows.length) return claimedRows[0].id;
      try {
        const created = await supabaseRequest("email_index_coverage", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: ownerId, range_start: start, range_end: end, status: "running" }) });
        return ((await created.json()) as { id: string }[])[0]?.id || null;
      } catch (error) {
        // A unique-violation maps to 409: either the per-owner "one running
        // row" mutex is held elsewhere, or (rarer) a concurrent request
        // claimed/created this exact range first.
        if (error instanceof Error && "status" in error && (error as Error & { status: number }).status === 409) return null;
        throw error;
      }
    },
    async findCursor(start, end) {
      const rows = await (await supabaseRequest(`email_index_coverage?owner_id=eq.${ownerId}&range_start=eq.${start}&range_end=eq.${end}&select=continuation_cursor&limit=1`)).json() as { continuation_cursor: FolderCursor | null }[];
      return rows[0]?.continuation_cursor || null;
    },
    async scan(start, end, cursor, limit, openEnded) { return scanYahooMetadataWithCursor(start, end, cursor as YahooFolderCursor, limit, openEnded); },
    async indexRows(rows) {
      const indexed = (rows as YahooMetadata[]).map(row => ({ ...row, ...extractMetadata(row.subject), owner_id: ownerId, email_type: classifySubject(row.subject), entity_name: entityFromSender(row.sender_name, row.sender_address), updated_at: new Date().toISOString() }));
      for (let offset = 0; offset < indexed.length; offset += 250) await supabaseRequest("email_metadata_index?on_conflict=owner_id,message_fingerprint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(indexed.slice(offset, offset + 250)) });
      return indexed.length;
    },
    async markCompleted(coverageId, start, end, messagesIndexed) {
      await supabaseRequest(`email_index_coverage?id=eq.${coverageId}`, { method: "PATCH", body: JSON.stringify({ status: "completed", messages_indexed: messagesIndexed, completed_at: new Date().toISOString(), safe_error: null, continuation_cursor: null }) });
      await audit(ownerId, "email_metadata_indexed", { count: messagesIndexed, startDate: start, endDate: end, trigger });
    },
    async markPartial(coverageId, start, end, cursor, messagesIndexed) {
      await supabaseRequest(`email_index_coverage?id=eq.${coverageId}`, { method: "PATCH", body: JSON.stringify({ status: "partial", messages_indexed: messagesIndexed, completed_at: new Date().toISOString(), continuation_cursor: cursor, safe_error: "This range has more messages than fit in one pass, or is today's still-open incremental refresh. Indexing continues automatically." }) });
      await audit(ownerId, "email_metadata_index_partial", { count: messagesIndexed, startDate: start, endDate: end, trigger });
    },
    async markFailed(coverageId, reason) {
      await supabaseRequest(`email_index_coverage?id=eq.${coverageId}`, { method: "PATCH", body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), safe_error: reason }) });
    },
  };
}

/**
 * Scans, classifies, and upserts metadata for a date range, shared by both
 * the manual "Sync now" route and the automatic cron route. Never fetches
 * message source/bodies — only envelope metadata already covered by
 * scanYahooMetadataWithCursor's existing privacy guarantee. The historical
 * portion of the range is marked completed only once proven fully scanned
 * against a frozen snapshot; today (if requested) is always refreshed
 * incrementally and never marked completed. See sync-plan.ts.
 */
export async function runIndexSync(ownerId: string, requestedStart: string, requestedEnd: string, trigger: "manual" | "cron"): Promise<SyncOutcome> {
  const today = new Date().toISOString().slice(0, 10);
  return planAndRunSync(requestedStart, requestedEnd, today, makeDeps(ownerId, trigger));
}
