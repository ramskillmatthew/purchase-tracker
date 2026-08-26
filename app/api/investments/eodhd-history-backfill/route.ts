import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { backfillAllEodhdHistory } from "@/lib/investments/history-backfill";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Owner-authenticated, coverage-checked EODHD historical backfill — see
 * lib/investments/history-backfill.ts's backfillEodhdAssetHistory for the
 * full design. Distinct from POST /api/investments/history-backfill (which
 * covers twelve_data/pokepulse/eodhd unconditionally on every run): this
 * route only ever touches pricing_provider = 'eodhd' assets, and skips an
 * asset's request entirely once its stored range is already essentially
 * complete — deliberate EODHD-specific quota discipline, not a general
 * change to the existing route's behaviour.
 */
export async function POST() {
  try {
    const user = await requireOwner();
    const result = await backfillAllEodhdHistory(user.id);
    return NextResponse.json(result);
  } catch (error) { return safeApiError(error, "Could not backfill EODHD price history."); }
}
