import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { SERVER_BUILD_ID, SUPABASE_PROJECT_REF } from "@/lib/listing-studio/server-diagnostics";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

/**
 * eBay Seller Hub extension drafter — environment-provenance diagnostics
 * (pairing-failure review, environment audit). Deliberately UNAUTHENTICATED
 * (like claim/route.ts — the extension has no session before pairing) and
 * deliberately SAFE: no secrets, no keys, nothing an attacker could use —
 * see lib/listing-studio/server-diagnostics.ts's own top comment for
 * exactly what buildId/supabaseProjectRef are and why they're safe to
 * show. The extension's side panel pings this (and shows its OWN
 * configured App URL/version alongside it); the app's own "Send to eBay
 * extension" pairing card shows the SAME two identifiers, resolved from
 * the SAME shared module, from ITS OWN running instance. A human
 * comparing the two catches "my extension and my app aren't actually
 * talking to the same backend" directly — the exact class of confusion a
 * read-only environment-provenance audit diagnosed (a second, independent
 * `next dev` process on a different port, serving stale/corrupted output
 * after this session's own `.next`-sharing mistake — see that review's own
 * report for the full chain of evidence).
 */
export async function GET(request: Request) {
  try {
    return extensionCorsJson(request, {
      ok: true,
      buildId: SERVER_BUILD_ID,
      supabaseProjectRef: SUPABASE_PROJECT_REF,
      serverTime: new Date().toISOString(),
    });
  } catch (error) { return extensionSafeApiError(request, error, "Could not read server diagnostics."); }
}
