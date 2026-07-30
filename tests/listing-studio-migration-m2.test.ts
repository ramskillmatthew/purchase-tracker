import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase-listing-studio.sql", "utf8");

describe("supabase-listing-studio.sql — Milestone 2 additions", () => {
  it("adds upload_state with the four expected values, defaulting to pending", () => {
    expect(migration).toContain("upload_state text not null default 'pending'");
    expect(migration).toContain("check (upload_state in ('pending', 'uploading', 'uploaded', 'failed'))");
  });

  it("adds preview_available, defaulting true (JPG/PNG/WEBP always have a preview)", () => {
    expect(migration).toContain("preview_available boolean not null default true");
  });

  it("defines all four Milestone 2 RPCs", () => {
    for (const fn of ["listing_studio_move_images", "listing_studio_reorder_images", "listing_studio_split_group", "listing_studio_merge_groups"]) {
      expect(migration).toContain(`create or replace function public.${fn}`);
    }
  });

  it("every RPC re-verifies ownership itself (owner_id = p_owner_id) rather than trusting the caller's ids alone", () => {
    const moveFn = migration.slice(migration.indexOf("function public.listing_studio_move_images"), migration.indexOf("function public.listing_studio_reorder_images"));
    const reorderFn = migration.slice(migration.indexOf("function public.listing_studio_reorder_images"), migration.indexOf("function public.listing_studio_split_group"));
    const splitFn = migration.slice(migration.indexOf("function public.listing_studio_split_group"), migration.indexOf("function public.listing_studio_merge_groups"));
    const mergeFn = migration.slice(migration.indexOf("function public.listing_studio_merge_groups"), migration.indexOf("-- Matches the existing function-access pattern"));
    for (const fn of [moveFn, reorderFn, splitFn, mergeFn]) {
      expect(fn).toMatch(/owner_id = p_owner_id/);
    }
  });

  it("move_images rejects an empty image list and requires the target draft to exist for this owner", () => {
    const fn = migration.slice(migration.indexOf("function public.listing_studio_move_images"), migration.indexOf("function public.listing_studio_reorder_images"));
    expect(fn).toContain("NO_IMAGES");
    expect(fn).toContain("TARGET_DRAFT_NOT_FOUND");
    expect(fn).toContain("IMAGE_NOT_FOUND_OR_NOT_OWNED");
  });

  it("move_images appends moved photos after the target group's existing max sort_order, never colliding with existing values", () => {
    const fn = migration.slice(migration.indexOf("function public.listing_studio_move_images"), migration.indexOf("function public.listing_studio_reorder_images"));
    expect(fn).toContain("coalesce(max(sort_order), -1)");
  });

  it("reorder_images requires the given id set to exactly match the draft's current images — no silent partial reorder", () => {
    const fn = migration.slice(migration.indexOf("function public.listing_studio_reorder_images"), migration.indexOf("function public.listing_studio_split_group"));
    expect(fn).toContain("IMAGE_SET_MISMATCH");
    expect(fn).toMatch(/v_existing_count\s*<>\s*v_given_count/);
  });

  it("split_group creates a new draft with status 'grouping' and records an initial status_history entry", () => {
    const fn = migration.slice(migration.indexOf("function public.listing_studio_split_group"), migration.indexOf("function public.listing_studio_merge_groups"));
    expect(fn).toContain("insert into public.listing_drafts (owner_id, title, status)");
    expect(fn).toContain("'grouping'");
    expect(fn).toContain("insert into public.listing_status_history");
    expect(fn).toContain("returning id into v_new_draft_id");
    expect(fn).toContain("return v_new_draft_id");
  });

  it("merge_groups rejects merging a group into itself before touching any data", () => {
    const fn = migration.slice(migration.indexOf("function public.listing_studio_merge_groups"), migration.indexOf("-- Matches the existing function-access pattern"));
    const guardIndex = fn.indexOf("CANNOT_MERGE_GROUP_INTO_ITSELF");
    const firstUpdateIndex = fn.indexOf("update public.listing_draft_images");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstUpdateIndex);
  });

  it("merge_groups deletes the source group only after its images have already been moved (cascade removes its history, not its still-attached images)", () => {
    const fn = migration.slice(migration.indexOf("function public.listing_studio_merge_groups"), migration.indexOf("-- Matches the existing function-access pattern"));
    const updateIndex = fn.indexOf("update public.listing_draft_images");
    const deleteIndex = fn.indexOf("delete from public.listing_drafts");
    expect(updateIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(updateIndex);
  });

  it("revokes anon/authenticated execute on every new RPC, matching the existing function-access convention", () => {
    for (const signature of [
      "listing_studio_move_images(uuid, uuid[], uuid)",
      "listing_studio_reorder_images(uuid, uuid, uuid[])",
      "listing_studio_split_group(uuid, uuid, uuid[], text)",
      "listing_studio_merge_groups(uuid, uuid, uuid)",
      "listing_studio_delete_group(uuid, uuid, text)",
    ]) {
      expect(migration).toContain(`revoke all on function public.${signature} from public;`);
    }
  });
});

describe("supabase-listing-studio.sql — listing_studio_delete_group (group deletion UX fix)", () => {
  // Scoped to exactly this function's own body (not the wider "everything
  // up to the shared trailing comment" span) — later RPCs added after this
  // one (apply_boundary_session, clear_workspace) also contain their own
  // "delete from public.listing_draft_images"/"delete from public.listing_drafts"
  // statements, which a looser slice would incorrectly pick up via
  // lastIndexOf/indexOf below.
  const fn = migration.slice(migration.indexOf("function public.listing_studio_delete_group"), migration.indexOf("function public.listing_studio_apply_boundary_session"));

  it("rejects an unrecognized mode before touching any data", () => {
    expect(fn).toContain("INVALID_MODE");
    const guardIndex = fn.indexOf("INVALID_MODE");
    const firstMutation = Math.min(...["insert into", "update public.listing_draft_images", "delete from"].map(s => { const i = fn.indexOf(s); return i === -1 ? Infinity : i; }));
    expect(guardIndex).toBeLessThan(firstMutation);
  });

  it("requires the group to exist for this owner (cross-owner deletion rejection)", () => {
    expect(fn).toContain("DRAFT_NOT_FOUND");
    expect(fn).toMatch(/where id = p_draft_id and owner_id = p_owner_id/);
  });

  it("refuses to move the Unsorted group's own photos into itself", () => {
    expect(fn).toContain("CANNOT_MOVE_UNSORTED_TO_ITSELF");
    expect(fn).toContain("v_is_unsorted");
  });

  it("move_to_unsorted finds-or-creates the owner's Unsorted group, excluding the group being deleted, and appends after its existing max sort_order", () => {
    expect(fn).toContain("title = 'Unsorted'");
    expect(fn).toContain("id <> p_draft_id");
    expect(fn).toContain("insert into public.listing_drafts (owner_id, title, status)");
    expect(fn).toContain("coalesce(max(sort_order), -1)");
  });

  it("move_to_unsorted never deletes any image rows — only re-parents them", () => {
    const modeStart = fn.indexOf("if p_mode = 'move_to_unsorted' then");
    const modeEnd = fn.indexOf("v_paths := '{}'");
    const branch = fn.slice(modeStart, modeEnd);
    expect(branch).not.toContain("delete from public.listing_draft_images");
    expect(branch).toContain("update public.listing_draft_images");
  });

  it("delete_photos collects every affected storage_path before deleting the image rows, so the caller can clean up Storage objects afterward", () => {
    const elseIndex = fn.indexOf("else");
    const branch = fn.slice(elseIndex, fn.indexOf("end if;", elseIndex));
    const collectIndex = branch.indexOf("array_agg(storage_path)");
    const deleteIndex = branch.indexOf("delete from public.listing_draft_images");
    expect(collectIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(collectIndex);
  });

  it("deletes the group itself only after its photos have been disposed of one way or the other", () => {
    const disposalEnd = Math.max(fn.indexOf("v_paths := '{}'"), fn.lastIndexOf("delete from public.listing_draft_images"));
    const groupDeleteIndex = fn.indexOf("delete from public.listing_drafts where id = p_draft_id");
    expect(groupDeleteIndex).toBeGreaterThan(disposalEnd);
  });

  it("returns the disposed storage paths as a table result for the app layer to read", () => {
    expect(fn).toContain("returns table(deleted_storage_paths text[])");
    expect(fn).toContain("return query select v_paths;");
  });
});
