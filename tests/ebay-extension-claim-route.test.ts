// eBay Seller Hub extension drafter — pairing-failure review (Phase 3).
// Mirrors tests/extension-claim-route.test.ts (Vinted's own claim route)
// exactly in structure, scoped to app/api/extension/ebay-batch/claim/route.ts
// and ebay_extension_batches. Uses TEST DATA throughout — never the real
// Batch 2 or its real pairing code (see this pass's own read-only Phase 1
// finding: ebay_extension_batches contains zero rows; there is nothing
// live for these tests to touch even in principle).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { POST as claimRoute, OPTIONS as claimOptions } from "@/app/api/extension/ebay-batch/claim/route";
import { hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const CODE = "ABCD2345";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function batchRow(overrides: Record<string, unknown> = {}) {
  return { id: BATCH_ID, status: "pending_claim", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), ...overrides };
}
function requestWith(body: Record<string, unknown>, origin = EXTENSION_ORIGIN) {
  return new Request("http://test/api/extension/ebay-batch/claim", {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
}
// The bounded pairing-code lookup itself: a plain GET to
// ebay_extension_batches filtered by pairing_code_hash — never confused
// with the claiming PATCH below, which filters by status=eq.pending_claim
// instead.
function isPairingLookup(path: string, init?: RequestInit) {
  return path.startsWith("ebay_extension_batches?") && path.includes("pairing_code_hash=eq.") && (init?.method ?? "GET") === "GET";
}
function isClaimPatch(path: string, init?: RequestInit) {
  return path.startsWith("ebay_extension_batches?") && path.includes("status=eq.pending_claim") && init?.method === "PATCH";
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "e".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  supabaseRequest.mockReset();
  supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
    if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow()]), { status: 200 });
    if (isClaimPatch(path, init)) return new Response(JSON.stringify([batchRow({ status: "claimed" })]), { status: 200 });
    return new Response(null, { status: 204 });
  });
});

describe("POST /api/extension/ebay-batch/claim", () => {
  it("REQUIREMENT: an exact, valid, unexpired code succeeds once and returns a batch token", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchToken).toBeTruthy();
    expect(body.batchId).toBe(BATCH_ID);
  });

  it("REQUIREMENT: the creation path and pairing path generate/compare the SAME hash — the lookup is keyed by hashPairingCode(CODE) exactly, no second algorithm or salt involved", async () => {
    await claimRoute(requestWith({ pairingCode: CODE }));
    const lookupCall = supabaseRequest.mock.calls.find(c => isPairingLookup(c[0] as string, c[1] as RequestInit | undefined));
    expect(lookupCall).toBeDefined();
    expect(lookupCall![0]).toContain(`pairing_code_hash=eq.${hashPairingCode(CODE)}`);
  });

  it("REQUIREMENT: harmless surrounding whitespace is normalized — '  ABCD2345  ' hashes identically to 'ABCD2345'", async () => {
    await claimRoute(requestWith({ pairingCode: `  ${CODE}  ` }));
    const lookupCall = supabaseRequest.mock.calls.find(c => isPairingLookup(c[0] as string, c[1] as RequestInit | undefined));
    expect(lookupCall![0]).toContain(`pairing_code_hash=eq.${hashPairingCode(CODE)}`);
  });

  it("REQUIREMENT: lowercase input works — codes are case-insensitive by design (hashPairingCode normalises to uppercase before hashing)", async () => {
    await claimRoute(requestWith({ pairingCode: CODE.toLowerCase() }));
    const lookupCall = supabaseRequest.mock.calls.find(c => isPairingLookup(c[0] as string, c[1] as RequestInit | undefined));
    expect(lookupCall![0]).toContain(`pairing_code_hash=eq.${hashPairingCode(CODE)}`);
  });

  it("REGRESSION: never requires (or accepts) an owner session — this route is deliberately unauthenticated", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/extension/ebay-batch/claim/route.ts", "utf8"));
    expect(source).not.toContain("requireOwner");
  });

  it("REGRESSION: the bounded pairing-code lookup is a plain supabaseRequest() GET (never supabaseRequestAll())", async () => {
    await claimRoute(requestWith({ pairingCode: CODE }));
    const lookupCall = supabaseRequest.mock.calls.find(c => isPairingLookup(c[0] as string, c[1] as RequestInit | undefined));
    expect(lookupCall).toBeDefined();
    expect(lookupCall![0]).toContain("limit=1");
  });

  it("REQUIREMENT: a wrong code (no matching hash) is rejected with the generic message", async () => {
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

  it("REQUIREMENT: an expired code is rejected, and the batch is expired best-effort via the atomic expire RPC (never a two-step PATCH)", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow({ expires_at: new Date(Date.now() - 1000).toISOString() })]), { status: 200 });
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
    const expireRpcCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith("rpc/listing_studio_expire_ebay_extension_batch"));
    expect(expireRpcCall).toBeDefined();
    expect(JSON.parse((expireRpcCall![1] as RequestInit).body as string)).toEqual({ p_batch_id: BATCH_ID });
  });

  it("REQUIREMENT: a valid code cannot be reused after a successful claim — status != pending_claim is rejected the same generic way", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow({ status: "claimed" })]), { status: 200 });
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
  });

  it("REQUIREMENT: two concurrent claims cannot both succeed — the conditional claiming PATCH (status=eq.pending_claim) updating zero rows is treated as a loss, never a false success", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      if (isPairingLookup(path, init)) return new Response(JSON.stringify([batchRow()]), { status: 200 });
      if (isClaimPatch(path, init)) return new Response(JSON.stringify([]), { status: 200 }); // zero rows updated — lost the race
      return new Response(null, { status: 204 });
    });
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed body (missing pairingCode)", async () => {
    const response = await claimRoute(requestWith({}));
    expect(response.status).toBe(400);
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

  it("REGRESSION: the batch token issued never encodes/leaks the pairing code or its hash", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    const body = await response.json();
    const [, payloadB64] = body.batchToken.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    expect(JSON.stringify(payload)).not.toContain(CODE);
    expect(JSON.stringify(payload)).not.toContain(hashPairingCode(CODE));
  });

  it("REQUIREMENT: internal/server failures produce a TRUTHFUL, distinguishable error — a genuine exception never returns status 400 (the ONE status this route's generic 'invalid or expired' path ever uses), and never leaks the raw error text", async () => {
    supabaseRequest.mockRejectedValueOnce(new Error("db exploded"));
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).toBe(500);
    expect(response.status).not.toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });

  it("REQUIREMENT: no plaintext pairing code is ever included in any request this route makes to the database", async () => {
    await claimRoute(requestWith({ pairingCode: CODE }));
    for (const call of supabaseRequest.mock.calls) {
      const path = call[0] as string;
      const body = (call[1] as RequestInit | undefined)?.body;
      expect(path).not.toContain(CODE);
      if (typeof body === "string") expect(body).not.toContain(CODE);
    }
  });
});
