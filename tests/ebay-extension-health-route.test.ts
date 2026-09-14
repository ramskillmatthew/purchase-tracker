// eBay Seller Hub extension drafter — environment-provenance audit.
// GET /api/extension/ebay-batch/health is the ONE safe, unauthenticated
// diagnostics endpoint the extension pings (and the create-batch route
// reuses the SAME resolver for) — see lib/listing-studio/server-diagnostics.ts's
// own top comment for exactly what it exposes and why it's safe.
//
// server-diagnostics.ts resolves both identifiers ONCE, at module import
// time (a deliberate choice — see its own comment), so this file
// explicitly controls NEXT_PUBLIC_SUPABASE_URL and re-imports fresh via
// vi.resetModules() rather than depending on whatever the ambient test
// process's env happens to already contain — the correct, deterministic
// way to test a module-load-time resolution regardless of how the wider
// test run's own environment is populated.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FAKE_SUPABASE_URL = "https://abcd1234.supabase.co";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function request(origin: string | null = EXTENSION_ORIGIN) {
  return new Request("http://test/api/extension/ebay-batch/health", { headers: origin ? { origin } : {} });
}

async function loadHealthRoute() {
  vi.resetModules();
  return import("@/app/api/extension/ebay-batch/health/route");
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = FAKE_SUPABASE_URL;
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});

describe("GET /api/extension/ebay-batch/health", () => {
  it("REQUIREMENT: reports a real, non-secret build identifier (the running git commit, resolved via `git rev-parse --short HEAD`)", async () => {
    const { GET } = await loadHealthRoute();
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.buildId).toBe("string");
    expect(body.buildId.length).toBeGreaterThan(0);
    expect(body.buildId).toMatch(/^[0-9a-f]{7,12}$/);
  });

  it("REQUIREMENT: prefers VERCEL_GIT_COMMIT_SHA when deployed (no local git checkout to inspect on Vercel)", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "deadbeefcafefeed1234567890abcdef0000000";
    const { GET } = await loadHealthRoute();
    const body = await (await GET(request())).json();
    expect(body.buildId).toBe("deadbeefcafe");
  });

  it("REQUIREMENT: reports the Supabase project reference — hostname-derived, never a key or the full URL", async () => {
    const { GET } = await loadHealthRoute();
    const body = await (await GET(request())).json();
    expect(body.supabaseProjectRef).toBe("abcd1234");
  });

  it("REGRESSION: falls back to 'unknown' (never throws) when NEXT_PUBLIC_SUPABASE_URL is missing or malformed", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    const { GET } = await loadHealthRoute();
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.supabaseProjectRef).toBe("unknown");
  });

  it("REGRESSION: never exposes any key or secret — the response body never contains SUPABASE_SECRET_KEY, EXTENSION_BATCH_SECRET, or the full configured Supabase URL", async () => {
    process.env.SUPABASE_SECRET_KEY = "sb_secret_totally-fake-test-value-never-real";
    process.env.EXTENSION_BATCH_SECRET = "f".repeat(32);
    const { GET } = await loadHealthRoute();
    const raw = await (await GET(request())).text();
    expect(raw).not.toContain(process.env.SUPABASE_SECRET_KEY);
    expect(raw).not.toContain(process.env.EXTENSION_BATCH_SECRET);
    expect(raw).not.toContain(FAKE_SUPABASE_URL);
  });

  it("REGRESSION: never requires (or accepts) an owner session, and never queries the database — this must stay reachable even when nothing has been created yet", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/extension/ebay-batch/health/route.ts", "utf8"));
    expect(source).not.toContain("requireOwner");
    expect(source).not.toContain("supabaseRequest");
  });

  it("responds with CORS headers matching EXTENSION_ORIGIN, and OPTIONS preflight succeeds", async () => {
    const { GET, OPTIONS } = await loadHealthRoute();
    const response = await GET(request());
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION_ORIGIN);
    const preflight = await OPTIONS(request());
    expect(preflight.status).toBe(204);
  });

  it("never sends CORS headers for a mismatched origin", async () => {
    const { GET } = await loadHealthRoute();
    const response = await GET(request("https://evil.example"));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
