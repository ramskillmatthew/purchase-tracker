import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("app/api/listing-studio/listings-review/route.ts — Milestone 5: read-only listings feed", () => {
  const source = read("app/api/listing-studio/listings-review/route.ts");

  it("requires the owner", () => {
    expect(source).toContain("await requireOwner()");
  });

  it("REGRESSION: only ever a GET — this milestone adds no write to this route", () => {
    expect(source).not.toContain("export async function POST");
    expect(source).not.toContain("export async function PATCH");
    expect(source).not.toContain("export async function DELETE");
  });

  it("excludes Unsorted, archived, and any group that hasn't actually been generated yet", () => {
    expect(source).toContain("status=neq.archived");
    expect(source).toContain("title=neq.${encodeURIComponent(UNSORTED_TITLE)}");
    expect(source).toContain("generated_title=not.is.null");
    expect(source).toContain("generated_description=not.is.null");
  });

  it("selects every field the review UI and its derived status/warnings/edited-detection logic need, including the frozen ai_result_json snapshot and provenance", () => {
    const selectIndex = source.indexOf("select=id,created_at,updated_at");
    expect(selectIndex).toBeGreaterThan(-1);
    const selectLine = source.slice(selectIndex, source.indexOf("`", selectIndex));
    for (const column of ["brand", "model", "product_type", "colour", "uk_size", "uk_size_source", "sku", "condition", "generated_title", "generated_description", "ai_result_json", "review_marked_ready_at"]) {
      expect(selectLine).toContain(column);
    }
  });

  it("scopes images to exactly the fetched drafts' ids (not every image the owner has) — a power user's in-progress Studio photos are irrelevant here", () => {
    expect(source).toContain("draft_id=in.(${draftIds.join(\",\")})");
    expect(source).toContain("upload_state=eq.uploaded");
  });

  it("returns an empty result immediately when there are no generated listings, without querying images at all", () => {
    const emptyCheckIndex = source.indexOf("if (!drafts.length)");
    expect(emptyCheckIndex).toBeGreaterThan(-1);
    const imagesQueryIndex = source.indexOf("listing_draft_images?draft_id=in");
    expect(imagesQueryIndex).toBeGreaterThan(emptyCheckIndex);
  });

  it("catches everything through safeApiError", () => {
    expect(source).toContain('return safeApiError(error, "Could not load your listings.");');
  });

  it("REGRESSION (2026-08-07 diagnosis item #13): selects vinted_category_id/path/source/status and vinted_audience_evidence — a validly-assigned category and its evidence must be readable back here, never silently omitted", () => {
    const selectIndex = source.indexOf("select=id,created_at,updated_at");
    const selectLine = source.slice(selectIndex, source.indexOf("`", selectIndex));
    for (const column of ["vinted_category_id", "vinted_category_path", "vinted_category_source", "vinted_category_status", "vinted_audience", "vinted_audience_source", "vinted_audience_evidence"]) {
      expect(selectLine).toContain(column);
    }
  });
});

describe("app/api/listing-studio/workspace/route.ts — REGRESSION (2026-08-07 diagnosis item #13): a validly-assigned category must be readable back in the main Listing Studio workspace, never silently omitted", () => {
  const source = read("app/api/listing-studio/workspace/route.ts");

  it("selects vinted_category_id/path/source/status alongside every other draft field the workspace UI needs", () => {
    const selectIndex = source.indexOf("select=id,title,status");
    expect(selectIndex).toBeGreaterThan(-1);
    const selectLine = source.slice(selectIndex, source.indexOf("`", selectIndex));
    for (const column of ["vinted_category_id", "vinted_category_path", "vinted_category_source", "vinted_category_status", "vinted_audience"]) {
      expect(selectLine).toContain(column);
    }
  });
});

describe("app/api/listing-studio/groups/[draftId]/mark-ready/route.ts — Milestone 5: the one write this milestone adds", () => {
  const source = read("app/api/listing-studio/groups/[draftId]/mark-ready/route.ts");

  it("requires the owner, validates the group id, and scopes the existence check to this owner alone", () => {
    expect(source).toContain("await requireOwner()");
    expect(source).toContain("uuidSchema.safeParse(draftId).success");
    expect(source).toContain("listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id");
  });

  it("REGRESSION: 404s when the listing doesn't exist (or isn't this owner's) rather than silently succeeding", () => {
    expect(source).toContain("if (!existing.length)");
    expect(source).toContain('{ error: "Listing not found." }, { status: 404 }');
  });

  it("persists review_marked_ready_at as a real timestamp, in a real (non-swallowed) write", () => {
    const patchIndex = source.indexOf("await supabaseRequest(`listing_drafts?id=eq.${draftId}");
    expect(patchIndex).toBeGreaterThan(-1);
    const patchBlock = source.slice(patchIndex, source.indexOf("return NextResponse.json", patchIndex));
    expect(patchBlock).not.toContain(".catch(() => {})");
    expect(patchBlock).toContain("review_marked_ready_at: reviewMarkedReadyAt");
  });

  it("REGRESSION: only ever a POST — no PATCH/DELETE, and never accepts a status/field body (Mark Ready always does exactly one thing)", () => {
    expect(source).not.toContain("export async function PATCH");
    expect(source).not.toContain("export async function DELETE");
    expect(source).not.toContain("request.json()");
  });

  it("returns the draft id and the timestamp it was marked ready at", () => {
    const responseIndex = source.lastIndexOf("return NextResponse.json({ draftId");
    expect(responseIndex).toBeGreaterThan(-1);
    expect(source.slice(responseIndex)).toContain("reviewMarkedReadyAt");
  });

  it("catches everything through safeApiError", () => {
    expect(source).toContain('return safeApiError(error, "Could not mark this listing ready.");');
  });
});
