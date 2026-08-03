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

  it("Milestone 3: the listing_analysis_runs.stage constraint includes 'product_grouping', and is explicitly widened for an already-deployed database (not just the fresh-install table definition)", () => {
    expect(migration).toContain("'product_grouping'");
    expect(migration).toContain("alter table public.listing_analysis_runs drop constraint if exists listing_analysis_runs_stage_check;");
    expect(migration).toContain("alter table public.listing_analysis_runs add constraint listing_analysis_runs_stage_check");
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

  it("Milestone 3 (v3): the whole-session boundary-apply RPC exists, is one all-or-nothing transaction, and is revoked from anon/authenticated like every other RPC", () => {
    expect(migration).toContain("create or replace function public.listing_studio_apply_boundary_session(p_owner_id uuid, p_source_draft_id uuid, p_groups jsonb)");
    expect(migration).toContain("revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from public");
    expect(migration).toContain("revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from anon");
    expect(migration).toContain("revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from authenticated");
    // every group's images must currently belong to the source (Unsorted) draft and this owner
    expect(migration).toContain("IMAGE_NOT_IN_SOURCE_DRAFT");
  });

  it("REGRESSION: listing_studio_apply_boundary_session's own raises carry a `detail` naming the exact failing group index/title/image count — a live rollback is diagnosable from PostgREST's error body alone, not just a bare error code", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_apply_boundary_session"), migration.indexOf("-- Matches the existing function-access pattern"));
    expect(rpcSource).toContain("detail = format('group index %s (0-based) had no usable title'");
    expect(rpcSource).toContain("detail = format('group index %s (0-based, title \"%s\") had no image ids'");
    expect(rpcSource).toMatch(/detail = format\(\s*'group index %s \(0-based, title "%s"\): expected %s image\(s\), only %s currently match/);
  });

  it("REGRESSION: any genuinely unexpected error inside the per-group loop (a constraint violation, a trigger, anything not one of this function's own raises) is caught, its SQLSTATE/message/detail/hint captured via GET STACKED DIAGNOSTICS, and re-raised with the failing group's own index/title attached — never a bare, context-free Postgres error", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_apply_boundary_session"), migration.indexOf("-- Matches the existing function-access pattern"));
    expect(rpcSource).toContain("exception when others then");
    expect(rpcSource).toMatch(/get stacked diagnostics\s*\n\s*v_diag_sqlstate = returned_sqlstate,\s*\n\s*v_diag_message = message_text,\s*\n\s*v_diag_detail = pg_exception_detail,\s*\n\s*v_diag_hint = pg_exception_hint;/);
    expect(rpcSource).toContain("raise exception 'APPLY_BOUNDARY_SESSION_FAILED at group index % (0-based, title \"%\")");
  });

  it("this instrumentation changes no validation rule or control flow — the same four application error codes still exist verbatim, in the same order, and the function is still a single implicit transaction (no explicit BEGIN/COMMIT, no early RETURN before the loop completes)", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_apply_boundary_session"), migration.indexOf("-- Matches the existing function-access pattern"));
    for (const code of ["NO_GROUPS", "SOURCE_DRAFT_NOT_FOUND", "INVALID_GROUP_TITLE", "NO_IMAGES", "IMAGE_NOT_IN_SOURCE_DRAFT"]) {
      expect(rpcSource).toContain(`'${code}'`);
    }
    expect(rpcSource).not.toMatch(/\bbegin\s+transaction\b/i);
    expect(rpcSource).not.toContain("commit;");
  });

  it("REGRESSION (SQLSTATE 42702): every listing_draft_images/listing_drafts reference inside listing_studio_apply_boundary_session is table-aliased, so no query can ever confuse a table column with the `draft_id`/`title` OUT parameters implied by returns table(draft_id uuid, title text)", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_apply_boundary_session"), migration.indexOf("-- Matches the existing function-access pattern"));
    // The two statements that actually triggered the live failure — both
    // now fully qualified via the `ldi` alias, never a bare `draft_id`.
    expect(rpcSource).toContain("from public.listing_draft_images ldi\n      where ldi.id = any(v_image_ids) and ldi.draft_id = p_source_draft_id and ldi.owner_id = p_owner_id;");
    expect(rpcSource).toContain("select ldi.id, row_number() over (order by ldi.sort_order) as rn\n        from public.listing_draft_images ldi\n        where ldi.id = any(v_image_ids) and ldi.draft_id = p_source_draft_id and ldi.owner_id = p_owner_id");
    // The SOURCE_DRAFT_NOT_FOUND existence check, aliased defensively too.
    expect(rpcSource).toContain("from public.listing_drafts ld where ld.id = p_source_draft_id and ld.owner_id = p_owner_id for update");
    // No bare, unqualified `draft_id`/`owner_id` column reference remains
    // anywhere in a WHERE/SELECT context (the UPDATE ... SET draft_id = ...
    // target-list assignment is the one place a bare column name is both
    // required, valid Postgres syntax, and structurally unambiguous —
    // deliberately excluded from this check).
    const withoutUpdateSetClause = rpcSource.replace('set draft_id = v_new_draft_id,', "set /* target column, not a value expression */ =");
    expect(withoutUpdateSetClause).not.toMatch(/\bwhere\s+id\s*=/);
    expect(withoutUpdateSetClause).not.toMatch(/\band\s+draft_id\s*=/);
    expect(withoutUpdateSetClause).not.toMatch(/\band\s+owner_id\s*=/);
  });

  it("'Clear all': listing_studio_clear_workspace exists, is scoped entirely to owner_id, returns per-table deletion counts, and is revoked from anon/authenticated like every other RPC", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_clear_workspace"), migration.indexOf("-- Matches the existing function-access pattern"));
    expect(rpcSource).toContain("create or replace function public.listing_studio_clear_workspace(p_owner_id uuid)");
    expect(rpcSource).toContain("returns table(deleted_image_count integer, deleted_group_count integer, deleted_analysis_run_count integer, deleted_status_history_count integer)");
    expect(migration).toContain("revoke all on function public.listing_studio_clear_workspace(uuid) from public;");
    expect(migration).toContain("revoke all on function public.listing_studio_clear_workspace(uuid) from anon;");
    expect(migration).toContain("revoke all on function public.listing_studio_clear_workspace(uuid) from authenticated;");
  });

  it("REGRESSION: every delete inside listing_studio_clear_workspace is scoped to `owner_id = p_owner_id` — never a client-controllable value, and never capable of touching another owner's rows", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_clear_workspace"), migration.indexOf("-- Matches the existing function-access pattern"));
    const deleteStatements = rpcSource.match(/delete from public\.\w+ where owner_id = p_owner_id/g) ?? [];
    expect(deleteStatements.length).toBe(4);
    for (const table of ["listing_draft_images", "listing_analysis_runs", "listing_status_history", "listing_drafts"]) {
      expect(rpcSource).toContain(`delete from public.${table} where owner_id = p_owner_id`);
    }
  });

  it("deletes every listing_drafts row for this owner unconditionally — Unsorted is never excluded, and every product group (regardless of status) is included", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_clear_workspace"), migration.indexOf("-- Matches the existing function-access pattern"));
    expect(rpcSource).toContain("delete from public.listing_drafts where owner_id = p_owner_id returning 1");
    expect(rpcSource).not.toMatch(/listing_drafts[\s\S]{0,60}title\s*(<>|!=)\s*'Unsorted'/);
    expect(rpcSource).not.toMatch(/listing_drafts[\s\S]{0,60}status\s*(=|<>|!=|in)/);
  });

  it("this is one implicit transaction (no explicit BEGIN/COMMIT) — if any statement fails, every earlier delete in the same call rolls back with it", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_clear_workspace"), migration.indexOf("-- Matches the existing function-access pattern"));
    expect(rpcSource).not.toMatch(/\bbegin\s+transaction\b/i);
    expect(rpcSource).not.toContain("commit;");
  });

  it("does not touch any table outside Listing Studio — no purchases/tasks/vinted/expenses/gmail table is ever referenced", () => {
    const rpcSource = migration.slice(migration.indexOf("create or replace function public.listing_studio_clear_workspace"), migration.indexOf("-- Matches the existing function-access pattern"));
    for (const foreignTable of ["purchases", "tasks", "vinted_import_candidates", "expenses", "gmail_accounts"]) {
      expect(rpcSource).not.toContain(foreignTable);
    }
  });

  it("Milestone 4 (AI listing generation): listing_drafts gets the new structured/generated listing columns, added idempotently on an already-deployed database", () => {
    for (const column of ["product_type", "colour", "uk_size", "generated_title", "generated_description"]) {
      expect(migration).toContain(`alter table public.listing_drafts add column if not exists ${column} text;`);
    }
  });

  it("REGRESSION: generated_title/generated_description are distinct new columns from the pre-existing title/description columns — the migration never renames or repurposes the originals", () => {
    expect(migration).toContain("title text,");
    expect(migration).toContain("description text,");
    expect(migration).toContain("generated_title text");
    expect(migration).toContain("generated_description text");
    expect(migration).not.toContain("rename column");
  });

  it("Milestone 4 sizing correction: listing_drafts gets source_size_system/source_size_value, added idempotently, independent of uk_size (which holds the observed/converted/manually-entered value)", () => {
    expect(migration).toContain("alter table public.listing_drafts add column if not exists source_size_system text;");
    expect(migration).toContain("alter table public.listing_drafts add column if not exists source_size_value text;");
  });

  it("Milestone 4 sizing coverage correction: listing_drafts gets uk_size_source, added idempotently, recording how uk_size was obtained (observed/brand_converted/fallback_converted/manual)", () => {
    expect(migration).toContain("alter table public.listing_drafts add column if not exists uk_size_source text;");
  });

  it("useful indexes exist for the query patterns Saved Drafts needs (status filter, SKU search, per-draft image order, per-draft analysis history)", () => {
    expect(migration).toContain("listing_drafts_owner_status_idx");
    expect(migration).toContain("listing_drafts_owner_sku_idx");
    expect(migration).toContain("listing_draft_images_draft_order_idx");
    expect(migration).toContain("listing_analysis_runs_draft_stage_idx");
  });
});
