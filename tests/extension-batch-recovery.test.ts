import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { POST as recoverRoute } from "@/app/api/listing-studio/extension-batches/[batchId]/recover/route";
import { GET as listBatchesRoute, POST as createBatchRoute } from "@/app/api/listing-studio/extension-batches/route";
import { AuthError } from "@/lib/auth/server";
import { isBatchGenuinelyActive, classifyBatchForRecovery } from "@/lib/listing-studio/extension-batch-recovery";
import { computeExtensionWorkflowStatus } from "@/lib/listing-studio/extension-workflow-status";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const RECOVER_RPC_PATH = "rpc/listing_studio_recover_stuck_extension_batch";
const CREATE_RPC_PATH = "rpc/listing_studio_create_extension_batch";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";

function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }
function recoverRequest(body: Record<string, unknown> = {}) {
  return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function rpcRecoverResult(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify([{
    released_item_count: 0, preserved_completed_count: 0, batch_status: "cancelled", was_noop: false, ...overrides,
  }]), { status: 200 });
}
function rpcThrow(code: string, status = 409) {
  const error = new Error(`${code}: recovery refused`) as Error & { status: number };
  error.status = status;
  return error;
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
  requireOwner.mockClear();
  supabaseRequestAll.mockReset();
  supabaseRequest.mockReset();
  supabaseRequestAll.mockImplementation(async () => []);
  supabaseRequest.mockImplementation(async (path: string) => {
    if (path === RECOVER_RPC_PATH) return rpcRecoverResult();
    return new Response(null, { status: 204 });
  });
});

// ---------------------------------------------------------------------
// Pure helpers (lib/listing-studio/extension-batch-recovery.ts)
// ---------------------------------------------------------------------
describe("isBatchGenuinelyActive / classifyBatchForRecovery", () => {
  const NOW = Date.parse("2026-08-19T12:00:00.000Z");

  it("REQUIREMENT 1: a nonterminal batch with fresh activity, not yet expired, is genuinely active", () => {
    expect(isBatchGenuinelyActive({ status: "in_progress", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: "2026-08-19T11:55:00.000Z" }, NOW)).toBe(true);
  });

  it("REQUIREMENT 12: activity older than the stale window is not genuinely active — a fresh heartbeat is what prevents this, nothing else", () => {
    expect(isBatchGenuinelyActive({ status: "in_progress", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: "2026-08-19T11:00:00.000Z" }, NOW)).toBe(false);
  });

  it("null last_extension_activity_at (never any genuine report) is never genuinely active", () => {
    expect(isBatchGenuinelyActive({ status: "in_progress", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: null }, NOW)).toBe(false);
  });

  it("a batch past its own expires_at is never genuinely active, even with very recent activity", () => {
    expect(isBatchGenuinelyActive({ status: "in_progress", expiresAt: "2026-08-19T11:59:00.000Z", lastExtensionActivityAt: "2026-08-19T11:58:59.000Z" }, NOW)).toBe(false);
  });

  it("a terminal batch is never genuinely active regardless of any other field", () => {
    expect(isBatchGenuinelyActive({ status: "completed", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: "2026-08-19T11:59:59.000Z" }, NOW)).toBe(false);
  });

  it("REQUIREMENT 2: a hidden (box_dismissed_at set) nonterminal batch is recoverable", () => {
    const c = classifyBatchForRecovery({ status: "in_progress", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: "2026-08-19T11:59:00.000Z", boxDismissedAt: "2026-08-19T10:00:00.000Z" }, NOW);
    expect(c.isHidden).toBe(true);
    expect(c.isRecoverable).toBe(true);
  });

  it("a visible, genuinely active batch is NOT recoverable — REQUIREMENT: active visible batch remains protected", () => {
    const c = classifyBatchForRecovery({ status: "in_progress", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: "2026-08-19T11:59:00.000Z", boxDismissedAt: null }, NOW);
    expect(c.isRecoverable).toBe(false);
  });

  it("a visible but stale (no fresh activity) nonterminal batch IS recoverable, without needing to be hidden", () => {
    const c = classifyBatchForRecovery({ status: "in_progress", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: null, boxDismissedAt: null }, NOW);
    expect(c.isStale).toBe(true);
    expect(c.isHidden).toBe(false);
    expect(c.isRecoverable).toBe(true);
  });

  it("REQUIREMENT 16: a terminal batch is never recoverable regardless of dismissal", () => {
    const c = classifyBatchForRecovery({ status: "completed", expiresAt: "2026-08-19T12:30:00.000Z", lastExtensionActivityAt: null, boxDismissedAt: "2026-08-19T10:00:00.000Z" }, NOW);
    expect(c.isNonterminal).toBe(false);
    expect(c.isRecoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------
// supabase-listing-studio.sql — the recovery RPC itself
// ---------------------------------------------------------------------
describe("supabase-listing-studio.sql — listing_studio_recover_stuck_extension_batch", () => {
  const migration = readFileSync("supabase-listing-studio.sql", "utf8");
  const fnStart = migration.indexOf("create or replace function public.listing_studio_recover_stuck_extension_batch(");
  const fnEnd = migration.indexOf("revoke all on function public.listing_studio_recover_stuck_extension_batch", fnStart);
  const fn = migration.slice(fnStart, fnEnd);

  it("adds last_extension_activity_at idempotently", () => {
    expect(migration).toContain("alter table public.vinted_extension_batches add column if not exists last_extension_activity_at timestamptz;");
  });

  it("defines the RPC idempotently (create or replace) and this test found it", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(migration).toContain("create or replace function public.listing_studio_recover_stuck_extension_batch(");
  });

  it("REQUIREMENT: locks the batch row for update, scoped to owner_id, before any decision — ownership enforced structurally", () => {
    expect(fn).toMatch(/where id = p_batch_id and owner_id = p_owner_id\s*\n\s*for update/);
  });

  it("also locks the item rows in the same transaction before mutating them", () => {
    expect(fn).toContain("from public.vinted_extension_batch_items where batch_id = p_batch_id for update");
  });

  it("REQUIREMENT 11: raises BATCH_NOT_FOUND when nothing owner-scoped matches — never a distinct 'exists but not yours' signal", () => {
    expect(fn).toContain("raise exception 'BATCH_NOT_FOUND'");
  });

  it("REQUIREMENT: refuses ordinary recovery of a genuinely active batch (BATCH_STILL_ACTIVE) unless p_force", () => {
    expect(fn).toContain("raise exception 'BATCH_STILL_ACTIVE'");
    expect(fn).toMatch(/if v_genuinely_active and not p_force then/);
  });

  it("REQUIREMENT 12: genuine activity is computed from nonterminal status + not-yet-expired + a fresh last_extension_activity_at within 10 minutes", () => {
    expect(fn).toMatch(/v_batch\.status in \('pending_claim', 'claimed', 'in_progress'\)/);
    expect(fn).toContain("v_batch.expires_at > v_now");
    expect(fn).toContain("v_batch.last_extension_activity_at is not null");
    expect(fn).toContain("interval '10 minutes'");
  });

  it("REQUIREMENT 5: releases every nonterminal item status in one structural condition — queued/preparing/filling/saving/paused (incl. manual-reload) all at once", () => {
    const updates = fn.match(/update public\.vinted_extension_batch_items[\s\S]*?where batch_id = p_batch_id[\s\S]*?status not in \('completed', 'failed', 'cancelled'\);/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    expect(fn).toMatch(/WAITING_FOR_MANUAL_RELOAD/);
  });

  it("REQUIREMENT 6/7: a completed item (with or without a confirmed vinted_draft_id) is structurally excluded from every UPDATE — never touched, never fabricated", () => {
    const updateStatements = fn.match(/update public\.vinted_extension_batch_items[\s\S]*?;/g) ?? [];
    expect(updateStatements.length).toBeGreaterThan(0);
    for (const stmt of updateStatements) expect(stmt).toContain("status not in ('completed', 'failed', 'cancelled')");
    expect(fn).not.toMatch(/set\s+status\s*=\s*'completed'/);
    expect(fn).not.toMatch(/vinted_draft_id\s*=\s*'/); // never assigns a fabricated draft id anywhere
  });

  it("REQUIREMENT 6: counts preserved completed items as status='completed' AND a real, non-null vinted_draft_id — never merely 'completed'", () => {
    expect(fn).toMatch(/status = 'completed' and vinted_draft_id is not null/);
  });

  it("REQUIREMENT 8: clears current_step/step_detail so a recovered item can never keep showing a stale progress line", () => {
    expect(fn).toContain("current_step = null");
    expect(fn).toContain("step_detail = null");
  });

  it("marks a recovery-cancelled item with a distinct, honest error code — never silently indistinguishable from a genuine extension failure", () => {
    expect(fn).toContain("error_code = 'BATCH_RECOVERED'");
  });

  it("REQUIREMENT 9/17: never touches listing_drafts, listing_draft_images, or ANY delete statement — preserves every historical row", () => {
    expect(fn).not.toMatch(/listing_drafts|listing_draft_images/);
    expect(fn).not.toMatch(/delete\s+from/i);
  });

  it("REQUIREMENT 14/15: idempotent — a no-op branch exists for a batch with nothing left to release", () => {
    expect(fn).toContain("v_noop := true;");
    expect(fn).toMatch(/if v_released = 0 and v_batch\.status in \('completed', 'cancelled', 'expired'\) then/);
  });

  it("takes the same per-owner advisory lock convention as the create-batch RPC", () => {
    expect(fn).toContain("perform pg_advisory_xact_lock(hashtext(p_owner_id::text));");
  });

  it("revokes anon/authenticated execute, matching every other RPC in this schema", () => {
    expect(migration).toContain("revoke all on function public.listing_studio_recover_stuck_extension_batch(uuid, uuid, boolean) from public;");
    expect(migration).toContain("revoke all on function public.listing_studio_recover_stuck_extension_batch(uuid, uuid, boolean) from anon; end if;");
  });
});

// ---------------------------------------------------------------------
// POST /api/listing-studio/extension-batches/[batchId]/recover
// ---------------------------------------------------------------------
describe("POST /api/listing-studio/extension-batches/[batchId]/recover", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await recoverRoute(recoverRequest(), params());
    expect(response.status).toBe(401);
  });

  it("rejects an invalid batch id", async () => {
    const response = await recoverRoute(recoverRequest(), { params: Promise.resolve({ batchId: "not-a-uuid" }) });
    expect(response.status).toBe(400);
  });

  it("REQUIREMENT 3: recovers a hidden/orphaned batch and reports released/preserved counts", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === RECOVER_RPC_PATH) return rpcRecoverResult({ released_item_count: 4, preserved_completed_count: 1, batch_status: "cancelled" });
      return new Response(null, { status: 204 });
    });
    const response = await recoverRoute(recoverRequest(), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ releasedCount: 4, preservedCompletedCount: 1, batchStatus: "cancelled", wasNoop: false });
  });

  it("passes p_force through exactly as given — never defaults to true", async () => {
    await recoverRoute(recoverRequest({ force: true }), params());
    const call = supabaseRequest.mock.calls.find(c => c[0] === RECOVER_RPC_PATH);
    expect(JSON.parse((call![1] as RequestInit).body as string).p_force).toBe(true);
  });

  it("defaults p_force to false when not given", async () => {
    await recoverRoute(recoverRequest(), params());
    const call = supabaseRequest.mock.calls.find(c => c[0] === RECOVER_RPC_PATH);
    expect(JSON.parse((call![1] as RequestInit).body as string).p_force).toBe(false);
  });

  it("REQUIREMENT: a genuinely still-active batch refuses ordinary recovery with 409 + batch info", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === RECOVER_RPC_PATH) throw rpcThrow("BATCH_STILL_ACTIVE");
      return new Response(null, { status: 204 });
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) {
        return [{ id: BATCH_ID, status: "in_progress", display_number: 3, expires_at: "2099-01-01T00:00:00.000Z", box_dismissed_at: null, last_extension_activity_at: new Date().toISOString() }];
      }
      return [];
    });
    const response = await recoverRoute(recoverRequest(), params());
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.stillActive).toBe(true);
    expect(body.batch).toMatchObject({ batchId: BATCH_ID, isHidden: false });
  });

  it("REQUIREMENT 11: another owner's batch id is reported identically to a nonexistent one — never a distinct signal", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === RECOVER_RPC_PATH) throw rpcThrow("BATCH_NOT_FOUND", 404);
      return new Response(null, { status: 204 });
    });
    const response = await recoverRoute(recoverRequest(), params());
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/owner-1|displayNumber/);
  });

  it("REQUIREMENT 14/15: idempotent — recovering an already-terminal batch reports wasNoop and zero released, never an error", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === RECOVER_RPC_PATH) return rpcRecoverResult({ released_item_count: 0, preserved_completed_count: 0, batch_status: "cancelled", was_noop: true });
      return new Response(null, { status: 204 });
    });
    const response = await recoverRoute(recoverRequest(), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.wasNoop).toBe(true);
    expect(body.releasedCount).toBe(0);
  });

  it("scopes the RPC call to the authenticated owner id, never a client-supplied one", async () => {
    await recoverRoute(recoverRequest(), params());
    const call = supabaseRequest.mock.calls.find(c => c[0] === RECOVER_RPC_PATH);
    expect(JSON.parse((call![1] as RequestInit).body as string).p_owner_id).toBe("owner-1");
    expect(JSON.parse((call![1] as RequestInit).body as string).p_batch_id).toBe(BATCH_ID);
  });

  it("REQUIREMENT 17: the recover route itself never references listing_drafts or listing_draft_images", () => {
    const source = readFileSync("app/api/listing-studio/extension-batches/[batchId]/recover/route.ts", "utf8");
    expect(source).not.toMatch(/listing_drafts|listing_draft_images/);
  });
});

// ---------------------------------------------------------------------
// GET /api/listing-studio/extension-batches — the `recoverable` field
// ---------------------------------------------------------------------
describe("GET /api/listing-studio/extension-batches — hidden/stale active batch discovery", () => {
  it("REQUIREMENT 2: an active batch whose box was dismissed is recoverable+hidden, and excluded from the ordinary visible batchIds", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) {
        return [{ id: BATCH_ID, status: "in_progress", expires_at: "2099-01-01T00:00:00.000Z", display_number: 2, box_dismissed_at: "2026-08-19T09:00:00.000Z", last_extension_activity_at: null, listing_count: 5 }];
      }
      return [];
    });
    const response = await listBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([]);
    expect(body.recoverable).toHaveLength(1);
    expect(body.recoverable[0]).toMatchObject({ batchId: BATCH_ID, isHidden: true });
  });

  it("a nonterminal batch past its own expires_at with no recent activity is recoverable+stale even with box never dismissed", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) {
        return [{ id: BATCH_ID, status: "in_progress", expires_at: "2020-01-01T00:00:00.000Z", display_number: 1, box_dismissed_at: null, last_extension_activity_at: null, listing_count: 5 }];
      }
      return [];
    });
    const response = await listBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([]); // the original expiry-filter behaviour on batchIds is preserved unchanged
    expect(body.recoverable[0]).toMatchObject({ batchId: BATCH_ID, isStale: true, isHidden: false });
  });

  it("REQUIREMENT 16: a terminal, dismissed batch is neither visible nor recoverable", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) {
        return [{ id: BATCH_ID, status: "cancelled", expires_at: "2020-01-01T00:00:00.000Z", display_number: 1, box_dismissed_at: "2020-01-01T00:01:00.000Z", last_extension_activity_at: null, listing_count: 1 }];
      }
      return [];
    });
    const response = await listBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([]);
    expect(body.recoverable).toEqual([]);
  });

  it("a genuinely live, visible, fresh batch is neither excluded from batchIds nor listed as recoverable", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) {
        return [{ id: BATCH_ID, status: "in_progress", expires_at: "2099-01-01T00:00:00.000Z", display_number: 1, box_dismissed_at: null, last_extension_activity_at: new Date().toISOString(), listing_count: 1 }];
      }
      return [];
    });
    const response = await listBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([{ batchId: BATCH_ID, displayNumber: 1 }]);
    expect(body.recoverable).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// POST /api/listing-studio/extension-batches — structured blockingBatch info
// ---------------------------------------------------------------------
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, brand: "Nike", model: "Pegasus", product_type: "Trainers", colours: ["Black"], material: "Mesh",
    uk_size: "9", sku: "AA1711", condition: "Very Good Condition",
    generated_title: "Nike Pegasus Trainers", generated_description: "A great pair of trainers.",
    vinted_audience: "mens", vinted_category_id: 1906, vinted_category_status: "category_assigned",
    confirmed_price_pence: 4500, ...overrides,
  };
}
function categoryRow() {
  return { id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null };
}
function imageRow() { return { id: "img-1", draft_id: DRAFT_ID, upload_state: "uploaded" }; }
function createRequest(draftIds: string[]) {
  return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds }) });
}
function rpcCreateConflict() {
  const error = new Error("DRAFT_ALREADY_IN_ACTIVE_BATCH: conflict") as Error & { status: number };
  error.status = 409;
  return error;
}

describe("POST /api/listing-studio/extension-batches — error-message improvement (blockingBatch)", () => {
  beforeEach(() => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [imageRow()];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      if (path.startsWith("vinted_extension_batch_items?")) return [{ batch_id: "blocking-batch-1", draft_id: DRAFT_ID, status: "filling" }];
      if (path.startsWith("vinted_extension_batches?")) {
        return [{
          id: "blocking-batch-1", status: "in_progress", display_number: 4, expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z",
          box_dismissed_at: null, last_extension_activity_at: new Date().toISOString(),
        }];
      }
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === CREATE_RPC_PATH) throw rpcCreateConflict();
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
  });

  it("REQUIREMENT: names the real, owner-owned blocking batch — never just the generic message", async () => {
    const response = await createBatchRoute(createRequest([DRAFT_ID]));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/already part of another active batch/i);
    expect(body.blockingBatch).toMatchObject({ batchId: "blocking-batch-1", displayNumber: 4, isHidden: false, isStale: false });
  });

  it("a hidden blocking batch is reported as such", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [imageRow()];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      if (path.startsWith("vinted_extension_batch_items?")) return [{ batch_id: "blocking-batch-1", draft_id: DRAFT_ID, status: "queued" }];
      if (path.startsWith("vinted_extension_batches?")) {
        return [{
          id: "blocking-batch-1", status: "in_progress", display_number: 4, expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z",
          box_dismissed_at: "2026-08-01T00:05:00.000Z", last_extension_activity_at: null,
        }];
      }
      return [];
    });
    const response = await createBatchRoute(createRequest([DRAFT_ID]));
    const body = await response.json();
    expect(body.blockingBatch.isHidden).toBe(true);
  });

  it("REQUIREMENT 11: never exposes another owner's batch — the blocking-batch lookup is scoped to owner_id=eq.<user>", async () => {
    await createBatchRoute(createRequest([DRAFT_ID]));
    const call = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("vinted_extension_batches?") && (c[0] as string).includes("id=in."));
    expect(call![0]).toContain("owner_id=eq.owner-1");
  });

  it("returns blockingBatch: null when no owner-scoped conflict can be re-derived (a resolved race) — never throws", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [imageRow()];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await createBatchRoute(createRequest([DRAFT_ID]));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.blockingBatch).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Genuine-activity source boundary + workflow-status fallback
// ---------------------------------------------------------------------
describe("REQUIREMENT 13: page polling never counts as extension activity", () => {
  it("the owner-authenticated batch-list route only ever READS last_extension_activity_at (it has no PATCH/write handler at all) — it may legitimately select/return it, just never write it", () => {
    const listRoute = readFileSync("app/api/listing-studio/extension-batches/route.ts", "utf8");
    expect(listRoute).toContain("last_extension_activity_at"); // reads it, to classify recoverable batches
    expect(listRoute).not.toMatch(/method:\s*"PATCH"/); // GET (list) + POST (create) only — structurally cannot write any column
  });

  it("the owner-authenticated single-batch route's PATCH handler (dismiss_box/dismiss_activity) never sets last_extension_activity_at", () => {
    const statusRoute = readFileSync("app/api/listing-studio/extension-batches/[batchId]/route.ts", "utf8");
    const patchHandlerStart = statusRoute.indexOf("export async function PATCH(");
    expect(patchHandlerStart).toBeGreaterThan(-1);
    expect(statusRoute.slice(patchHandlerStart)).not.toContain("last_extension_activity_at");
  });

  it("only the extension-facing (bearer-token) routes ever write it", () => {
    const heartbeat = readFileSync("app/api/extension/batch/heartbeat/route.ts", "utf8");
    const itemResult = readFileSync("app/api/extension/batch/items/[itemId]/result/route.ts", "utf8");
    expect(heartbeat).toContain("last_extension_activity_at");
    expect(itemResult).toContain("last_extension_activity_at");
  });
});

describe("REQUIREMENT 9: a recovery-cancelled item's workflow status falls back to plain readiness", () => {
  it("computeExtensionWorkflowStatus returns null for a cancelled item, even against a cancelled batch — the listing then displays its real readiness status instead", () => {
    expect(computeExtensionWorkflowStatus("cancelled", "cancelled")).toBeNull();
  });
});
