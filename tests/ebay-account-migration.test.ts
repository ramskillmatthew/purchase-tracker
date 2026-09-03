import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(path, "utf8");
const sql = read("supabase-ebay-account-connection.sql");

describe("supabase-ebay-account-connection.sql — schema safety conventions", () => {
  it("every new table enables RLS and revokes anon/authenticated access, matching every other supabase-*.sql file", () => {
    for (const table of ["ebay_connections", "ebay_policies", "ebay_oauth_states", "ebay_connection_audit_events"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated;`);
    }
  });

  it("is idempotent — every table/index uses IF NOT EXISTS, safe to re-run", () => {
    expect(sql).not.toMatch(/create table public\.\w+ \(/); // never a bare CREATE TABLE without IF NOT EXISTS
    expect((sql.match(/create table if not exists/g) || []).length).toBe(4);
  });

  it("refresh/access tokens are stored encrypted, never plaintext columns", () => {
    expect(sql).toContain("encrypted_refresh_token text");
    expect(sql).toContain("encrypted_access_token text");
    expect(sql).not.toMatch(/\brefresh_token text\b/);
    expect(sql).not.toMatch(/\baccess_token text\b/);
  });

  it("one connection per owner+environment (unique constraint)", () => {
    expect(sql).toContain("unique (owner_id, environment)");
  });

  it("policy identity is (connection, type, eBay policy id) — never name-based", () => {
    expect(sql).toContain("unique (connection_id, policy_type, ebay_policy_id)");
  });

  it("policies default to EBAY_GB and are never hard-deleted (available flag, not DELETE)", () => {
    expect(sql).toContain("marketplace_id text not null default 'EBAY_GB'");
    expect(sql).toContain("available boolean not null default true");
  });

  it("OAuth state stores only a hash, is one-time (consumed_at), expiring, and owner/environment-bound", () => {
    expect(sql).toContain("state_hash text not null unique");
    expect(sql).toContain("consumed_at timestamptz");
    expect(sql).toContain("expires_at timestamptz not null");
    expect(sql).toContain("owner_id uuid not null");
  });

  it("state's return path is server-chosen, never open to client input (no column reads request body directly — enforced in code, but the column exists for it)", () => {
    expect(sql).toContain("return_path text not null default '/settings'");
  });

  it("never touches or reinterprets the existing listing_marketplace_settings_defaults postage/return/payment label columns (only ever mentioned in an explanatory comment, never a statement)", () => {
    expect(sql).not.toMatch(/alter table public\.listing_marketplace_settings_defaults/);
    expect(sql).not.toMatch(/create table if not exists public\.listing_marketplace_settings_defaults/);
  });
});
