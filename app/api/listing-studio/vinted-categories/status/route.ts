import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getVintedCategorySyncStatus } from "@/lib/listing-studio/vinted-categories-data";
import { VINTED_CATALOGUE_ENDPOINT, VINTED_CATALOGUE_SOURCE_MARKET } from "@/lib/listing-studio/vinted-catalogue-client";

export const runtime = "nodejs";

/** Backs the small owner-only admin refresh control — read-only, never triggers a fetch itself. */
export async function GET() {
  try {
    await requireOwner();
    const status = await getVintedCategorySyncStatus();

    return NextResponse.json({
      sourceMarket: VINTED_CATALOGUE_SOURCE_MARKET,
      sourceEndpoint: VINTED_CATALOGUE_ENDPOINT,
      lastAttemptedAt: status?.last_attempted_at ?? null,
      lastSucceededAt: status?.last_succeeded_at ?? null,
      lastStatus: status?.last_status ?? null,
      lastError: status?.last_error ?? null,
      fetchedCount: status?.fetched_count ?? null,
      activeCount: status?.active_count ?? null,
      fingerprint: status?.fingerprint ?? null,
      durationMs: status?.duration_ms ?? null,
      lastSourceType: status?.last_source_type ?? null,
      lastCapturedAt: status?.last_captured_at ?? null,
    });
  } catch (error) { return safeApiError(error, "Could not load the Vinted category sync status."); }
}
