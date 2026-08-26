import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { imageRoles, listingDraftStatuses, listingAnalysisStages } from "@/lib/listing-studio/types";

const migration = readFileSync("supabase-listing-studio.sql", "utf8");

describe("supabase-listing-studio.sql — structural checks (consistent with tests/schema-migration-safety.test.ts's convention)", () => {
  it("creates all four tables idempotently", () => {
    for (const table of ["listing_drafts", "listing_draft_images", "listing_analysis_runs", "listing_status_history"]) {
      expect(migration).toContain(`create table if not exists public.${table}`);
    }
  });

  it("every table uses owner_id uuid, matching the app's single-owner convention (not user_id)", () => {
    // 4 core tables + vinted_category_selection_ai_calls (Milestone 7
    // follow-up, AI cost tracking — also owner_id-scoped) +
    // vinted_extension_batches (Milestone 7, Chrome extension draft
    // queue — also owner_id-scoped; vinted_extension_batch_items is
    // deliberately NOT owner_id-scoped itself, since ownership is already
    // established via its batch_id -> vinted_extension_batches -> owner_id chain).
    const ownerIdCount = migration.match(/owner_id uuid not null/g) ?? [];
    expect(ownerIdCount.length).toBe(6);
  });

  it("every table enables RLS with no policies, matching every RLS-enabled table in this repo, and revokes anon/authenticated access as defence in depth", () => {
    for (const table of ["listing_drafts", "listing_draft_images", "listing_analysis_runs", "listing_status_history"]) {
      expect(migration).toMatch(new RegExp(`alter table public\\.${table}\\s*\\nenable row level security`));
      expect(migration).toMatch(new RegExp(`revoke all\\s*\\non public\\.${table}\\s*\\nfrom anon,\\s*\\nauthenticated`));
    }
    expect(migration).not.toContain("create policy");
  });

  describe("Milestone 7 (Chrome extension draft queue) — vinted_extension_batches / vinted_extension_batch_items", () => {
    it("creates both tables idempotently", () => {
      expect(migration).toContain("create table if not exists public.vinted_extension_batches");
      expect(migration).toContain("create table if not exists public.vinted_extension_batch_items");
    });

    it("enables RLS with no new policies and revokes anon/authenticated, matching this file's newer (single-line) convention (see vinted_categories)", () => {
      for (const table of ["vinted_extension_batches", "vinted_extension_batch_items"]) {
        expect(migration).toContain(`alter table public.${table} enable row level security;`);
        expect(migration).toContain(`revoke all on public.${table} from anon, authenticated;`);
      }
    });

    it("never stores the plaintext pairing secret — only pairing_code_hash", () => {
      const tableSource = migration.slice(migration.indexOf("create table if not exists public.vinted_extension_batches"), migration.indexOf("create unique index if not exists vinted_extension_batches_pairing_code_hash_idx"));
      expect(tableSource).toContain("pairing_code_hash text not null");
      // No column literally named/typed to hold the raw code — only its hash.
      expect(tableSource).not.toMatch(/\bpairing_code\s+text/);
    });

    it("batch status and item status are both constrained to a fixed set", () => {
      expect(migration).toMatch(/status in \('pending_claim', 'claimed', 'in_progress', 'completed', 'expired', 'cancelled'\)/);
      expect(migration).toMatch(/status in \('queued', 'preparing', 'filling', 'saving', 'completed', 'failed', 'paused', 'cancelled'\)/);
    });

    it("listing_count is bounded to at most 5", () => {
      expect(migration).toMatch(/listing_count integer not null\s*\n\s*check \(listing_count between 1 and 5\)/);
    });

    it("batch_items has a unique constraint per (batch_id, draft_id) and per (batch_id, queue_position) — never a duplicate item or position within one batch", () => {
      const tableSource = migration.slice(migration.indexOf("create table if not exists public.vinted_extension_batch_items"), migration.indexOf("create index if not exists vinted_extension_batch_items_batch_idx"));
      expect(tableSource).toContain("unique (batch_id, draft_id)");
      expect(tableSource).toContain("unique (batch_id, queue_position)");
    });

    it("REGRESSION: vinted_draft_created_at (preserved from the ZIP-export migration) is never set by this section — only a future result-reporting route may set it, after Vinted itself confirms a draft exists", () => {
      const section = migration.slice(migration.indexOf("Milestone 7 (Chrome extension draft queue) — a completely separate"));
      expect(section).not.toMatch(/vinted_draft_created_at\s*=/);
    });
  });

  describe("Multi-batch support — display_number/dismissal columns, browser_label, and listing_studio_create_extension_batch", () => {
    const section = migration.slice(migration.indexOf("browser_label: a best-effort"));

    it("adds browser_label, display_number, box_dismissed_at, and activity_dismissed_at as idempotent ALTERs, never a fresh CREATE TABLE (this table already exists in production)", () => {
      expect(section).toContain("alter table public.vinted_extension_batches add column if not exists browser_label text;");
      expect(section).toContain("alter table public.vinted_extension_batches add column if not exists display_number integer;");
      expect(section).toContain("alter table public.vinted_extension_batches add column if not exists box_dismissed_at timestamptz;");
      expect(section).toContain("alter table public.vinted_extension_batches add column if not exists activity_dismissed_at timestamptz;");
    });

    it("backfills every pre-existing terminal batch as already box/activity-dismissed, so historical batches don't flood the new grid UI on first load", () => {
      expect(section).toMatch(/set box_dismissed_at = coalesce\(completed_at, created_at\), activity_dismissed_at = coalesce\(completed_at, created_at\)\s*\n\s*where box_dismissed_at is null and status in \('completed', 'cancelled', 'expired'\)/);
    });

    it("backfills display_number for any pre-existing non-terminal row before making the column NOT NULL, so an already-deployed database never ends up with a null display_number", () => {
      expect(section).toContain("where display_number is null");
      expect(section).toContain("alter table public.vinted_extension_batches alter column display_number set not null;");
    });

    it("REGRESSION: display_number uniqueness is a PARTIAL unique index scoped to box-visible rows only — a dismissed batch's old number must be reusable by a later batch", () => {
      expect(section).toMatch(/create unique index if not exists vinted_extension_batches_owner_display_number_idx\s*\n\s*on public\.vinted_extension_batches \(owner_id, display_number\)\s*\n\s*where box_dismissed_at is null;/);
    });

    it("listing_studio_create_extension_batch is serialized per-owner via a transaction-scoped advisory lock — never a row lock, since a brand-new owner's very first batch has no existing row to lock", () => {
      expect(section).toContain("perform pg_advisory_xact_lock(hashtext(p_owner_id::text));");
    });

    it("rejects an empty draft list with a distinct, classifiable error code before ever taking the advisory lock", () => {
      const nodraftsIndex = section.indexOf("raise exception 'NO_DRAFTS'");
      const lockIndex = section.indexOf("perform pg_advisory_xact_lock");
      expect(nodraftsIndex).toBeGreaterThan(-1);
      expect(nodraftsIndex).toBeLessThan(lockIndex);
    });

    it("REGRESSION: the 'draft already in another live batch' check spans BOTH the batch's own status and the item's own status — an item can be individually failed/cancelled while its batch is still in_progress with other items running, so checking only the batch's status would false-positive on that item", () => {
      expect(section).toMatch(/b\.status not in \('completed', 'cancelled', 'expired'\)\s*\n\s*and bi\.status not in \('completed', 'failed', 'cancelled'\)/);
      expect(section).toContain("raise exception 'DRAFT_ALREADY_IN_ACTIVE_BATCH'");
    });

    // Follow-up correction (live-caught): allocation is sequential-within-
    // a-run (max(visible)+1), never "lowest free gap" — see the RPC's own
    // comment for why gap-filling let long-abandoned historical rows
    // permanently squat on low numbers. Concrete scenario coverage lives
    // in the dedicated "display-number allocation rule" describe block
    // below (it mirrors this exact formula against every example in the
    // spec, since there is no live-Postgres harness in this test suite to
    // execute the RPC directly).
    it("allocates the next SEQUENTIAL display_number — coalesce(max(display_number), 0) + 1 over box-visible rows only — never generate_series/'lowest free gap' logic", () => {
      expect(section).toContain("select coalesce(max(ob.display_number), 0) + 1 into v_display_number");
      expect(section).toContain("from public.vinted_extension_batches ob");
      expect(section).not.toContain("generate_series");
    });

    // REGRESSION (live-caught, SQLSTATE 42702 "column reference
    // display_number is ambiguous"): this function's own `returns table
    // (batch_id uuid, display_number integer)` clause implicitly declares
    // batch_id/display_number as OUT parameters — plain PL/pgSQL variables
    // in scope for the WHOLE function body, not just the final
    // `batch_id := ...` / `display_number := ...` assignments near the
    // bottom. A bare `display_number` column read with no table alias is
    // ambiguous against that OUT parameter, and Postgres refuses the call
    // outright with SQLSTATE 42702 — every batch creation would fail. The
    // fix qualifies every genuine table-column read of display_number with
    // an explicit alias (`ob.display_number`); the OUT parameter itself is
    // only ever touched via a bare `display_number := ...` assignment,
    // which is unambiguous by construction (PL/pgSQL assignment targets
    // are never resolved as SQL column references). This test survives the
    // sequential-allocation rewrite unchanged, since the new formula still
    // reads the same real column and must stay qualified the same way.
    it("REGRESSION (SQLSTATE 42702): the display-number allocation reads the column via an explicit table alias, never bare — a bare `display_number` read would be ambiguous against this function's own RETURNS TABLE(display_number ...) OUT parameter", () => {
      const fnBodyStart = section.indexOf("create or replace function public.listing_studio_create_extension_batch");
      const fnBodyEnd = section.indexOf("$$;", section.indexOf("as $$", fnBodyStart));
      const fnSource = section.slice(fnBodyStart, fnBodyEnd);

      expect(fnSource).toContain("select coalesce(max(ob.display_number), 0) + 1 into v_display_number");
      // No bare "display_number" column read (unqualified by a table
      // alias) survives anywhere in the function body — this is the exact
      // shape of the live bug, and would fail identically wherever it
      // recurred, regardless of which specific query introduced it.
      expect(fnSource).not.toMatch(/\bselect\s+display_number\b/);
      expect(fnSource).not.toMatch(/max\(display_number\)/);
      // The OUT-parameter assignment itself is untouched and still
      // unqualified (correctly — it's not a column reference).
      expect(fnSource).toContain("display_number := v_display_number;");
    });

    // Same class of bug, defense-in-depth for the OTHER OUT parameter this
    // function's RETURNS TABLE declares. No current query in this function
    // reads a bare `batch_id` column (every join/lookup already uses a
    // table alias — see the DRAFT_ALREADY_IN_ACTIVE_BATCH test above), but
    // a future edit reintroducing one would hit the exact same SQLSTATE
    // 42702 failure mode this test would catch.
    it("REGRESSION (SQLSTATE 42702, batch_id): no bare, unqualified `batch_id` column reference exists in the function body either — every real batch_id column read is qualified with a table alias (bi.batch_id)", () => {
      const fnBodyStart = section.indexOf("create or replace function public.listing_studio_create_extension_batch");
      const fnBodyEnd = section.indexOf("$$;", section.indexOf("as $$", fnBodyStart));
      const fnSource = section.slice(fnBodyStart, fnBodyEnd);

      expect(fnSource).toContain("b.id = bi.batch_id");
      expect(fnSource).not.toMatch(/\bselect\s+batch_id\b/);
      expect(fnSource).not.toMatch(/\bwhere\s+batch_id\s*=/);
    });

    it("inserts the batch and every one of its items inside the SAME function body (one implicit transaction) — never two separate REST calls that could leave a batch with no items if the second failed", () => {
      const insertBatchIndex = section.indexOf("insert into public.vinted_extension_batches");
      const insertItemsIndex = section.indexOf("insert into public.vinted_extension_batch_items");
      const returnIndex = section.indexOf("return next;");
      expect(insertBatchIndex).toBeGreaterThan(-1);
      expect(insertItemsIndex).toBeGreaterThan(insertBatchIndex);
      expect(returnIndex).toBeGreaterThan(insertItemsIndex);
    });

    it("revokes anon/authenticated execute on the new RPC, matching every other RPC's own convention in this file", () => {
      expect(section).toContain("revoke all on function public.listing_studio_create_extension_batch(uuid, text, timestamptz, uuid[]) from public;");
      expect(section).toContain("revoke all on function public.listing_studio_create_extension_batch(uuid, text, timestamptz, uuid[]) from anon;");
      expect(section).toContain("revoke all on function public.listing_studio_create_extension_batch(uuid, text, timestamptz, uuid[]) from authenticated;");
    });

    // Follow-up correction — sequential-within-a-run numbering. There is
    // no live-Postgres harness in this test suite (every other test here
    // is structural, against the SQL source text), so this block proves
    // the ARITHMETIC itself against every scenario in the spec via a pure
    // mirror of the RPC's own formula, while the adjacent SQLSTATE-42702
    // test above already proves the DEPLOYED SQL genuinely implements
    // that exact formula (coalesce(max(ob.display_number), 0) + 1 over
    // box-visible rows) — together they cover both "is the rule right"
    // and "is the rule what's actually running".
    describe("display-number allocation rule — sequential within a run, resets only when no visible boxes remain", () => {
      function allocateNext(visibleDisplayNumbers: number[]): number {
        return visibleDisplayNumbers.length === 0 ? 1 : Math.max(...visibleDisplayNumbers) + 1;
      }

      it("no visible batch boxes allocates Batch 1", () => {
        expect(allocateNext([])).toBe(1);
      });

      it("visible Batch 1 allocates Batch 2", () => {
        expect(allocateNext([1])).toBe(2);
      });

      it("visible Batch 1 and Batch 2 allocates Batch 3", () => {
        expect(allocateNext([1, 2])).toBe(3);
      });

      it("Batch 1 dismissed while Batch 2 remains allocates Batch 3 — never goes backwards to reuse Batch 1", () => {
        expect(allocateNext([2])).toBe(3);
      });

      it("Batch 1 and Batch 3 visible allocates Batch 4", () => {
        expect(allocateNext([1, 3])).toBe(4);
      });

      it("visible Batch 2 only (Batch 1 already dismissed) allocates Batch 3", () => {
        expect(allocateNext([2])).toBe(3);
      });

      it("all boxes dismissed resets to Batch 1", () => {
        expect(allocateNext([])).toBe(1);
      });

      it("a gap in the visible numbers (2, 4) is never backfilled — allocates 5, matching the exact rule example", () => {
        expect(allocateNext([2, 4])).toBe(5);
      });

      it("historical dismissed rows (e.g. a leftover display_number as high as 54) never block a reset to Batch 1 — they're excluded from the visible set entirely by box_dismissed_at, regardless of how high their old number was", () => {
        // A dismissed row's display_number never enters this formula's
        // input at all (the SQL's own WHERE ob.box_dismissed_at is null
        // excludes it) — modelled here by simply never including it in
        // visibleDisplayNumbers, exactly as the real query would.
        expect(allocateNext([])).toBe(1);
        expect(allocateNext([2])).toBe(3); // a genuinely visible low number still drives the next allocation normally
      });
    });
  });

  it("listing_draft_images, listing_analysis_runs, and listing_status_history all cascade-delete when their draft is deleted", () => {
    // 3 core tables + vinted_category_selection_ai_calls (Milestone 7
    // follow-up — also cascade-deletes with its draft) +
    // vinted_extension_batch_items (Milestone 7, Chrome extension draft
    // queue — also cascade-deletes with its draft; vinted_extension_batches
    // itself references listing_drafts nowhere, only owner_id, so it's not
    // counted here).
    const cascadeCount = migration.match(/references public\.listing_drafts \(id\)\s*\n\s*on delete cascade/g) ?? [];
    expect(cascadeCount.length).toBe(5);
  });

  it("the status check constraint on listing_drafts matches lib/listing-studio/types.ts's listingDraftStatuses exactly", () => {
    for (const status of listingDraftStatuses) expect(migration).toContain(`'${status}'`);
  });

  it("Milestone 3: the listing_analysis_runs.stage constraint includes 'product_grouping', and is explicitly widened for an already-deployed database (not just the fresh-install table definition)", () => {
    expect(migration).toContain("'product_grouping'");
    expect(migration).toContain("alter table public.listing_analysis_runs drop constraint if exists listing_analysis_runs_stage_check;");
    expect(migration).toContain("alter table public.listing_analysis_runs add constraint listing_analysis_runs_stage_check");
  });

  describe("Follow-up correction (2026-08-06): listing_analysis_runs_stage_check must never regress — a rerun of this whole file against a live, populated database validates every ALTER's CHECK body against ALL existing rows, so an intermediate block whose list omits a stage older rows already use fails outright (the exact 'category_selection' migration failure this fixes)", () => {
    // Every `stage in (...)` block in the file — the fresh-install inline
    // check plus every widening ALTER — extracted independently, so a
    // regression that reintroduces a narrower intermediate block is
    // caught structurally, not just by string-containment of one value.
    const stageBlocks = [...migration.matchAll(/stage in \(([\s\S]*?)\)/g)].map(m => m[1]);

    it("finds at least one stage_in block (sanity check that the extraction pattern itself still matches the file)", () => {
      expect(stageBlocks.length).toBeGreaterThan(0);
    });

    it("every single stage_in block — the fresh-install table definition AND every widening ALTER — permits the COMPLETE current stage list, with no narrower intermediate version left in the file", () => {
      for (const block of stageBlocks) {
        for (const stage of listingAnalysisStages) expect(block).toContain(`'${stage}'`);
      }
    });

    it("'category_selection' (the historical stage whose omission from an intermediate block broke a live rerun) is permitted", () => {
      expect(listingAnalysisStages).toContain("category_selection");
      for (const block of stageBlocks) expect(block).toContain("'category_selection'");
    });

    it("'audience_reassessment' (the newest stage) is permitted", () => {
      expect(listingAnalysisStages).toContain("audience_reassessment");
      for (const block of stageBlocks) expect(block).toContain("'audience_reassessment'");
    });

    it("all five original Stage-1 pipeline stages remain permitted", () => {
      for (const stage of ["image_quality", "label_extraction", "visual_identification", "consistency_check", "generation"]) {
        for (const block of stageBlocks) expect(block).toContain(`'${stage}'`);
      }
    });

    it("REGRESSION: exactly ONE drop+add pair exists for listing_analysis_runs_stage_check — never a sequence of narrower-then-wider blocks that could re-narrow the constraint on a rerun", () => {
      const dropCount = (migration.match(/alter table public\.listing_analysis_runs drop constraint if exists listing_analysis_runs_stage_check;/g) ?? []).length;
      const addCount = (migration.match(/alter table public\.listing_analysis_runs add constraint listing_analysis_runs_stage_check/g) ?? []).length;
      expect(dropCount).toBe(1);
      expect(addCount).toBe(1);
    });

    it("matches lib/listing-studio/types.ts's listingAnalysisStages exactly — no SQL/TypeScript drift, and no stray value the TS enum doesn't know about", () => {
      for (const block of stageBlocks) {
        const quoted = [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
        expect(new Set(quoted)).toEqual(new Set(listingAnalysisStages));
      }
    });
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

  it("Milestone 6 (Vinted-aware colours/materials): listing_drafts gets colours (a text array) and material, added idempotently, without dropping the superseded free-text colour column", () => {
    expect(migration).toContain("alter table public.listing_drafts add column if not exists colours text[];");
    expect(migration).toContain("alter table public.listing_drafts add column if not exists material text;");
    expect(migration).toContain("alter table public.listing_drafts add column if not exists colour text;");
    expect(migration).not.toMatch(/drop column\s+colour\b/);
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

  it("Milestone 4 sizing coverage correction: listing_drafts gets source_size_gender, added idempotently, recording the category the label itself stated", () => {
    expect(migration).toContain("alter table public.listing_drafts add column if not exists source_size_gender text;");
  });

  it("Milestone 4 sizing coverage correction: listing_drafts gets uk_size_source, added idempotently, recording how uk_size was obtained (observed/brand_converted/fallback_converted/manual)", () => {
    expect(migration).toContain("alter table public.listing_drafts add column if not exists uk_size_source text;");
  });

  it("Milestone 5 (Listings Review): listing_drafts gets review_marked_ready_at, added idempotently — the one write Milestone 5 adds; Ready/Needs Review/Edited are otherwise computed, no other schema change", () => {
    expect(migration).toContain("alter table public.listing_drafts add column if not exists review_marked_ready_at timestamptz;");
  });

  it("useful indexes exist for the query patterns Saved Drafts needs (status filter, SKU search, per-draft image order, per-draft analysis history)", () => {
    expect(migration).toContain("listing_drafts_owner_status_idx");
    expect(migration).toContain("listing_drafts_owner_sku_idx");
    expect(migration).toContain("listing_draft_images_draft_order_idx");
    expect(migration).toContain("listing_analysis_runs_draft_stage_idx");
  });
});
