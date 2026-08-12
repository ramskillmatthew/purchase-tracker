import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Follow-up correction: the route's bounded pairing-code lookup uses
// supabaseRequest() directly (never supabaseRequestAll(), which rejects
// any path carrying an explicit limit= — see lib/supabase.ts's own
// REGRESSION GUARD). This file mocks ONLY supabaseRequest now — mocking
// supabaseRequestAll here as well would let a future regression (the
// route accidentally switching back to supabaseRequestAll for this query)
// go completely undetected, since a hand-rolled mock has none of the real
// module's own restriction. tests/extension-claim-route-supabase-integration.test.ts
// goes further still: it doesn't mock @/lib/supabase at all, only the
// underlying fetch(), so the REAL supabaseRequest/supabaseRequestAll
// implementations (guard included) run for real.
const { supabaseRequest } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { POST as claimRoute, OPTIONS as claimOptions } from "@/app/api/extension/claim/route";
import { hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const CODE = "ABCD2345";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function batchRow(overrides: Record<string, unknown> = {}) {
  return { id: BATCH_ID, status: "pending_claim", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), ...overrides };
}
function requestWith(body: Record<string, unknown>, origin = EXTENSION_ORIGIN) {
  return new Request("http://test/api/extension/claim", {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
}
// The bounded pairing-code lookup itself: a plain GET (no method set in
// init) to vinted_extension_batches filtered by pairing_code_hash — never
// confused with the claiming PATCH below, which filters by
// status=eq.pending_claim instead.
function isPairingLookup(path: string, init?: RequestInit) {
  return path.startsWith("vinted_extension_batches?") && path.includes("pairing_code_hash=eq.") && (init?.method ?? "GET") === "GET";
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "e".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  supabaseRequest.mockReset();
  supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
    if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow()]), { status: 200 });
    if (path.includes("vinted_extension_batches?") && path.includes("status=eq.pending_claim")) {
      return new Response(JSON.stringify([batchRow({ status: "claimed" })]), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
});

describe("POST /api/extension/claim", () => {
  it("claims a valid, unclaimed, unexpired code and returns a batch token", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchToken).toBeTruthy();
    expect(body.batchId).toBe(BATCH_ID);
  });

  it("REGRESSION: never requires (or accepts) an owner session — this route is deliberately unauthenticated", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/extension/claim/route.ts", "utf8"));
    expect(source).not.toContain("requireOwner");
  });

  it("REGRESSION: the bounded pairing-code lookup is a plain supabaseRequest() GET (never supabaseRequestAll()) — confirmed by inspecting the actual call this test's own mock intercepted", async () => {
    await claimRoute(requestWith({ pairingCode: CODE }));
    const lookupCall = supabaseRequest.mock.calls.find(c => isPairingLookup(c[0] as string, c[1] as RequestInit | undefined));
    expect(lookupCall).toBeDefined();
    expect(lookupCall![0]).toContain("limit=1");
  });

  it("rejects an unknown code with a generic message", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([]), { status: 200 });
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects an EXPIRED code, and marks the batch expired best-effort", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow({ expires_at: new Date(Date.now() - 1000).toISOString() })]), { status: 200 });
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
    const expirePatch = supabaseRequest.mock.calls.find(c => (c[0] as string).includes("status=eq.pending_claim") && JSON.parse((c[1] as RequestInit).body as string).status === "expired");
    expect(expirePatch).toBeDefined();
  });

  it("REGRESSION: single-use — a code already claimed (status != pending_claim) is rejected the same generic way", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow({ status: "claimed" })]), { status: 200 });
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
  });

  it("REGRESSION: replay protection — if the conditional claiming PATCH updates zero rows (lost a race to a concurrent claim), the response is still the same generic rejection, never a false success", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow()]), { status: 200 });
      if (path.includes("vinted_extension_batches?") && path.includes("status=eq.pending_claim")) {
        return new Response(JSON.stringify([]), { status: 200 }); // zero rows updated — lost the race
      }
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed body (missing pairingCode)", async () => {
    const response = await claimRoute(requestWith({}));
    expect(response.status).toBe(400);
  });

  it("multi-batch: forwards an optional browserLabel (e.g. 'Chrome'/'Brave') onto the claiming PATCH — purely cosmetic, never a security boundary", async () => {
    await claimRoute(requestWith({ pairingCode: CODE, browserLabel: "Brave" }));
    const claimPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).includes("status=eq.pending_claim") && (c[1] as RequestInit)?.method === "PATCH");
    expect(claimPatch).toBeDefined();
    expect(JSON.parse((claimPatch![1] as RequestInit).body as string).browser_label).toBe("Brave");
  });

  it("omitting browserLabel stores null rather than failing the claim", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(200);
    const claimPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).includes("status=eq.pending_claim") && (c[1] as RequestInit)?.method === "PATCH");
    expect(JSON.parse((claimPatch![1] as RequestInit).body as string).browser_label).toBeNull();
  });

  it("rejects when the IP-based rate limit is already reached", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` }))), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(429);
  });

  it("responds with CORS headers matching EXTENSION_ORIGIN, and OPTIONS preflight succeeds", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION_ORIGIN);
    const preflight = await claimOptions(requestWith({}));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION_ORIGIN);
  });

  it("never sends CORS headers for a mismatched origin", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }, "https://evil.example"));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("REGRESSION: the batch token issued never encodes/leaks the pairing code itself", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    const body = await response.json();
    const [, payloadB64] = body.batchToken.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    expect(JSON.stringify(payload)).not.toContain(CODE);
    expect(JSON.stringify(payload)).not.toContain(hashPairingCode(CODE));
  });

  it("catches everything through safeApiError", async () => {
    supabaseRequest.mockRejectedValueOnce(new Error("db exploded"));
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});
