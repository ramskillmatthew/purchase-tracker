import { supabaseRequest } from "@/lib/supabase";
import { hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";
import { signBatchToken } from "@/lib/listing-studio/extension-batch-tokens";
import { ebayExtensionClaimRequestSchema } from "@/lib/listing-studio/ebay-extension-batch-schema";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError, requestIpForRateLimit } from "@/lib/listing-studio/extension-cors";
import { enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";

// eBay Seller Hub extension drafter — mirrors app/api/extension/claim/route.ts
// exactly (see that route's own extensive doc comment for the full
// reasoning: single-use claim, generic error for every failure mode,
// rate-limited by IP since this is the one unauthenticated route in this
// feature) — a SEPARATE route operating on ebay_extension_batches, never
// vinted_extension_batches.
const RATE_LIMIT_BUCKET_OWNER_ID = "00000000-0000-0000-0000-000000000000";
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string; expires_at: string };

export async function POST(request: Request) {
  let claimStage = "initialising";
  try {
    claimStage = "rate_limit";
    const ip = requestIpForRateLimit(request);
    await enforceRateLimit(RATE_LIMIT_BUCKET_OWNER_ID, `ebay_extension_claim:${ip}`, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_SECONDS);

    claimStage = "request_validation";
    const { pairingCode, extensionId, extensionVersion, browserLabel } = ebayExtensionClaimRequestSchema.parse(await request.json());
    claimStage = "pairing_hash";
    const codeHash = hashPairingCode(pairingCode);
    const genericError = () => extensionCorsJson(request, { error: "This code is invalid or has expired." }, 400);

    claimStage = "pairing_lookup";
    const lookupResponse = await supabaseRequest(`ebay_extension_batches?pairing_code_hash=eq.${codeHash}&select=id,status,expires_at&limit=1`);
    const batches = await lookupResponse.json() as BatchRow[];
    const batch = batches[0];
    if (!batch) return genericError();

    if (new Date(batch.expires_at).getTime() <= Date.now()) {
      await supabaseRequest(`ebay_extension_batches?id=eq.${batch.id}&status=eq.pending_claim`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "expired" }),
      }).catch(() => {});
      return genericError();
    }
    if (batch.status !== "pending_claim") return genericError();

    claimStage = "claim_update";
    const nowIso = new Date().toISOString();
    const claimResponse = await supabaseRequest(`ebay_extension_batches?id=eq.${batch.id}&status=eq.pending_claim`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "claimed", claimed_at: nowIso, extension_id: extensionId ?? null, extension_version: extensionVersion ?? null, browser_label: browserLabel ?? null }),
    });
    const claimedRows = await claimResponse.json() as BatchRow[];
    if (!claimedRows.length) return genericError();

    claimStage = "token_signing";
    const expiresInSeconds = Math.max(1, Math.floor((new Date(batch.expires_at).getTime() - Date.now()) / 1000));
    const batchToken = await signBatchToken(batch.id, expiresInSeconds);

    return extensionCorsJson(request, { batchToken, batchId: batch.id, expiresAt: batch.expires_at });
  } catch (error) { return extensionSafeApiError(request, error, `Could not claim this eBay batch (${claimStage}).`); }
}
