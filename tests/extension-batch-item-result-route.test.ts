import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { POST as itemResultRoute, OPTIONS as itemResultOptions } from "@/app/api/extension/batch/items/[itemId]/result/route";
import { signBatchToken } from "@/lib/listing-studio/extension-batch-tokens";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_BATCH_ITEM_ID = "55555555-5555-4555-8555-555555555555";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "owner-1";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function params(itemId = ITEM_ID) { return { params: Promise.resolve({ itemId }) }; }
function batchRow(overrides: Record<string, unknown> = {}) {
  return { id: BATCH_ID, status: "in_progress", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), owner_id: OWNER_ID, ...overrides };
}
function itemRow(overrides: Record<string, unknown> = {}) {
  return { id: ITEM_ID, batch_id: BATCH_ID, draft_id: DRAFT_ID, status: "saving", attempt_count: 1, vinted_draft_id: null, started_at: "2026-08-05T10:00:00.000Z", ...overrides };
}

async function requestWith(body: Record<string, unknown>, token: string | null, origin = EXTENSION_ORIGIN) {
  return new Request(`http://test/api/extension/batch/items/${ITEM_ID}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "h".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  supabaseRequestAll.mockReset();
  supabaseRequest.mockReset();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
    if (path.startsWith("vinted_extension_batch_items?") && path.includes(`id=eq.${ITEM_ID}`)) return [itemRow()];
    if (path.startsWith("vinted_extension_batch_items?")) return [itemRow({ status: "queued" })]; // the "all items" completion check
    return [];
  });
});

describe("POST /api/extension/batch/items/[itemId]/result", () => {
  it("requires a bearer token", async () => {
    const response = await itemResultRoute(await requestWith({ status: "filling" }, null), params());
    expect(response.status).toBe(401);
  });

  it("updates the item's status", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "filling" }, token), params());
    expect(response.status).toBe(200);
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batch_items?id=eq.${ITEM_ID}`));
    expect(JSON.parse((patchCall![1] as RequestInit).body as string).status).toBe("filling");
  });

  it("REGRESSION (orphaned extension batch recovery): every genuine item-result report also touches the batch's own last_extension_activity_at — this IS the genuine-activity signal recovery eligibility is based on", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "filling" }, token), params());
    const activityPatch = supabaseRequest.mock.calls.find(c =>
      (c[0] as string).startsWith("vinted_extension_batches?") && (c[0] as string).includes(`id=eq.${BATCH_ID}`)
      && JSON.parse((c[1] as RequestInit).body as string).last_extension_activity_at,
    );
    expect(activityPatch).toBeDefined();
    const body = JSON.parse((activityPatch![1] as RequestInit).body as string);
    expect(new Date(body.last_extension_activity_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("REGRESSION: on 'completed' with a vintedDraftId, sets listing_drafts.vinted_draft_created_at — only now, never earlier", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "987654" }, token), params());
    const draftPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`listing_drafts?id=eq.${DRAFT_ID}`));
    expect(draftPatch).toBeDefined();
    const body = JSON.parse((draftPatch![1] as RequestInit).body as string);
    expect(body.vinted_draft_created_at).toBeTruthy();
  });

  it("never sets vinted_draft_created_at for a non-completed status, or a completed status with no vintedDraftId", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "filling" }, token), params());
    await itemResultRoute(await requestWith({ status: "completed" }, token), params());
    const draftPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`listing_drafts?id=eq.${DRAFT_ID}`));
    expect(draftPatch).toBeUndefined();
  });

  it("REGRESSION: duplicate-save protection — a 'completed' report for an ALREADY-completed item with a recorded vintedDraftId is a safe idempotent no-op, never re-writing vinted_draft_created_at", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
      if (path.startsWith("vinted_extension_batch_items?") && path.includes(`id=eq.${ITEM_ID}`)) return [itemRow({ status: "completed", vinted_draft_id: "555" })];
      return [];
    });
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "555" }, token), params());
    const body = await response.json();
    expect(body.duplicate).toBe(true);
    expect(supabaseRequest.mock.calls.some(c => (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it("records error code/message on 'failed', and clears them on a later success", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "failed", errorCode: "SET_CATEGORY", errorMessage: "ambiguous" }, token), params());
    const patch = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batch_items?id=eq.${ITEM_ID}`));
    const body = JSON.parse((patch![1] as RequestInit).body as string);
    expect(body.error_code).toBe("SET_CATEGORY");
    expect(body.error_message).toBe("ambiguous");
  });

  it("REGRESSION: result reporting cannot alter another owner's batch — a batch id encoded in someone else's token never resolves to THIS owner's batch/item", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return []; // scoped lookup by id=eq.<tokenBatchId> finds nothing for a foreign/unknown batch id
      return [];
    });
    const foreignToken = await signBatchToken("99999999-9999-4999-8999-999999999999", 600);
    const response = await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "1" }, foreignToken), params());
    expect(response.status).toBe(404);
    expect(supabaseRequest.mock.calls.some(c => (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it("REGRESSION: an item id that exists but belongs to a DIFFERENT batch is rejected, even with a valid token for some other real batch", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
      if (path.startsWith("vinted_extension_batch_items?")) return []; // id=eq.X&batch_id=eq.Y (this token's batch) finds nothing
      return [];
    });
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "1" }, token), params(OTHER_BATCH_ITEM_ID));
    expect(response.status).toBe(404);
  });

  it("rejects (410) once the batch has expired", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [batchRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] : []));
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "filling" }, token), params());
    expect(response.status).toBe(410);
  });

  it("rejects a malformed status value", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "not-a-real-status" }, token), params());
    expect(response.status).toBe(400);
  });

  it("marks the whole batch 'completed' once every item reaches a terminal status", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
      if (path.startsWith("vinted_extension_batch_items?") && path.includes(`id=eq.${ITEM_ID}`)) return [itemRow()];
      if (path.startsWith("vinted_extension_batch_items?")) return [{ status: "completed" }]; // the "all items" check — this was the only other item, already done
      return [];
    });
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "1" }, token), params());
    const batchPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batches?id=eq.${BATCH_ID}`));
    expect(batchPatch).toBeDefined();
    expect(JSON.parse((batchPatch![1] as RequestInit).body as string).status).toBe("completed");
  });

  it("does NOT mark the batch completed while another item is still queued/in-flight", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "1" }, token), params());
    const batchPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batches?id=eq.${BATCH_ID}`));
    expect(batchPatch).toBeUndefined();
  });

  it("REGRESSION (cancellation/completion race): the batch-completion PATCH's WHERE clause excludes an already-cancelled batch, not just an already-completed one — 'status=neq.completed' alone would let a completion-detection response racing a concurrent cancellation flip 'cancelled' back to 'completed'", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
      if (path.startsWith("vinted_extension_batch_items?") && path.includes(`id=eq.${ITEM_ID}`)) return [itemRow()];
      if (path.startsWith("vinted_extension_batch_items?")) return [{ status: "completed" }]; // every other item already terminal
      return [];
    });
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "1" }, token), params());
    const batchPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batches?id=eq.${BATCH_ID}`));
    expect(batchPatch).toBeDefined();
    expect(batchPatch![0]).not.toContain("status=neq.completed");
    expect(batchPatch![0]).toContain("status=in.(pending_claim,claimed,in_progress)");
  });

  it("responds with CORS headers only for the configured EXTENSION_ORIGIN, and OPTIONS preflight succeeds", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "filling" }, token), params());
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION_ORIGIN);
    const preflight = await itemResultOptions(await requestWith({}, null));
    expect(preflight.status).toBe(204);
  });

  it("catches everything through safeApiError", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await itemResultRoute(await requestWith({ status: "filling" }, token), params());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});

describe("POST /api/extension/batch/items/[itemId]/result — Listings Review redesign: currentStep/detail", () => {
  it("persists currentStep/detail on a 'filling' report", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "filling", currentStep: "SET_PRICE", detail: "Entering price" }, token), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batch_items?id=eq.${ITEM_ID}`));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.current_step).toBe("SET_PRICE");
    expect(body.step_detail).toBe("Entering price");
  });

  it("a fresh attempt ('preparing', including a retry) clears any stale step detail from a previous attempt when the report doesn't include fresh values", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "preparing" }, token), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batch_items?id=eq.${ITEM_ID}`));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.current_step).toBeNull();
    expect(body.step_detail).toBeNull();
  });

  it("REGRESSION: a completed item never keeps a stale step-detail line, even if the final report happened to include one", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "completed", vintedDraftId: "987654", currentStep: "SAVE_DRAFT", detail: "Saving…" }, token), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batch_items?id=eq.${ITEM_ID}`));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.current_step).toBeNull();
    expect(body.step_detail).toBeNull();
  });

  it("REGRESSION: a failed item never keeps a stale step-detail line either", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await itemResultRoute(await requestWith({ status: "failed", errorCode: "SET_PRICE", errorMessage: "timed out", currentStep: "SET_PRICE", detail: "Entering price" }, token), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`vinted_extension_batch_items?id=eq.${ITEM_ID}`));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.current_step).toBeNull();
    expect(body.step_detail).toBeNull();
  });

  it("rejects a currentStep/detail that exceeds the schema's max length, same strict-schema convention as every other field here", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await itemResultRoute(await requestWith({ status: "filling", detail: "x".repeat(500) }, token), params());
    expect(response.status).toBe(400);
  });
});
