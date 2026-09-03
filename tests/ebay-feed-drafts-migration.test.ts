import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase-ebay-feed-drafts.sql", "utf8");

// Structural (source-text) checks, not behavioural ones — this SQL is
// deliberately NOT applied to any real database this session (see the
// file's own header), so these verify the exact statements that WOULD run,
// matching the established pattern in tests/ebay-draft-batches-migration.test.ts.
const EBAY_FEED_FUNCTIONS = [
  { name: "listing_studio_create_ebay_feed_batch", signature: "listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[])" },
  { name: "listing_studio_latest_ebay_feed_status", signature: "listing_studio_latest_ebay_feed_status(uuid)" },
  { name: "listing_studio_claim_ebay_feed_batches", signature: "listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer)" },
  { name: "listing_studio_advance_ebay_feed_batch", signature: "listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer)" },
  { name: "listing_studio_finish_ebay_feed_batch_items", signature: "listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb)" },
  { name: "listing_studio_owners_with_claimable_ebay_feed_work", signature: "listing_studio_owners_with_claimable_ebay_feed_work(integer)" },
];

describe("supabase-ebay-feed-drafts.sql — schema safety conventions", () => {
  it("never issues a real SQL statement against the legacy ebay_draft_batches / ebay_draft_batch_items tables or their RPCs (mentioning them only in an explanatory comment is fine)", () => {
    expect(sql).not.toMatch(/\bpublic\.ebay_draft_batches\b/);
    expect(sql).not.toMatch(/\bpublic\.ebay_draft_batch_items\b/);
    expect(sql).not.toContain("listing_studio_create_ebay_draft_batch(");
    expect(sql).not.toContain("listing_studio_claim_ebay_draft_batch_items(");
  });

  it("every new table enables RLS and revokes anon/authenticated access", () => {
    for (const table of ["ebay_feed_batches", "ebay_feed_batch_items"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated;`);
    }
  });

  it("is idempotent — every table uses IF NOT EXISTS, every function uses CREATE OR REPLACE", () => {
    expect(sql).not.toMatch(/create table public\.\w+ \(/);
    expect((sql.match(/create table if not exists/g) || []).length).toBe(2);
    for (const fn of EBAY_FEED_FUNCTIONS) expect(sql).toContain(`create or replace function public.${fn.name}(`);
  });

  describe("function EXECUTE lockdown (every RPC, every exact signature)", () => {
    for (const fn of EBAY_FEED_FUNCTIONS) {
      it(`${fn.name}: revokes EXECUTE from public/anon/authenticated and explicitly grants it to service_role`, () => {
        expect(sql).toContain(`revoke all on function public.${fn.signature} from public;`);
        expect(sql).toContain(`revoke all on function public.${fn.signature} from anon;`);
        expect(sql).toContain(`revoke all on function public.${fn.signature} from authenticated;`);
        expect(sql).toContain(`grant execute on function public.${fn.signature} to service_role;`);
      });
    }

    it("the anon/authenticated revokes and the service_role grant are all guarded by pg_roles existence checks", () => {
      expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'anon') then");
      expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'authenticated') then");
      expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'service_role') then");
    });

    it("never grants EXECUTE to anon or authenticated anywhere in this file", () => {
      expect(sql).not.toMatch(/grant execute on function .* to anon;/);
      expect(sql).not.toMatch(/grant execute on function .* to authenticated;/);
    });
  });

  it("no SECURITY DEFINER function exists — every RPC runs with the caller's own (service_role) rights", () => {
    expect(sql).not.toMatch(/security definer/i);
  });

  it("a real eBay task ID can never be attached to two local batches — a genuine UNIQUE partial index, not just app-level hope", () => {
    expect(sql).toContain("create unique index if not exists ebay_feed_batches_task_id_idx");
    expect(sql).toContain("on public.ebay_feed_batches (ebay_task_id)");
    expect(sql).toContain("where ebay_task_id is not null;");
  });

  it("SKU is unique per batch — the same SKU can never appear twice in one upload", () => {
    expect(sql).toContain("unique (batch_id, sku)");
  });

  it("claim RPC (batch-level) uses FOR UPDATE SKIP LOCKED — two concurrent claims can never take the same batch", () => {
    expect(sql).toContain("for update of b skip locked");
  });

  it("claim RPC treats an expired lease as claimable again, with no separate manual-unstick action required", () => {
    expect(sql).toContain("b.claimed_at is null or b.lease_expires_at < v_now");
  });

  it("claim RPC never reclaims a terminal batch", () => {
    expect(sql).toContain("b.status not in ('completed', 'completed_with_errors', 'failed', 'cancelled')");
  });

  it("advance RPC rejects an unrecognised status rather than trusting the caller", () => {
    expect(sql).toContain("raise exception 'INVALID_STATUS' using errcode = 'P0001';");
  });

  it("advance RPC and finish-items RPC both reject a call that doesn't hold the current claim, rather than silently no-op-ing", () => {
    const advanceBody = sql.slice(sql.indexOf("create or replace function public.listing_studio_advance_ebay_feed_batch"), sql.indexOf("create or replace function public.listing_studio_finish_ebay_feed_batch_items"));
    expect(advanceBody).toContain("and b.claimed_by = p_claimed_by;");
    expect(advanceBody).toContain("raise exception 'CLAIM_NOT_HELD' using errcode = 'P0003';");

    const finishBody = sql.slice(sql.indexOf("create or replace function public.listing_studio_finish_ebay_feed_batch_items"), sql.indexOf("-- listing_studio_owners_with_claimable_ebay_feed_work"));
    expect(finishBody).toContain("where id = p_batch_id and claimed_by = p_claimed_by;");
    expect(finishBody).toContain("raise exception 'CLAIM_NOT_HELD' using errcode = 'P0003';");
  });

  it("advance RPC ALWAYS releases the claim (claimed_at/claimed_by/lease_expires_at all null), on a terminal status AND a non-terminal one alike — so the very next tick can immediately reclaim and continue", () => {
    const advanceBody = sql.slice(sql.indexOf("create or replace function public.listing_studio_advance_ebay_feed_batch"), sql.indexOf("create or replace function public.listing_studio_finish_ebay_feed_batch_items"));
    expect(advanceBody).toContain("lease_expires_at = null,\n      claimed_at = null,\n      claimed_by = null,");
  });

  it("finish-items RPC only ever writes a succeeded/failed status from the parsed result file, never an in-progress one", () => {
    const finishBody = sql.slice(sql.indexOf("create or replace function public.listing_studio_finish_ebay_feed_batch_items"), sql.indexOf("-- listing_studio_owners_with_claimable_ebay_feed_work"));
    expect(finishBody).toContain("and r.status in ('succeeded', 'failed');");
  });

  it("every batch-item foreign key cascades on delete — no orphan rows possible when a batch, draft or product is deleted", () => {
    expect(sql).toContain("references public.ebay_feed_batches (id)\n    on delete cascade");
    expect(sql).toContain("references public.listing_marketplace_drafts (id)\n    on delete cascade");
    expect(sql).toContain("references public.listing_drafts (id)\n    on delete cascade");
  });

  it("create RPC uses a distinct advisory-lock namespace from the legacy Inventory API pipeline", () => {
    expect(sql).toContain("hashtext(p_owner_id::text || ':ebay_feed')");
  });

  it("listing_count keeps the same conservative 1..25 cap as the legacy table, documented as this app's own choice", () => {
    expect(sql).toContain("check (listing_count between 1 and 25)");
  });

  it("adds ebay_feed_draft_created_at / ebay_feed_last_error additively to listing_marketplace_drafts, independent of the legacy ebay_offer_id/ebay_inventory_synced_at columns", () => {
    expect(sql).toContain("alter table public.listing_marketplace_drafts add column if not exists ebay_feed_draft_created_at timestamptz;");
    expect(sql).toContain("alter table public.listing_marketplace_drafts add column if not exists ebay_feed_last_error text;");
  });

  it("the status check constraint's vocabulary matches the Feed-stage state machine exactly, including every terminal status", () => {
    expect(sql).toContain("'queued', 'generating_csv', 'creating_task', 'uploading', 'processing',\n      'downloading_result', 'parsing_result',\n      'completed', 'completed_with_errors', 'failed', 'cancelled'");
  });
});
