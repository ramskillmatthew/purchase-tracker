// eBay Seller Hub extension drafter — LIFECYCLE tests (stale-batch review).
//
// Same disclosed limitation as tests/ebay-extension-batch-migration.test.ts:
// this environment cannot execute PL/pgSQL against a real Postgres
// instance. The RPC-behaviour assertions below are STRUCTURAL — they parse
// the migration SQL's own text and assert the required control flow is
// present. The route-behaviour assertions are genuine (mocked RPC).
// Genuine end-to-end confirmation of the expiry/cancel semantics requires
// the user to apply the migration and exercise it against a real (or
// staging) database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const sql = readFileSync("supabase-ebay-extension-batches.sql", "utf8");
function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  return sql.slice(start, sql.indexOf("\n$$;", start));
}
const createBody = fnBody("listing_studio_create_ebay_extension_batch");
const expireBody = fnBody("listing_studio_expire_ebay_extension_batch");
const cancelBody = fnBody("listing_studio_cancel_ebay_extension_batch");

describe("stale-batch lifecycle — SQL: expiring an unclaimed batch releases its child (Defect scenario 1 + 8)", () => {
  it("listing_studio_expire_ebay_extension_batch exists and sets both the parent AND its still-live children", () => {
    expect(expireBody).toContain("update public.ebay_extension_batch_items bi");
    expect(expireBody).toContain("set status = 'cancelled', completed_at = now()");
    expect(expireBody).toContain("update public.ebay_extension_batches b");
    expect(expireBody).toContain("set status = 'expired', completed_at = coalesce(b.completed_at, now())");
  });

  it("the child update targets queued/preparing/filling (the statuses that occupy the duplicate-lock index) and excludes waiting_for_review", () => {
    const childUpdate = expireBody.slice(expireBody.indexOf("update public.ebay_extension_batch_items"), expireBody.indexOf("update public.ebay_extension_batches"));
    expect(childUpdate).toContain("bi.status in ('queued', 'preparing', 'filling')");
    expect(childUpdate).not.toContain("waiting_for_review");
  });

  it("REQUIREMENT 4: the expiry RPC is a hard no-op for any batch not currently 'pending_claim' — a claimed/in_progress/waiting_for_review batch is never touched by pairing-window expiry", () => {
    // Both the child and parent updates are gated on b.status = 'pending_claim'
    expect((expireBody.match(/b\.status = 'pending_claim'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(expireBody).not.toMatch(/b\.status (in|not in)[^'\n]*'claimed'/);
    // and on the pairing window genuinely having elapsed
    expect((expireBody.match(/b\.expires_at <= now\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("stale-batch lifecycle — SQL: atomicity + safe create-time cleanup (scenarios 2, 3, 7)", () => {
  it("REQUIREMENT 2: expiry is ONE plpgsql function (one implicit transaction) — parent and child updates cannot land independently", () => {
    // The whole expire body is a single function: no COMMIT, no nested BEGIN/subtransaction
    expect(expireBody).not.toMatch(/\bcommit\b/i);
    expect(expireBody.match(/\bbegin\b/gi)?.length).toBe(1); // just the plpgsql block opener
  });

  it("REQUIREMENT 3: the create RPC cleans up this owner's genuinely-expired, never-claimed batches for THIS listing BEFORE the conflict check", () => {
    const cleanupIdx = createBody.indexOf("LIFECYCLE FIX (stale-batch review): safe cleanup");
    const conflictIdx = createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(conflictIdx);
    // Scoped to this owner, this listing, still-pending-claim, genuinely expired
    const cleanup = createBody.slice(cleanupIdx, conflictIdx);
    expect(cleanup).toContain("b.owner_id = p_owner_id");
    expect(cleanup).toContain("b.status = 'pending_claim'");
    expect(cleanup).toContain("b.expires_at <= now()");
    expect(cleanup).toContain("x.marketplace_draft_id = v_marketplace_draft_id");
  });

  it("REQUIREMENT 7: the create-time cleanup runs under the SAME owner-scoped advisory lock as the rest of create — a concurrent create cannot interleave with another's expiry cleanup", () => {
    const lockIdx = createBody.indexOf("pg_advisory_xact_lock");
    const cleanupIdx = createBody.indexOf("LIFECYCLE FIX (stale-batch review): safe cleanup");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(lockIdx);
  });

  it("the create-time cleanup NEVER touches a claimed batch (scoped to status = 'pending_claim' only)", () => {
    // Only the actual UPDATE statements, never the surrounding comment
    // (which describes what must NOT happen and so mentions 'claimed'/
    // 'waiting_for_review' descriptively).
    const cleanup = createBody.slice(createBody.indexOf("LIFECYCLE FIX (stale-batch review): safe cleanup"), createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft"));
    const statements = cleanup.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/status (=|in|not in)[^\n]*'claimed'/);
    expect(statements).not.toContain("waiting_for_review");
    expect(statements).toMatch(/b\.status = 'pending_claim'/);
  });
});

describe("stale-batch lifecycle — SQL: explicit cancel releases the listing (scenarios 5, 6)", () => {
  it("REQUIREMENT 6/7: listing_studio_cancel_ebay_extension_batch cancels the parent AND every live child INCLUDING waiting_for_review", () => {
    const childUpdate = cancelBody.slice(cancelBody.indexOf("update public.ebay_extension_batch_items"), cancelBody.indexOf("update public.ebay_extension_batches"));
    expect(childUpdate).toContain("bi.status in ('queued', 'preparing', 'filling', 'waiting_for_review')");
    expect(cancelBody).toContain("set status = 'cancelled', completed_at = coalesce(b.completed_at, now())");
  });

  it("the cancel RPC is owner-checked — a batch belonging to a different owner is a hard no-op (no error, no info leak)", () => {
    expect((cancelBody.match(/b\.owner_id = p_owner_id/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const raiseLines = cancelBody.match(/raise exception[^;]*;/g) ?? [];
    for (const line of raiseLines) expect(line).not.toContain("p_batch_id");
  });

  it("REQUIREMENT 8: the cancel RPC touches ONLY the two extension tables — never listing_drafts, listing_marketplace_drafts, ebay_feed_batches, or any offer", () => {
    expect(cancelBody).not.toMatch(/listing_drafts|listing_marketplace_drafts|ebay_feed_batch|ebay_offer|inventory/i);
  });

  it("REQUIREMENT 5: 'waiting_for_review' still blocks a duplicate send — the create conflict query and the partial unique index both still treat it as live", () => {
    const conflictQuery = createBody.slice(createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft"), createBody.indexOf("limit 1"));
    expect(conflictQuery).toContain("bi.status not in ('failed', 'cancelled')");
    expect(conflictQuery).not.toContain("waiting_for_review");
    const idxStatement = sql.slice(sql.indexOf("ebay_extension_batch_items_live_draft_idx"), sql.indexOf(";", sql.indexOf("ebay_extension_batch_items_live_draft_idx")));
    expect(idxStatement).toContain("where status not in ('failed', 'cancelled')");
  });

  it("both new RPCs are service_role-only", () => {
    for (const sig of ["listing_studio_expire_ebay_extension_batch(uuid)", "listing_studio_cancel_ebay_extension_batch(uuid, uuid)"]) {
      const grantBlock = sql.slice(sql.indexOf(`revoke all on function public.${sig}`), sql.indexOf(`revoke all on function public.${sig}`) + 400);
      expect(grantBlock).toContain(`revoke all on function public.${sig} from anon, authenticated`);
      expect(grantBlock).toContain(`grant execute on function public.${sig} to service_role`);
    }
  });
});

describe("stale-batch lifecycle — the three separated lifetimes (requirement 5)", () => {
  it("the claim route expires via the atomic RPC, NEVER two independent PATCHes", () => {
    const source = readFileSync("app/api/extension/ebay-batch/claim/route.ts", "utf8");
    expect(source).toContain("rpc/listing_studio_expire_ebay_extension_batch");
    // The old two-step PATCH-to-expired is gone
    expect(source).not.toMatch(/PATCH[\s\S]{0,120}status: "expired"/);
  });

  it("the batch token's lifetime is the fixed EXTENSION-SESSION constant, decoupled from the pairing-code window (expires_at)", () => {
    const source = readFileSync("app/api/extension/ebay-batch/claim/route.ts", "utf8");
    expect(source).toContain("EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS");
    expect(source).toContain("signBatchToken(batch.id, EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS)");
    // the old expires_at-derived token life is gone
    expect(source).not.toMatch(/signBatchToken\([^)]*expires_at/);
  });

  it("REQUIREMENT 4: the payload / photo / result routes NO LONGER 410 a claimed batch merely because the pairing window elapsed — they gate on token + status only", () => {
    for (const path of [
      "app/api/extension/ebay-batch/route.ts",
      "app/api/extension/ebay-batch/photos/[itemId]/[position]/route.ts",
      "app/api/extension/ebay-batch/items/[itemId]/result/route.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/new Date\(batch\.expires_at\)\.getTime\(\) <= Date\.now\(\)/);
    }
  });

  it("EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS is materially longer than the pairing window, so a claimed mid-fill batch's session doesn't die with the pairing code", async () => {
    const schema = await import("@/lib/listing-studio/ebay-extension-batch-schema");
    expect(schema.EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS).toBeGreaterThan(schema.EBAY_EXTENSION_BATCH_EXPIRY_SECONDS * 4);
  });
});

// ---- Route behaviour: explicit cancel (both entry points) ------------------

const { requireOwner, supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "o@e.com" })),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [{ id: "batch-1", owner_id: "owner-1" }] as unknown[]),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

const BATCH_UUID = "11111111-1111-4111-8111-111111111111";

describe("stale-batch lifecycle — explicit Cancel routes call the atomic RPC (requirement 7)", () => {
  beforeEach(() => {
    process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
    process.env.EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";
    requireOwner.mockClear();
    supabaseRequest.mockClear();
    supabaseRequestAll.mockClear();
    supabaseRequest.mockResolvedValue(new Response("{}", { status: 200 }));
    supabaseRequestAll.mockResolvedValue([{ id: BATCH_UUID, owner_id: "owner-1" }]);
  });

  it("the owner-authenticated DELETE route calls listing_studio_cancel_ebay_extension_batch with the SESSION owner id", async () => {
    const { DELETE } = await import("@/app/api/listing-studio/ebay-extension-batches/[batchId]/route");
    const response = await DELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ batchId: BATCH_UUID }) });
    expect(response.status).toBe(200);
    const rpcCall = supabaseRequest.mock.calls.find(([path]) => String(path).startsWith("rpc/listing_studio_cancel_ebay_extension_batch"));
    expect(rpcCall).toBeTruthy();
    expect(JSON.parse(String((rpcCall![1] as RequestInit).body))).toMatchObject({ p_owner_id: "owner-1", p_batch_id: BATCH_UUID });
  });

  it("the owner-authenticated DELETE route derives the owner from the session — a spoofed body owner id has zero effect (it never reads the body at all)", async () => {
    const source = readFileSync("app/api/listing-studio/ebay-extension-batches/[batchId]/route.ts", "utf8");
    expect(source).not.toMatch(/request\.json\(\)/);
    expect(source).toContain("await requireOwner()");
  });

  it("the extension (batch-token) POST /cancel route resolves the owner from the batch row and calls the SAME RPC", async () => {
    const { POST } = await import("@/app/api/extension/ebay-batch/cancel/route");
    const { signBatchToken } = await import("@/lib/listing-studio/extension-batch-tokens");
    const token = await signBatchToken(BATCH_UUID, 3600);
    const response = await POST(new Request("http://test", { method: "POST", headers: { Authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    const rpcCall = supabaseRequest.mock.calls.find(([path]) => String(path).startsWith("rpc/listing_studio_cancel_ebay_extension_batch"));
    expect(rpcCall).toBeTruthy();
    expect(JSON.parse(String((rpcCall![1] as RequestInit).body))).toMatchObject({ p_owner_id: "owner-1", p_batch_id: BATCH_UUID });
  });

  it("STRUCTURAL: the extension /cancel route uses verifyBatchToken and never requireOwner (it has no owner session)", () => {
    const source = readFileSync("app/api/extension/ebay-batch/cancel/route.ts", "utf8");
    expect(source).toContain("verifyBatchToken");
    expect(source).not.toContain("requireOwner");
  });
});
