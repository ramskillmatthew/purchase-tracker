import "server-only";
import { execSync } from "node:child_process";

/**
 * eBay Seller Hub extension drafter — environment-provenance diagnostics
 * (pairing-failure review). ONE place both GET /api/extension/ebay-batch/health
 * (the extension's own ping) and the app-side create-batch route (the
 * Listings Review pairing card) resolve these two safe, non-secret
 * identifiers from — never two independent implementations that could
 * quietly drift and defeat the whole point of comparing them.
 *
 *   - buildId: a short, non-secret build identifier (the running git
 *     commit, or Vercel's own deploy SHA when deployed) — proves which
 *     checkout/deploy actually answered a given request.
 *   - supabaseProjectRef: the Supabase project's hostname-derived
 *     reference (e.g. "abcdefgh" from https://abcdefgh.supabase.co) —
 *     already public (NEXT_PUBLIC_SUPABASE_URL ships to every browser page
 *     regardless), never a key, never the service-role secret.
 *
 * Both resolved ONCE at module load (a `git rev-parse` per request would
 * be needless overhead for a value that cannot change while this process
 * is running) and cached in module-level constants.
 */
export const SERVER_BUILD_ID: string = (() => {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), timeout: 2000 }).toString().trim();
  } catch {
    return "unknown";
  }
})();

export const SUPABASE_PROJECT_REF: string = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").hostname.split(".")[0] || "unknown";
  } catch {
    return "unknown";
  }
})();
