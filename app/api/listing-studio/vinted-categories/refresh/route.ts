import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { fetchVintedCatalogue, describeVintedCatalogueFetchFailure, VINTED_CATALOGUE_ENDPOINT, VINTED_CATALOGUE_SOURCE_MARKET } from "@/lib/listing-studio/vinted-catalogue-client";
import { computeVintedCatalogueFingerprint, toVintedCategoryRpcPayload } from "@/lib/listing-studio/vinted-catalogue";
import { classifyVintedCategoryRpcError } from "@/lib/listing-studio/vinted-catalogue-rpc-errors";

export const runtime = "nodejs";
export const maxDuration = 30;

type RpcSummaryRow = {
  fetched_count: number; active_count: number; created_count: number; updated_count: number;
  unchanged_count: number; deactivated_count: number; leaf_count: number; selectable_count: number;
  fingerprint: string; refreshed_at: string;
};

/** A safe, generic failure the RPC did not itself classify (e.g. the connection dropped) — never leaks the raw database error to the client. */
const GENERIC_RPC_FAILURE = "Could not apply the Vinted category refresh. The previous catalogue was kept.";

/**
 * Milestone 7 (Vinted category catalogue sync) — one of the two write
 * endpoints that can ever change public.vinted_categories (the other
 * being .../vinted-categories/import/route.ts, the verified-snapshot
 * path — see that file's own comment for why it's currently the only one
 * that's actually worked). Owner-only, manually triggered from the
 * Settings page — there is deliberately no automatic refresh-on-page-load
 * anywhere, and no automatic retry of a failed refresh.
 *
 * Every failure path — a fetch failure (network/blocked/rate-limited/
 * malformed) or an RPC rejection (concurrent refresh, suspicious
 * shrinkage, invalid payload) — records what happened in
 * vinted_category_sync_status and returns a safe message pointing at the
 * snapshot-import fallback, but NEVER mutates public.vinted_categories
 * itself: the previous catalogue is always left exactly as it was until a
 * fetch fully succeeds AND passes every check inside
 * vinted_categories_apply_refresh's own transaction.
 */
export async function POST() {
  try {
    await requireOwner();

    const startedAt = Date.now();
    const outcome = await fetchVintedCatalogue();

    if (outcome.status !== "success") {
      const safeMessage = `${describeVintedCatalogueFetchFailure(outcome)} Import a verified browser snapshot instead.`;
      await supabaseRequest("vinted_category_sync_status?on_conflict=source_market", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          source_market: VINTED_CATALOGUE_SOURCE_MARKET,
          source_endpoint: VINTED_CATALOGUE_ENDPOINT,
          last_attempted_at: new Date().toISOString(),
          last_status: outcome.status === "invalid_response" || outcome.status === "unexpected_content_type" ? "rejected_invalid_response" : "failed",
          last_error: safeMessage,
          last_source_type: "live_endpoint",
          updated_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      return NextResponse.json({ error: safeMessage }, { status: 502 });
    }

    const durationMs = Date.now() - startedAt;
    const fingerprint = computeVintedCatalogueFingerprint(outcome.categories);

    let summary: RpcSummaryRow;
    try {
      const response = await supabaseRequest("rpc/vinted_categories_apply_refresh", {
        method: "POST",
        body: JSON.stringify({
          p_source_market: VINTED_CATALOGUE_SOURCE_MARKET,
          p_source_endpoint: VINTED_CATALOGUE_ENDPOINT,
          p_categories: outcome.categories.map(toVintedCategoryRpcPayload),
          p_fingerprint: fingerprint,
          p_duration_ms: durationMs,
          p_source_type: "live_endpoint",
        }),
      });
      const rows = (await response.json()) as RpcSummaryRow[];
      if (!rows.length) throw new Error("vinted_categories_apply_refresh returned no row.");
      summary = rows[0];
    } catch (error) {
      const known = classifyVintedCategoryRpcError(error);
      // The RPC's own transaction already recorded a failed sync-status
      // row for real rejections (shrinkage, invalid payload, etc) via its
      // own logic path being skipped — its transaction rolled back
      // entirely, INCLUDING any sync-status write it would have made, so
      // record one here instead. A concurrent-refresh rejection is the
      // one case where a status row genuinely shouldn't be overwritten by
      // this failed attempt (the other refresh owns it) — skip that one.
      const message = known ?? GENERIC_RPC_FAILURE;
      if (!(error instanceof Error && error.message.includes("REFRESH_ALREADY_IN_PROGRESS"))) {
        await supabaseRequest("vinted_category_sync_status?on_conflict=source_market", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            source_market: VINTED_CATALOGUE_SOURCE_MARKET,
            source_endpoint: VINTED_CATALOGUE_ENDPOINT,
            last_attempted_at: new Date().toISOString(),
            last_status: error instanceof Error && error.message.includes("SUSPICIOUS_CATALOGUE_SHRINKAGE") ? "rejected_shrinkage" : "failed",
            last_error: message,
            last_source_type: "live_endpoint",
            updated_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
      return NextResponse.json({ error: message }, { status: 409 });
    }

    return NextResponse.json({
      sourceType: "live_endpoint" as const,
      fetchedCount: summary.fetched_count,
      activeCount: summary.active_count,
      createdCount: summary.created_count,
      updatedCount: summary.updated_count,
      unchangedCount: summary.unchanged_count,
      deactivatedCount: summary.deactivated_count,
      leafCount: summary.leaf_count,
      selectableCount: summary.selectable_count,
      fingerprint: summary.fingerprint,
      refreshedAt: summary.refreshed_at,
    });
  } catch (error) { return safeApiError(error, "Could not refresh Vinted's category catalogue."); }
}
