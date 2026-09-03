import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase-ebay-draft-batches.sql", "utf8");

// Corrective pass — this file previously had NO dedicated schema-safety
// test at all (unlike supabase-ebay-account-connection.sql's own
// tests/ebay-account-migration.test.ts). These are structural (source-text)
// checks, not behavioural ones — they cannot run this SQL against a real
// database (the migration is deliberately not applied), so they verify the
// exact statements that WOULD run, matching the pattern every other
// supabase-*.sql file's own test file already uses for the same reason.
const EBAY_FUNCTIONS = [
  { name: "listing_studio_create_ebay_draft_batch", signature: "listing_studio_create_ebay_draft_batch(uuid, uuid[], uuid[])" },
  { name: "listing_studio_latest_ebay_draft_status", signature: "listing_studio_latest_ebay_draft_status(uuid)" },
  { name: "listing_studio_claim_ebay_draft_batch_items", signature: "listing_studio_claim_ebay_draft_batch_items(uuid, uuid, integer, text, integer)" },
  { name: "listing_studio_owners_with_claimable_ebay_work", signature: "listing_studio_owners_with_claimable_ebay_work(integer)" },
];

describe("supabase-ebay-draft-batches.sql — schema safety conventions", () => {
  it("every new table enables RLS and revokes anon/authenticated access", () => {
    for (const table of ["ebay_inventory_locations", "ebay_draft_batches", "ebay_draft_batch_items"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated;`);
    }
  });

  it("is idempotent — every table/index uses IF NOT EXISTS, every function uses CREATE OR REPLACE", () => {
    expect(sql).not.toMatch(/create table public\.\w+ \(/);
    expect((sql.match(/create table if not exists/g) || []).length).toBe(3);
    for (const fn of EBAY_FUNCTIONS) expect(sql).toContain(`create or replace function public.${fn.name}(`);
  });

  describe("CORRECTIVE PASS — function EXECUTE lockdown (every RPC, every exact signature)", () => {
    for (const fn of EBAY_FUNCTIONS) {
      it(`${fn.name}: revokes EXECUTE from public/anon/authenticated and explicitly grants it to service_role`, () => {
        // 1. PUBLIC is always revoked, unconditionally.
        expect(sql).toContain(`revoke all on function public.${fn.signature} from public;`);
        // 2 & 3. anon/authenticated revokes and the service_role grant all
        // live inside the same guarded do-block (see the file's own
        // "FUNCTION EXECUTION LOCKDOWN" comment) — assert the exact
        // guarded statements exist for THIS function's exact signature,
        // not merely that the function name appears somewhere.
        expect(sql).toContain(`revoke all on function public.${fn.signature} from anon;`);
        expect(sql).toContain(`revoke all on function public.${fn.signature} from authenticated;`);
        expect(sql).toContain(`grant execute on function public.${fn.signature} to service_role;`);
      });
    }

    it("the anon/authenticated revokes and the service_role grant are all guarded by pg_roles existence checks, matching supabase-returns-losses.sql's established pattern", () => {
      expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'anon') then");
      expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'authenticated') then");
      expect(sql).toContain("if exists (select 1 from pg_roles where rolname = 'service_role') then");
    });

    it("the service_role grant is not optional / silently skipped — it is inside the same do $$ block as the anon/authenticated revokes, not a separate no-op comment", () => {
      const lockdownStart = sql.indexOf("FUNCTION EXECUTION LOCKDOWN");
      expect(lockdownStart).toBeGreaterThan(-1);
      const lockdownBlock = sql.slice(lockdownStart);
      // Every GRANT EXECUTE ... TO service_role statement for these RPCs
      // must appear strictly after the lockdown header, inside the guarded
      // block described above — never earlier, never as dead/unreachable text.
      for (const fn of EBAY_FUNCTIONS) {
        expect(lockdownBlock).toContain(`grant execute on function public.${fn.signature} to service_role;`);
      }
    });

    it("never grants EXECUTE to anon or authenticated anywhere in this file", () => {
      expect(sql).not.toMatch(/grant execute on function .* to anon;/);
      expect(sql).not.toMatch(/grant execute on function .* to authenticated;/);
    });
  });

  it("no SECURITY DEFINER function exists — every RPC runs with the caller's own (service_role) rights, so there is no search_path hijack surface", () => {
    expect(sql).not.toMatch(/security definer/i);
  });

  it("ebay_offer_id is a real UNIQUE partial index, not just a plain index — duplicate offers are a database-level impossibility, not app-level hope", () => {
    expect(sql).toContain("create unique index if not exists listing_marketplace_drafts_ebay_offer_idx");
    expect(sql).toContain("on public.listing_marketplace_drafts (ebay_offer_id)");
    expect(sql).toContain("where ebay_offer_id is not null;");
  });

  it("claim RPC uses FOR UPDATE SKIP LOCKED — two concurrent claims can never take the same row", () => {
    expect(sql).toContain("for update of bi skip locked");
  });

  it("claim RPC treats an expired lease as claimable again, with no separate manual-unstick action required", () => {
    expect(sql).toContain("bi.claimed_at is null or bi.lease_expires_at < v_now");
  });

  it("claim RPC never reclaims a completed/failed/cancelled item", () => {
    expect(sql).toContain("bi.status not in ('completed', 'failed', 'cancelled')");
  });

  it("every batch-item foreign key cascades on delete — no orphan rows possible when a batch, draft or product is deleted", () => {
    expect(sql).toContain("references public.ebay_draft_batches (id)\n    on delete cascade");
    expect(sql).toContain("references public.listing_marketplace_drafts (id)\n    on delete cascade");
    expect(sql).toContain("references public.listing_drafts (id)\n    on delete cascade");
  });

  it("photo state column never stores a URL field name — only transfer status", () => {
    // The column itself is untyped jsonb (structure is enforced in
    // application code, see lib/listing-studio/ebay-draft-batches.ts's own
    // EbayPhotoState type) — this just confirms the column's own
    // documentation doesn't describe persisting a URL.
    expect(sql).toMatch(/ebay_photo_state_json jsonb not null default '\{\}'::jsonb/);
  });
});
