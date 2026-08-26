import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { POST as heartbeatRoute, OPTIONS as heartbeatOptions } from "@/app/api/extension/batch/heartbeat/route";
import { signBatchToken } from "@/lib/listing-studio/extension-batch-tokens";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function request(token: string | null, origin = EXTENSION_ORIGIN) {
  return new Request("http://test/api/extension/batch/heartbeat", {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
  });
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "h".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  supabaseRequestAll.mockReset();
  supabaseRequest.mockReset();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_extension_batches?")) return [{ id: BATCH_ID, status: "in_progress" }];
    return [];
  });
});

describe("POST /api/extension/batch/heartbeat", () => {
  it("requires a bearer token", async () => {
    const response = await heartbeatRoute(request(null));
    expect(response.status).toBe(401);
  });

  it("REQUIREMENT: a genuine, bounded extension report touches last_extension_activity_at for a nonterminal batch", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await heartbeatRoute(request(token));
    expect(response.status).toBe(200);
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batches?id=eq.${BATCH_ID}`));
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(new Date(body.last_extension_activity_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("REGRESSION: a terminal batch is never touched — a heartbeat racing a batch's own completion/cancellation is a harmless no-op, not a stray write", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return [{ id: BATCH_ID, status: "completed" }];
      return [];
    });
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await heartbeatRoute(request(token));
    expect(response.status).toBe(200);
    expect(supabaseRequest.mock.calls.some(c => (c[0] as string).startsWith("vinted_extension_batches?"))).toBe(false);
  });

  it("404s for a batch that no longer exists", async () => {
    supabaseRequestAll.mockImplementation(async () => []);
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await heartbeatRoute(request(token));
    expect(response.status).toBe(404);
  });

  it("never advances any workflow state — the ONLY write is last_extension_activity_at, never status/current_step/etc", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await heartbeatRoute(request(token));
    for (const call of supabaseRequest.mock.calls) {
      if (!(call[0] as string).startsWith("vinted_extension_batches?")) continue;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(Object.keys(body)).toEqual(["last_extension_activity_at"]);
    }
  });

  it("responds to CORS preflight", async () => {
    const response = await heartbeatOptions(new Request("http://test/api/extension/batch/heartbeat", { method: "OPTIONS", headers: { origin: EXTENSION_ORIGIN } }));
    expect(response.status).toBe(204);
  });
});
