import { supabaseRequest } from "@/lib/supabase";
import { hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";
import { EXTENSION_CONNECTION_EXPIRY_SECONDS, signBatchToken, signConnectionToken } from "@/lib/listing-studio/extension-batch-tokens";
import { claimRequestSchema } from "@/lib/listing-studio/extension-batch-schema";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError, requestIpForRateLimit } from "@/lib/listing-studio/extension-cors";
import { enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";

// A well-known, non-owner placeholder — enforceRateLimit's table is
// owner_id-shaped, but this route is deliberately UNAUTHENTICATED (the
// extension has no owner session, only a pairing code). The real
// per-caller granularity comes from embedding the request IP into the
// action string below, not from this id.
const RATE_LIMIT_BUCKET_OWNER_ID = "00000000-0000-0000-0000-000000000000";
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; owner_id: string; status: string; expires_at: string };

/**
 * Milestone 7 (Chrome extension draft queue) — exchanges a single-use
 * pairing code for a restricted batch token. Deliberately the ONE
 * unauthenticated route in this whole feature (the extension has no
 * Supabase session) — every OTHER extension-facing route requires the
 * bearer token this route hands out, scoped to exactly one batch.
 *
 * Single-use is enforced atomically: the claiming UPDATE only succeeds
 * when the batch is still `pending_claim` at that exact moment (see the
 * conditional PATCH below) — a second attempt with the same code, whether
 * a genuine replay or a race, updates zero rows and is rejected. The same
 * generic "invalid or expired" message is returned for every failure mode
 * (wrong code, already claimed, expired) — never distinguishing them, so
 * a caller can't use the error to narrow down a guess.
 */
export async function POST(request: Request) {
  try {
    const ip = requestIpForRateLimit(request);
    await enforceRateLimit(RATE_LIMIT_BUCKET_OWNER_ID, `extension_claim:${ip}`, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_SECONDS);

    const { pairingCode, extensionId, extensionVersion, browserLabel } = claimRequestSchema.parse(await request.json());
    const codeHash = hashPairingCode(pairingCode);
    const genericError = () => extensionCorsJson(request, { error: "This code is invalid or has expired." }, 400);

    // Deliberately supabaseRequest(), NOT supabaseRequestAll() — this is a
    // bounded (`limit=1`) lookup, and supabaseRequestAll() itself refuses
    // any path carrying an explicit limit/offset (its own Range-based
    // pagination is fundamentally incompatible with a caller-supplied cap
    // — see that function's own REGRESSION GUARD comment in lib/supabase.ts).
    // A single row is always expected here (pairing_code_hash is unique),
    // so a plain bounded GET is exactly the right tool, not a
    // fetch-every-matching-row helper.
    const lookupResponse = await supabaseRequest(
      `vinted_extension_batches?pairing_code_hash=eq.${codeHash}&select=id,owner_id,status,expires_at&limit=1`,
    );
    const batches = await lookupResponse.json() as BatchRow[];
    const batch = batches[0];
    if (!batch) return genericError();

    if (new Date(batch.expires_at).getTime() <= Date.now()) {
      await supabaseRequest(`vinted_extension_batches?id=eq.${batch.id}&status=eq.pending_claim`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "expired" }),
      }).catch(() => {});
      return genericError();
    }
    if (batch.status !== "pending_claim") return genericError();

    const nowIso = new Date().toISOString();
    const claimResponse = await supabaseRequest(
      `vinted_extension_batches?id=eq.${batch.id}&status=eq.pending_claim`,
      {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "claimed", claimed_at: nowIso, extension_id: extensionId ?? null, extension_version: extensionVersion ?? null, browser_label: browserLabel ?? null }),
      },
    );
    const claimedRows = await claimResponse.json() as BatchRow[];
    if (!claimedRows.length) return genericError(); // lost the race to another concurrent claim attempt

    const expiresInSeconds = Math.max(1, Math.floor((new Date(batch.expires_at).getTime() - Date.now()) / 1000));
    const batchToken = await signBatchToken(batch.id, expiresInSeconds);
    const connectionToken = await signConnectionToken(batch.owner_id);
    const connectionExpiresAt = new Date(Date.now() + EXTENSION_CONNECTION_EXPIRY_SECONDS * 1000).toISOString();

    return extensionCorsJson(request, { batchToken, batchId: batch.id, expiresAt: batch.expires_at, connectionToken, connectionExpiresAt });
  } catch (error) { return extensionSafeApiError(request, error, "Could not claim this batch."); }
}
