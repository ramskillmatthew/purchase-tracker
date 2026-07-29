import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { imageRoles, listingDraftStatuses } from "@/lib/listing-studio/types";

const migration = readFileSync("supabase-listing-studio.sql", "utf8");

describe("supabase-listing-studio.sql — structural checks (consistent with tests/schema-migration-safety.test.ts's convention)", () => {
  it("creates all four tables idempotently", () => {
    for (const table of ["listing_drafts", "listing_draft_images", "listing_analysis_runs", "listing_status_history"]) {
      expect(migration).toContain(`create table if not exists public.${table}`);
    }
  });

  it("every table uses owner_id uuid, matching the app's single-owner convention (not user_id)", () => {
    const ownerIdCount = migration.match(/owner_id uuid not null/g) ?? [];
    expect(ownerIdCount.length).toBe(4);
  });

  it("every table enables RLS with no policies, matching every RLS-enabled table in this repo, and revokes anon/authenticated access as defence in depth", () => {
    for (const table of ["listing_drafts", "listing_draft_images", "listing_analysis_runs", "listing_status_history"]) {
      expect(migration).toMatch(new RegExp(`alter table public\\.${table}\\s*\\nenable row level security`));
      expect(migration).toMatch(new RegExp(`revoke all\\s*\\non public\\.${table}\\s*\\nfrom anon,\\s*\\nauthenticated`));
    }
    expect(migration).not.toContain("create policy");
  });

  it("listing_draft_images, listing_analysis_runs, and listing_status_history all cascade-delete when their draft is deleted", () => {
    const cascadeCount = migration.match(/references public\.listing_drafts \(id\)\s*\n\s*on delete cascade/g) ?? [];
    expect(cascadeCount.length).toBe(3);
  });

  it("the status check constraint on listing_drafts matches lib/listing-studio/types.ts's listingDraftStatuses exactly", () => {
    for (const status of listingDraftStatuses) expect(migration).toContain(`'${status}'`);
  });

  it("the detected_role/confirmed_role check constraints match lib/listing-studio/types.ts's imageRoles exactly", () => {
    const roleConstraint = migration.slice(migration.indexOf("detected_role text"), migration.indexOf("ai_metadata_json"));
    for (const role of imageRoles) expect(roleConstraint).toContain(`'${role}'`);
  });

  it("price columns are non-negative and stored as integer pence, never numeric pounds", () => {
    expect(migration).toContain("suggested_price_pence integer");
    expect(migration).toContain("confirmed_price_pence integer");
    expect(migration).toContain("suggested_price_pence is null or suggested_price_pence >= 0");
  });

  it("storage_path is unique so the same path can never be double-assigned to two image rows", () => {
    expect(migration).toContain("storage_path text not null unique");
  });

  it("prompt_version is required on every analysis run (never silently unset)", () => {
    expect(migration).toContain("prompt_version text not null");
  });

  it("schema_version is also required, versioned independently of prompt_version", () => {
    expect(migration).toContain("schema_version text not null");
  });

  it("field_data_json is the single source of truth for field confirmation state — there is no separate confirmed_fields_json column", () => {
    expect(migration).toContain("field_data_json jsonb not null default '{}'::jsonb");
    expect(migration).not.toContain("confirmed_fields_json");
  });

  it("creates the private listing-drafts storage bucket idempotently, not public", () => {
    expect(migration).toContain("insert into storage.buckets (id, name, public)");
    expect(migration).toContain("values ('listing-drafts', 'listing-drafts', false)");
    expect(migration).toContain("on conflict (id) do nothing");
  });

  it("documents the manual dashboard fallback in case the SQL editor role can't insert into storage.buckets", () => {
    expect(migration).toMatch(/Dashboard -> Storage -> New bucket/);
  });

  it("does not attempt to create storage.objects RLS policies (none are needed for the service-role-signs-narrow-paths architecture)", () => {
    expect(migration).not.toMatch(/create policy[\s\S]*storage\.objects/i);
  });

  it("useful indexes exist for the query patterns Saved Drafts needs (status filter, SKU search, per-draft image order, per-draft analysis history)", () => {
    expect(migration).toContain("listing_drafts_owner_status_idx");
    expect(migration).toContain("listing_drafts_owner_sku_idx");
    expect(migration).toContain("listing_draft_images_draft_order_idx");
    expect(migration).toContain("listing_analysis_runs_draft_stage_idx");
  });
});
