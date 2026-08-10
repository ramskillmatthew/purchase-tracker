// Follow-up correction: the claim route's own test file
// (tests/extension-claim-route.test.ts) mocks @/lib/supabase wholesale —
// replacing supabaseRequestAll with a hand-rolled fake that has none of
// the real module's own guard logic. That is EXACTLY how the real bug
// (supabaseRequestAll() rejecting any path with an explicit `limit=`,
// which the claim route's bounded pairing-code lookup used) went
// undetected: a fully mocked supabaseRequestAll can never reproduce a
// restriction that lives inside the real implementation.
//
// This file deliberately does NOT mock @/lib/supabase at all — only the
// global fetch() call at the actual HTTP boundary, exactly like
// tests/supabase-request-all.test.ts already does for that module's own
// tests. supabaseRequest/supabaseRequestAll run for real here, so if the
// claim route ever again passed a `limit=`/`offset=`-bearing path to
// supabaseRequestAll, this test would fail with the real
// "already has an explicit limit/offset query parameter" error instead of
// silently passing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as claimRoute } from "@/app/api/extension/claim/route";
import { hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const CODE = "ABCD2345";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return { id: BATCH_ID, status: "pending_claim", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.EXTENSION_BATCH_SECRET = "z".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;

  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";

    // enforceRateLimit's own count-check + insert (lib/security/activity.ts).
    if (url.includes("assistant_rate_limits") && method === "GET") return jsonResponse([]);
    if (url.includes("assistant_rate_limits") && method === "POST") return new Response(null, { status: 201 });

    // The exact bounded lookup this regression is about — a real
    // PostgREST response to a `limit=1` GET (a plain JSON array, no
    // Content-Range pagination involved at all).
    if (url.includes("vinted_extension_batches") && url.includes("pairing_code_hash=eq.") && method === "GET") {
      return jsonResponse([batchRow()]);
    }

    // The atomic claiming PATCH.
    if (url.includes("vinted_extension_batches") && url.includes("status=eq.pending_claim") && method === "PATCH") {
      return jsonResponse([batchRow({ status: "claimed" })]);
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestWith(body: Record<string, unknown>) {
  return new Request("http://test/api/extension/claim", {
    method: "POST", headers: { "Content-Type": "application/json", origin: EXTENSION_ORIGIN }, body: JSON.stringify(body),
  });
}

describe("POST /api/extension/claim — real @/lib/supabase (fetch mocked only at the HTTP boundary)", () => {
  it("REGRESSION: a fresh, valid, pending pairing code claims successfully end-to-end through the REAL supabaseRequest/supabaseRequestAll implementations", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    const body = await response.json();
    if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}: ${JSON.stringify(body)}`);
    expect(response.status).toBe(200);
    expect(body.batchToken).toBeTruthy();
    expect(body.batchId).toBe(BATCH_ID);
  });

  it("REGRESSION: the bounded pairing-code lookup never uses supabaseRequestAll() — a call with an explicit limit= would make the REAL supabaseRequestAll() throw \"already has an explicit limit/offset query parameter\" (see lib/supabase.ts's own guard), turning into the generic 500 this bug originally produced", async () => {
    const response = await claimRoute(requestWith({ pairingCode: CODE }));
    expect(response.status).not.toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/limit\/offset|Could not claim this batch/);
  });

  it("REGRESSION (source-level): app/api/extension/claim/route.ts never imports or invokes supabaseRequestAll — only its own explanatory comment (documenting WHY not) mentions the name; the bounded lookup uses supabaseRequest() directly", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/extension/claim/route.ts", "utf8"));
    // Strip full-line "//" comments first — this file's own doc comment
    // deliberately explains "supabaseRequest(), NOT supabaseRequestAll()"
    // (including the trailing parens, as normal prose does), which would
    // otherwise false-positive-match an invocation-shaped regex. Only
    // actual CODE lines are checked below.
    const codeOnly = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toMatch(/import\s*\{[^}]*\bsupabaseRequestAll\b[^}]*\}\s*from\s*"@\/lib\/supabase"/);
    expect(codeOnly).not.toMatch(/supabaseRequestAll\s*[(<]/);
    expect(codeOnly).toMatch(/supabaseRequest\(\s*\n?\s*`vinted_extension_batches\?pairing_code_hash=eq\.\$\{codeHash\}[^`]*limit=1`/);
  });

  it("still enforces the limit=1 bound in the actual request sent to PostgREST", async () => {
    await claimRoute(requestWith({ pairingCode: CODE }));
    const lookupCall = fetchMock.mock.calls.find(call => String(call[0]).includes("pairing_code_hash=eq."));
    expect(lookupCall).toBeDefined();
    expect(String(lookupCall![0])).toContain("limit=1");
  });
});
