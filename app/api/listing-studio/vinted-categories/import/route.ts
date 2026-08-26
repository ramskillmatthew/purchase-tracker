import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { validateVintedCategorySnapshot } from "@/lib/listing-studio/vinted-catalogue-snapshot";
import { computeVintedCatalogueFingerprint, toVintedCategoryRpcPayload } from "@/lib/listing-studio/vinted-catalogue";
import { classifyVintedCategoryRpcError } from "@/lib/listing-studio/vinted-catalogue-rpc-errors";
import { VINTED_CATALOGUE_SOURCE_MARKET } from "@/lib/listing-studio/vinted-catalogue-client";

export const runtime = "nodejs";
export const maxDuration = 30;

// Generous relative to the genuine capture this was built from (~1MB for
// 3,049 categories) — a request-size guard, not an expected ceiling.
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

const importRequestSchema = z.object({
  // Deep validation happens in validateVintedCategorySnapshot() itself —
  // this only needs to be "some JSON value", never trusted further here.
  snapshot: z.unknown(),
  // false/omitted = validate + preview only, no database write at all.
  // true = validate AGAIN (never reuses an earlier preview's result) and
  // actually apply it. Two full server-side validations by design — a
  // preview must be exactly as trustworthy as the real import, not a
  // lighter/different check.
  confirm: z.boolean().default(false),
}).strict();

type RpcSummaryRow = {
  fetched_count: number; active_count: number; created_count: number; updated_count: number;
  unchanged_count: number; deactivated_count: number; leaf_count: number; selectable_count: number;
  fingerprint: string; refreshed_at: string;
};

const GENERIC_RPC_FAILURE = "Could not apply this Vinted category snapshot. The previous catalogue was kept.";

/**
 * Milestone 7 follow-up (2026-08-03) — imports a verified browser
 * snapshot of Vinted UK's category catalogue (captured from the
 * signed-in Create Listing page's own embedded `catalogTree`, already
 * flattened client-side before being handed to this app — see
 * lib/listing-studio/vinted-catalogue-snapshot.ts's own top comment for
 * exactly why this exists: the live endpoint has returned a Cloudflare
 * challenge page every time it's been tested from this project's
 * environment).
 *
 * Never accepts or stores cookies, tokens, or any other Vinted
 * authentication data — only the already-exported, already-flattened
 * JSON snapshot itself. Reuses the exact same transactional RPC, advisory
 * lock, shrinkage guard, and last-known-good preservation the live-refresh
 * path already relies on (lib/listing-studio/vinted-catalogue.ts's
 * fingerprint/RPC-payload helpers) — the only difference is where the
 * validated categories came from and the `source_type` recorded against
 * them.
 */
export async function POST(request: Request) {
  try {
    await requireOwner();

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_IMPORT_BODY_BYTES) {
      return NextResponse.json({ error: "This snapshot file is too large to import." }, { status: 413 });
    }
    const rawText = await request.text();
    if (rawText.length > MAX_IMPORT_BODY_BYTES) {
      return NextResponse.json({ error: "This snapshot file is too large to import." }, { status: 413 });
    }

    let parsedRequest: unknown;
    try { parsedRequest = JSON.parse(rawText); } catch {
      return NextResponse.json({ error: "That request was not valid JSON." }, { status: 400 });
    }
    const body = importRequestSchema.parse(parsedRequest);

    const validation = validateVintedCategorySnapshot(body.snapshot);
    if (!validation.valid) {
      return NextResponse.json({ error: "This snapshot failed validation and was not imported.", details: validation.errors.slice(0, 20) }, { status: 400 });
    }

    const fingerprint = computeVintedCatalogueFingerprint(validation.categories);

    if (!body.confirm) {
      return NextResponse.json({
        preview: true,
        pageUrl: validation.meta.pageUrl,
        capturedAt: validation.meta.capturedAt,
        categoryCount: validation.meta.categoryCount,
        leafCount: validation.meta.leafCount,
        selectableCount: validation.meta.selectableCount,
        maxDepth: validation.meta.maxDepth,
        rootIds: validation.meta.rootIds,
        fingerprint,
      });
    }

    const startedAt = Date.now();
    let summary: RpcSummaryRow;
    try {
      const response = await supabaseRequest("rpc/vinted_categories_apply_refresh", {
        method: "POST",
        body: JSON.stringify({
          p_source_market: VINTED_CATALOGUE_SOURCE_MARKET,
          p_source_endpoint: validation.meta.pageUrl,
          p_categories: validation.categories.map(toVintedCategoryRpcPayload),
          p_fingerprint: fingerprint,
          p_duration_ms: Date.now() - startedAt,
          p_source_type: "verified_browser_snapshot",
          p_captured_at: validation.meta.capturedAt,
        }),
      });
      const rows = (await response.json()) as RpcSummaryRow[];
      if (!rows.length) throw new Error("vinted_categories_apply_refresh returned no row.");
      summary = rows[0];
    } catch (error) {
      const known = classifyVintedCategoryRpcError(error);
      const message = known ?? GENERIC_RPC_FAILURE;
      if (!(error instanceof Error && error.message.includes("REFRESH_ALREADY_IN_PROGRESS"))) {
        await supabaseRequest("vinted_category_sync_status?on_conflict=source_market", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            source_market: VINTED_CATALOGUE_SOURCE_MARKET,
            source_endpoint: validation.meta.pageUrl,
            last_attempted_at: new Date().toISOString(),
            last_status: error instanceof Error && error.message.includes("SUSPICIOUS_CATALOGUE_SHRINKAGE") ? "rejected_shrinkage" : "failed",
            last_error: message,
            last_source_type: "verified_browser_snapshot",
            last_captured_at: validation.meta.capturedAt,
            updated_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
      return NextResponse.json({ error: message }, { status: 409 });
    }

    return NextResponse.json({
      preview: false,
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
      sourceType: "verified_browser_snapshot" as const,
      capturedAt: validation.meta.capturedAt,
      pageUrl: validation.meta.pageUrl,
    });
  } catch (error) { return safeApiError(error, "Could not import this Vinted category snapshot."); }
}
