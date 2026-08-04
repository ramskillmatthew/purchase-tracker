import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Listing Studio API routes — authentication (extends tests/security-boundaries.test.ts's app-wide check)", () => {
  it("every listing-studio route requires the owner", () => {
    const routes = globSync("app/api/listing-studio/**/route.ts");
    expect(routes.length).toBeGreaterThanOrEqual(11);
    for (const route of routes) expect(read(route), route).toContain("await requireOwner()");
  });

  it("no route ever constructs a Supabase/Anthropic client with a client-exposed key, and none imports @supabase/supabase-js", () => {
    for (const route of globSync("app/api/listing-studio/**/route.ts")) {
      const source = read(route);
      expect(source).not.toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
      expect(source).not.toContain("@supabase/supabase-js");
    }
  });
});

describe("app/api/listing-studio/uploads/route.ts — upload session", () => {
  const source = read("app/api/listing-studio/uploads/route.ts");

  it("validates the request body with the strict zod schema", () => {
    expect(source).toContain("uploadSessionRequestSchema.parse(await request.json())");
  });

  it("enforces the individual file size, batch size, and workspace-wide active-file limits before creating anything", () => {
    expect(source).toContain("MAX_INDIVIDUAL_FILE_SIZE_BYTES");
    expect(source).toContain("MAX_BATCH_SIZE_BYTES");
    expect(source).toContain("MAX_TOTAL_ACTIVE_UPLOAD_FILES");
  });

  it("generates the image id and storage path server-side — never accepts either from the client", () => {
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain("buildDraftImageStoragePath(user.id, finalDraftId, imageId, file.filename)");
    expect(source).not.toMatch(/imageId\s*[:=]\s*file\./);
  });

  it("returns only what the browser needs to upload directly to Storage — never the service-role key", () => {
    expect(source).toContain("{ imageId: entry.imageId, uploadUrl: entry.uploadUrl, storagePath: entry.storagePath }");
  });

  it("maps a missing bucket to a clear 503 setup message rather than a generic failure", () => {
    expect(source).toContain("StorageBucketMissingError");
    expect(source).toMatch(/status:\s*503/);
  });

  it("verifies a client-supplied draftId belongs to this owner before appending to it", () => {
    expect(source).toContain("listing_drafts?id=eq.${targetDraftId}&owner_id=eq.${user.id}");
  });

  it("REGRESSION (PGRST103): the sort_order lookup uses a bounded supabaseRequest, never supabaseRequestAll, which would conflict with its own limit=1", () => {
    const queryIndex = source.indexOf("select=sort_order&order=sort_order.desc&limit=1");
    expect(queryIndex).toBeGreaterThan(-1);
    const precedingCall = source.slice(0, queryIndex).split("\n").filter(Boolean).slice(-3).join("\n");
    expect(precedingCall).toContain("await supabaseRequest(");
    expect(precedingCall).not.toContain("supabaseRequestAll");
  });

  it("REGRESSION: mints every signed URL before writing anything to the database, so a mid-batch failure leaves zero rows, never a partial set", () => {
    const mintIndex = source.indexOf("createSignedUploadUrl(LISTING_STUDIO_BUCKET, entry.storagePath)");
    const insertIndex = source.indexOf('supabaseRequest("listing_draft_images"');
    expect(mintIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(mintIndex);
  });

  it("inserts every prepared row in a single bulk request — one atomic statement, not one insert per file", () => {
    const insertBlock = source.slice(source.indexOf('supabaseRequest("listing_draft_images"'), source.indexOf('const images = signed.map'));
    expect(insertBlock).toContain("signed.map((entry, index) => ({");
    expect(source.match(/supabaseRequest\("listing_draft_images"/g)?.length).toBe(1);
  });

  it("cleans up a newly-created empty group if the batch fails entirely, but only one this request itself created", () => {
    expect(source).toContain("let cleanupNewlyCreatedDraftId: string | null = null;");
    expect(source).toContain("cleanupNewlyCreatedDraftId = targetDraftId;");
    const catchBlock = source.slice(source.indexOf("} catch (error) {"), source.length);
    expect(catchBlock).toContain("if (cleanupNewlyCreatedDraftId)");
    expect(catchBlock).toContain('method: "DELETE"');
  });

  it("only marks a group for cleanup inside the 'create a brand-new Unsorted group' branch — reusing an existing group never assigns it", () => {
    const reuseIndex = source.indexOf("targetDraftId = unsorted[0].id;");
    const createIndex = source.indexOf('body: JSON.stringify({ owner_id: user.id, title: UNSORTED_TITLE, status: "uploading" })');
    const assignIndex = source.indexOf("cleanupNewlyCreatedDraftId = targetDraftId;");
    expect(reuseIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(reuseIndex); // the reuse branch is checked/handled first in source order
    expect(assignIndex).toBeGreaterThan(createIndex); // the cleanup flag is only set after/within the create branch
    // Exactly one assignment site in the whole file — never re-assigned when reusing.
    expect(source.match(/cleanupNewlyCreatedDraftId = targetDraftId;/g)?.length).toBe(1);
  });
});

describe("app/api/listing-studio/uploads/[imageId]/retry/route.ts — REGRESSION: retry never creates a duplicate image record", () => {
  it("only ever reads and PATCHes the existing row by its own id — no INSERT anywhere in the route", () => {
    const source = read("app/api/listing-studio/uploads/[imageId]/retry/route.ts");
    expect(source).not.toMatch(/method:\s*"POST"[\s\S]*listing_draft_images/);
    expect(source).toContain('method: "PATCH"');
    expect(source).not.toContain("crypto.randomUUID()");
  });
});

describe("app/api/listing-studio/groups/[draftId]/route.ts — group deletion (UX fix)", () => {
  const source = read("app/api/listing-studio/groups/[draftId]/route.ts");
  const deleteFn = source.slice(source.indexOf("export async function DELETE"), source.length);

  it("validates the optional mode with the strict zod schema", () => {
    expect(deleteFn).toContain("deleteGroupRequestSchema.parse(rawBody)");
  });

  it("verifies the group belongs to this owner before deleting anything (cross-owner rejection)", () => {
    expect(deleteFn).toContain("listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id");
  });

  it("an empty group can be deleted with no mode at all", () => {
    expect(deleteFn).toContain("images.length > 0 && !mode");
  });

  it("a populated group without an explicit mode is rejected with a clear, actionable 409 — never silently deleted or silently rejected", () => {
    expect(deleteFn).toMatch(/status:\s*409/);
    expect(deleteFn).toContain("Choose whether to move them to Unsorted or delete them");
  });

  it("delegates the actual disposal to the transactional RPC — never does the move/delete as separate non-atomic REST calls", () => {
    expect(deleteFn).toContain('"rpc/listing_studio_delete_group"');
    expect(deleteFn).toContain("p_mode: mode ?? \"delete_photos\"");
  });

  it("cleans up every Storage object the RPC reports as deleted — never leaves an orphaned Storage object behind after a permanent delete", () => {
    expect(deleteFn).toContain("deleted_storage_paths");
    expect(deleteFn).toContain("deleteStorageObject(LISTING_STUDIO_BUCKET, path)");
  });

  it("a Storage cleanup failure is logged, never left to fail the whole request (the DB rows are already gone either way)", () => {
    const cleanupBlock = deleteFn.slice(deleteFn.indexOf("if (storagePaths.length)"), deleteFn.indexOf("return NextResponse.json({ ok: true })"));
    expect(cleanupBlock).toContain(".catch(error =>");
    expect(cleanupBlock).toContain("console.error(");
  });

  it("maps a known RPC conflict (e.g. CANNOT_MOVE_UNSORTED_TO_ITSELF) to a safe message, never raw Postgres text", () => {
    expect(deleteFn).toContain("classifyListingStudioRpcError(error)");
  });
});

describe("app/api/listing-studio/uploads/[imageId]/confirm/route.ts — upload confirmation", () => {
  const source = read("app/api/listing-studio/uploads/[imageId]/confirm/route.ts");

  it("never marks an upload complete without independently checking Storage first", () => {
    const bodyStart = source.indexOf("export async function POST");
    const metadataCallIndex = source.indexOf("getStorageObjectMetadata(");
    const uploadedWriteIndex = source.indexOf('upload_state: "uploaded"');
    expect(metadataCallIndex).toBeGreaterThan(bodyStart);
    expect(uploadedWriteIndex).toBeGreaterThan(metadataCallIndex);
  });

  it("marks the image failed (not uploaded) when Storage reports no object", () => {
    const fn = source.slice(source.indexOf("export async function POST"), source.indexOf("async function maybeAdvanceDraftToGrouping"));
    expect(fn).toContain("if (!metadata)");
    expect(fn).toContain('upload_state: "failed"');
  });

  it("persists server-verified size/mimeType, never the client's original claim", () => {
    expect(source).toContain("file_size: metadata.size");
    expect(source).toContain("mime_type: metadata.mimeType");
  });

  it("width/height are accepted from the client without re-verification — not a trust-sensitive field", () => {
    expect(source).toContain("width: body.width ?? null");
    expect(source).toContain("height: body.height ?? null");
  });

  it("advances the draft from uploading to grouping only once every image has resolved, via the existing status.ts helpers", () => {
    expect(source).toContain('import { buildStatusHistoryEntry, isValidStatusTransition } from "@/lib/listing-studio/status"');
    expect(source).toContain('upload_state=in.(pending,uploading)');
    expect(source).toContain('isValidStatusTransition("uploading", "grouping")');
  });
});

describe("app/api/listing-studio/uploads/[imageId]/retry/route.ts — retry", () => {
  const source = read("app/api/listing-studio/uploads/[imageId]/retry/route.ts");
  it("mints a fresh signed URL for the SAME existing storage_path with upsert:true, never creating a new image record", () => {
    expect(source).toContain("createSignedUploadUrl(LISTING_STUDIO_BUCKET, image.storage_path, { upsert: true })");
    expect(source).not.toContain("crypto.randomUUID()");
  });
  it("resets upload_state back to pending", () => {
    expect(source).toContain('upload_state: "pending"');
  });
});

describe("app/api/listing-studio/images/[imageId]/route.ts — remove image", () => {
  const source = read("app/api/listing-studio/images/[imageId]/route.ts");
  it("deletes the Storage object and the database record, and never fails the whole request just because Storage cleanup failed", () => {
    expect(source).toContain("deleteStorageObject(LISTING_STUDIO_BUCKET, image.storage_path).catch(");
    expect(source).toContain('method: "DELETE"');
  });
});

describe("app/api/listing-studio/images/[imageId]/view/route.ts — view", () => {
  const source = read("app/api/listing-studio/images/[imageId]/view/route.ts");
  it("redirects to the signed URL rather than proxying the image bytes itself", () => {
    expect(source).toContain("NextResponse.redirect(signedUrl");
    expect(source).not.toMatch(/\.arrayBuffer\(\)|\.blob\(\)/);
  });
});

describe("app/api/listing-studio/groups/[draftId]/route.ts — rename/delete group", () => {
  const source = read("app/api/listing-studio/groups/[draftId]/route.ts");
  it("DELETE refuses to remove a group that still has photos", () => {
    const fn = source.slice(source.indexOf("export async function DELETE"), source.length);
    expect(fn).toContain("images.length > 0");
    expect(fn).toMatch(/status:\s*409/);
  });
});

describe("Milestone 2 grouping routes call their corresponding transactional RPC, never doing the multi-record edit as separate REST calls", () => {
  it("reorder route calls rpc/listing_studio_reorder_images", () => {
    expect(read("app/api/listing-studio/groups/[draftId]/reorder/route.ts")).toContain('"rpc/listing_studio_reorder_images"');
  });
  it("move route calls rpc/listing_studio_move_images", () => {
    expect(read("app/api/listing-studio/groups/move-images/route.ts")).toContain('"rpc/listing_studio_move_images"');
  });
  it("split route calls rpc/listing_studio_split_group", () => {
    expect(read("app/api/listing-studio/groups/split/route.ts")).toContain('"rpc/listing_studio_split_group"');
  });
  it("merge route calls rpc/listing_studio_merge_groups", () => {
    expect(read("app/api/listing-studio/groups/merge/route.ts")).toContain('"rpc/listing_studio_merge_groups"');
  });
  it("every one of these routes maps a known RPC error via classifyListingStudioRpcError rather than leaking raw Postgres text", () => {
    for (const route of [
      "app/api/listing-studio/groups/[draftId]/reorder/route.ts",
      "app/api/listing-studio/groups/move-images/route.ts",
      "app/api/listing-studio/groups/split/route.ts",
      "app/api/listing-studio/groups/merge/route.ts",
    ]) {
      expect(read(route)).toContain("classifyListingStudioRpcError(error)");
    }
  });
});

describe("app/api/listing-studio/groups/route.ts — automatic Product-N naming (speed redesign)", () => {
  const source = read("app/api/listing-studio/groups/route.ts");

  it("uses the shared getNextAutomaticGroupName helper rather than a hardcoded 'Untitled group' fallback", () => {
    expect(source).toContain('import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming"');
    expect(source).toContain("const resolvedTitle = title ?? getNextAutomaticGroupName(existingGroups);");
    expect(source).not.toContain("Untitled group");
  });

  it("computes the automatic name from a fresh, authoritative query of the caller's current groups — the server, not the client, is the source of truth", () => {
    expect(source).toContain("select=id,title");
  });

  it("still honours an explicit title as-is (e.g. an undo restoring a specific previous name)", () => {
    const fn = source.slice(source.indexOf("export async function POST"), source.length);
    expect(fn).toContain("title ?? getNextAutomaticGroupName");
  });

  it("returns the resolved title in the response so the client can update its UI without a second round trip", () => {
    expect(source).toContain('NextResponse.json({ draftId: created[0].id, title: resolvedTitle }, { status: 201 });');
  });
});

describe("app/api/listing-studio/groups/split/route.ts — automatic Product-N naming for the new split-off group", () => {
  const source = read("app/api/listing-studio/groups/split/route.ts");

  it("uses the shared getNextAutomaticGroupName helper instead of relying on the SQL function's generic fallback", () => {
    expect(source).toContain('import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming"');
    expect(source).toContain("newTitle ?? getNextAutomaticGroupName(");
  });

  it("always passes a concrete, non-empty p_new_title to the RPC — never null — so numbering stays in TypeScript, not SQL", () => {
    expect(source).toContain("p_new_title: resolvedTitle");
    expect(source).not.toContain("p_new_title: newTitle ?? null");
  });

  it("returns the resolved title alongside the new draftId", () => {
    expect(source).toContain("NextResponse.json({ draftId: newDraftId, title: resolvedTitle }, { status: 201 });");
  });
});

describe("app/api/listing-studio/groups/auto-group/route.ts — ANALYZE ONLY, one ordered chunk per call (Milestone 3 v3: ordered boundary detection)", () => {
  const source = read("app/api/listing-studio/groups/auto-group/route.ts");

  it("requires the owner and never handles any other HTTP method", () => {
    expect(source).toContain("await requireOwner()");
    expect(source).not.toMatch(/export async function (GET|PUT|DELETE|PATCH)/);
  });

  it("has a bounded maxDuration matching the ceiling already used for this app's other AI-calling routes (app/api/vinted/sync, app/api/assistant)", () => {
    expect(source).toContain("export const maxDuration = 60;");
  });

  it("takes an explicit imageIds chunk, optional overlap context, and this chunk's own sequence start from the client — a full run is a client-driven loop of many small, bounded, ORDERED calls", () => {
    expect(source).toContain("autoGroupAnalyzeRequestSchema.parse(await request.json())");
    expect(source).toContain("chunkStartSequenceIndex");
    expect(source).toContain("overlapImageIds");
  });

  it("only ever reads photos from whichever Unsorted group currently exists — the exact same find lookup as the uploads route, never a client-supplied group id", () => {
    expect(source).toContain('title=eq.${encodeURIComponent(UNSORTED_TITLE)}&status=in.(uploading,grouping)');
  });

  it("REGRESSION: never trusts the client's ids blindly — re-verifies every id (both the chunk's own photos and any overlap context) against this owner's current Unsorted group and upload_state before using any of them", () => {
    const fn = source.slice(source.indexOf("const allRequestedIds ="), source.indexOf("const chunkImages ="));
    expect(fn).toContain("owner_id=eq.${user.id}");
    expect(fn).toContain("draft_id=eq.${unsortedDraftId}");
    expect(fn).toContain("upload_state=eq.uploaded");
  });

  it("REGRESSION: reconstructs exact sequence order after image preparation, since prepareAutoGroupImageInputs does not preserve input order — this is load-bearing, since sequence-index labelling depends on the model seeing photos in true upload order", () => {
    expect(source).toContain("const blockById = new Map(blocks.map(block => [block.imageId, block]));");
    expect(source).toContain("chunkImages.map(image => blockById.get(image.id))");
    expect(source).toContain("overlapImages.map(image => blockById.get(image.id))");
  });

  it("never applies or moves anything — this route only calls runAutoGroupAnalysis and returns its raw (unreconciled) data; reconciliation and apply happen only in apply-session/route.ts", () => {
    expect(source).not.toContain("rpc/listing_studio_apply_boundary_session");
    expect(source).not.toContain("reconcileAutoGroupSession");
    expect(source).toContain("const outcome = await runAutoGroupAnalysis(orderedChunkBlocks, chunkStartSequenceIndex, orderedOverlapBlocks);");
    expect(source).toContain("return NextResponse.json({ data: outcome.data });");
  });

  it("records an audit row on both success and failure — stage, model, prompt/schema version, and timestamps are always populated", () => {
    for (const field of ['stage: "product_grouping"', "model,", "prompt_version: LISTING_PROMPT_VERSIONS.product_grouping", "schema_version: LISTING_SCHEMA_VERSIONS.product_grouping", "started_at", "completed_at"]) {
      expect(source).toContain(field);
    }
    expect(source).toContain('status: "failed"');
    expect(source).toContain('status: "success"');
  });

  it("never stores the raw AI failure — only the fixed, safe describeAutoGroupFailure message", () => {
    const fn = source.slice(source.indexOf('outcome.status !== "success"'), source.indexOf("const status = outcome.status"));
    expect(fn).toContain("error_message: describeAutoGroupFailure(outcome.status)");
  });

  it("REGRESSION: distinguishes 'not configured' (503 — stop the whole client-side chunk loop, every remaining chunk would fail identically) from any other AI failure (502 — this one chunk failed, possibly transiently; the loop continues with the next chunk)", () => {
    expect(source).toContain('const status = outcome.status === "not_configured" ? 503 : 502;');
    expect(source).toContain("error: describeAutoGroupFailure(outcome.status)");
    expect(source).toContain("{ status });");
  });

  it("returns a clean empty result — never an error — when nothing in this chunk is still eligible (no Unsorted group, none of the given ids still validate, or nothing survives image preparation)", () => {
    expect(source.match(/return NextResponse\.json\(\{ data: \{ groups: \[\], ungroupedImageIds: \[\] \} \}\);/g)?.length).toBe(3);
  });

  it("catches everything through safeApiError, matching every other route in this feature", () => {
    expect(source).toContain('return safeApiError(error, "Could not analyse these photos.");');
  });
});

describe("app/api/listing-studio/groups/auto-group/apply-session/route.ts — the ONLY place a whole 'Auto-group products' session is ever written (Milestone 3 v3)", () => {
  const source = read("app/api/listing-studio/groups/auto-group/apply-session/route.ts");

  it("requires the owner, validates the whole-session request body strictly, and has a bounded maxDuration", () => {
    expect(source).toContain("await requireOwner()");
    expect(source).toContain("applyAutoGroupSessionRequestSchema.parse(await request.json())");
    expect(source).toContain("export const maxDuration = 30;");
  });

  it("REGRESSION: reconciles every chunk's result together BEFORE applying anything — never applies one chunk's result on its own", () => {
    const reconcileIndex = source.indexOf("reconcileAutoGroupSession(chunkResults, imageIds.map(id => ({ id })));");
    const rpcIndex = source.indexOf('"rpc/listing_studio_apply_boundary_session"');
    expect(reconcileIndex).toBeGreaterThan(-1);
    expect(rpcIndex).toBeGreaterThan(reconcileIndex);
  });

  it("calls the whole-session transactional RPC exactly once with every accepted high-confidence group together — never one RPC call per group", () => {
    expect(source.match(/supabaseRequest\("rpc\/listing_studio_apply_boundary_session"/g)?.length).toBe(1);
    expect(source).toContain("p_groups: plannedGroups.map(g => ({ title: g.title, image_ids: g.image_ids })),");
  });

  it("computes each new group's name via the shared automatic-naming helper, updating its own in-memory copy so no two groups in the same session collide on the same name", () => {
    const plannedGroupsIndex = source.indexOf("const plannedGroups =");
    const fn = source.slice(plannedGroupsIndex, source.indexOf("try {", plannedGroupsIndex));
    expect(fn).toContain("getNextAutomaticGroupName(existingTitles)");
    expect(fn).toContain("existingTitles.push(");
  });

  it("REGRESSION: if the RPC call fails, the whole session's apply is treated as failed (409) — never partially reported as success", () => {
    const catchBlock = source.slice(source.indexOf("} catch (error) {"), source.indexOf("const proposedGroups ="));
    expect(catchBlock).toContain("classifyListingStudioRpcError(error)");
    expect(catchBlock).toContain("status: 409");
    expect(catchBlock).not.toContain("groupsCreated =");
  });

  it("never returns the raw provider/DB error to the client — only the classified message or a safe generic fallback", () => {
    const catchBlock = source.slice(source.indexOf("} catch (error) {"), source.indexOf("const proposedGroups ="));
    expect(catchBlock).toContain('return NextResponse.json({ error: known ?? "Could not apply this session\'s groups." }, { status: 409 });');
  });

  it("medium-confidence ranges are returned to the client as proposedGroups for individual review — never auto-applied", () => {
    const fn = source.slice(source.indexOf("const proposedGroups ="), source.indexOf("const photosGroupedCount ="));
    expect(fn).toContain("reconciled.needsReview.map(");
    expect(source).not.toMatch(/needsReview[\s\S]{0,80}rpc\//);
  });

  it("records an audit row on both success and failure — stage, model, prompt/schema version, and timestamps are always populated", () => {
    for (const field of ['stage: "product_grouping"', "model,", "prompt_version: LISTING_PROMPT_VERSIONS.product_grouping", "schema_version: LISTING_SCHEMA_VERSIONS.product_grouping", "started_at", "completed_at"]) {
      expect(source).toContain(field);
    }
    expect(source).toContain('status: "failed"');
    expect(source).toContain('status: "success"');
  });

  it("returns a clean zero-result — never an error — when there is no Unsorted group left to apply into", () => {
    expect(source).toContain("if (!unsorted.length) {");
    expect(source).toContain("groupsCreated: [], proposedGroups: [], photosGroupedCount: 0, photosPendingReviewCount: 0, photosLeftInUnsortedCount: 0");
  });

  it("catches everything through safeApiError, matching every other route in this feature", () => {
    expect(source).toContain('return safeApiError(error, "Could not apply this session\'s groups.");');
  });
});

describe("app/api/listing-studio/groups/auto-group/apply/route.ts — applying one reviewed medium-confidence proposal", () => {
  const source = read("app/api/listing-studio/groups/auto-group/apply/route.ts");

  it("requires the owner and validates the request body strictly", () => {
    expect(source).toContain("await requireOwner()");
    expect(source).toContain("applyAutoGroupProposalRequestSchema.parse(await request.json())");
  });

  it("only the photo ids are taken from the client — the Unsorted group is looked up fresh here, never trusted from an earlier response", () => {
    expect(source).toContain('title=eq.${encodeURIComponent(UNSORTED_TITLE)}&status=in.(uploading,grouping)');
    expect(source).not.toContain("unsortedDraftId:");
  });

  it("computes the destination name via the shared automatic-naming helper, from a fresh query of the caller's current groups", () => {
    expect(source).toContain("getNextAutomaticGroupName(existingDrafts)");
  });

  it("applies via the same shared helper as the analyze route's own high-confidence auto-apply — one transactional split RPC call, not a new code path", () => {
    expect(source).toContain("await applyAutoGroupProposal(user, unsorted[0].id, imageIds, title)");
  });

  it("fails safely with a classified error, never a raw one, when the underlying photos have since moved", () => {
    expect(source).toContain("if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });");
  });
});

describe("app/api/listing-studio/workspace/route.ts — GET (fetches the Create workspace)", () => {
  const source = read("app/api/listing-studio/workspace/route.ts");
  const getFn = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function DELETE"));

  it("never returns the raw storage_path to the client — only image metadata and ids used with the /view route", () => {
    expect(getFn).not.toContain("storage_path");
  });
  it("excludes archived drafts from the Create workspace", () => {
    expect(getFn).toContain("status=neq.archived");
  });

  it("Milestone 4: selects every structured/generated listing field the Create view needs to render a listing card", () => {
    for (const column of ["brand", "model", "product_type", "colours", "material", "uk_size", "sku", "generated_title", "generated_description"]) {
      expect(getFn).toContain(column);
    }
  });

  it("Business-rule follow-up correction: applies the same read-time footwear/audience and children's-wording corrections as listings-review/route.ts, so the Create view never shows Boys/Girls or 'Youth'/'Kids'/etc for a Women's footwear listing either", () => {
    expect(getFn).toContain("normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily)");
    expect(getFn).toContain("normaliseFootwearListingText(draft.model, itemFamily, normalisedAudience)");
    expect(getFn).toContain("normaliseFootwearListingText(draft.product_type, itemFamily, normalisedAudience)");
    expect(getFn).toContain("normaliseFootwearListingText(draft.generated_title, itemFamily, normalisedAudience)");
    expect(getFn).toContain("normaliseFootwearListingText(draft.generated_description, itemFamily, normalisedAudience)");
  });

  it("REGRESSION: this correction is read-time-only — the GET handler never calls supabaseRequest (only supabaseRequestAll, a read), so it structurally cannot write the correction back to the database", () => {
    expect(getFn).not.toContain("supabaseRequest(");
  });
});

describe("app/api/listing-studio/workspace/route.ts — DELETE ('Clear all', workspace-wide reset)", () => {
  const source = read("app/api/listing-studio/workspace/route.ts");
  const deleteFn = source.slice(source.indexOf("export async function DELETE"), source.length);

  it("requires the owner, and scopes the image-resolution query to that owner alone — never a client-supplied owner/id", () => {
    expect(deleteFn).toContain("await requireOwner()");
    expect(deleteFn).toContain("listing_draft_images?owner_id=eq.${user.id}&select=id,storage_path&order=id.asc");
  });

  it("REGRESSION: resolves Storage paths and deletes Storage objects BEFORE calling the database-clearing RPC — the reverse order from the single-group delete route, deliberately", () => {
    const resolveIndex = deleteFn.indexOf("supabaseRequestAll<{ id: string; storage_path: string }>");
    const storageDeleteIndex = deleteFn.indexOf("await deleteStorageObjects(LISTING_STUDIO_BUCKET, uniquePaths)");
    const rpcIndex = deleteFn.indexOf('"rpc/listing_studio_clear_workspace"');
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(storageDeleteIndex).toBeGreaterThan(resolveIndex);
    expect(rpcIndex).toBeGreaterThan(storageDeleteIndex);
  });

  it("re-validates every resolved storage path's shape and ownership independently, even though it came from this owner's own database rows, never accepting a path from the client at all (there is no client input to this endpoint)", () => {
    expect(deleteFn).toContain("const parsed = parseDraftImageStoragePath(image.storage_path);");
    expect(deleteFn).toContain("if (!parsed || parsed.ownerId !== user.id)");
    expect(deleteFn).toContain("warnings.push(");
  });

  it("REGRESSION: deduplicates storage paths before deleting", () => {
    expect(deleteFn).toContain("const uniquePaths = [...new Set(validPaths)];");
  });

  it("REGRESSION: a Storage deletion failure aborts before any database row is touched — the RPC is never reached, and the message says nothing was deleted", () => {
    const storageCatch = deleteFn.slice(deleteFn.indexOf("await deleteStorageObjects"), deleteFn.indexOf("let counts:"));
    expect(storageCatch).toContain("stage: \"storage\"");
    expect(storageCatch).toContain("Nothing was deleted");
    expect(storageCatch).not.toContain("rpc/listing_studio_clear_workspace");
  });

  it("REGRESSION: a database deletion failure (after Storage succeeded) is reported with a distinct message and stage, since real files are already gone at that point", () => {
    const dbCatch = deleteFn.slice(deleteFn.indexOf("let counts:"), deleteFn.indexOf("deletedImageCount: counts.deleted_image_count"));
    expect(dbCatch).toContain("stage: \"database\"");
    expect(dbCatch).toContain("removed from storage, but clearing the remaining records failed");
  });

  it("calls the one dedicated RPC exactly once with only the owner id — no per-image or per-group delete calls", () => {
    expect(deleteFn.match(/supabaseRequest\("rpc\/listing_studio_clear_workspace"/g)?.length).toBe(1);
    expect(deleteFn).toContain("body: JSON.stringify({ p_owner_id: user.id })");
  });

  it("returns deleted image/group/draft/Storage-object counts and any warnings — deletedDraftCount mirrors deletedGroupCount since this schema has one table for both", () => {
    expect(deleteFn).toContain("deletedImageCount: counts.deleted_image_count,");
    expect(deleteFn).toContain("deletedGroupCount: counts.deleted_group_count,");
    expect(deleteFn).toContain("deletedDraftCount: counts.deleted_group_count,");
    expect(deleteFn).toContain("deletedStorageObjectCount: uniquePaths.length,");
    expect(deleteFn).toContain("warnings,");
  });

  it("catches everything through safeApiError, matching every other route in this feature", () => {
    expect(deleteFn).toContain('return safeApiError(error, "Could not clear the workspace.");');
  });

  it("has a bounded maxDuration, matching the convention for a potentially-long-running route in this feature", () => {
    expect(source).toContain("export const maxDuration = 30;");
  });
});

describe("app/api/listing-studio/groups/[draftId]/generate/route.ts — Milestone 4: generates ONE group's listing", () => {
  const source = read("app/api/listing-studio/groups/[draftId]/generate/route.ts");

  it("requires the owner, validates the group id, and has a bounded maxDuration matching this feature's other AI-calling routes", () => {
    expect(source).toContain("await requireOwner()");
    expect(source).toContain("uuidSchema.safeParse(draftId).success");
    expect(source).toContain("export const maxDuration = 60;");
  });

  it("REGRESSION: rejects generating a listing for the Unsorted group specifically, not just any group", () => {
    expect(source).toContain('if (draft.title === UNSORTED_TITLE) return NextResponse.json({ error: "Cannot generate a listing for the Unsorted group." }, { status: 400 });');
  });

  it("only ever reads this owner's own uploaded photos for this exact group — never a client-supplied photo list", () => {
    const fn = source.slice(source.indexOf("const images = await supabaseRequestAll"), source.indexOf("if (!images.length)"));
    expect(fn).toContain("draft_id=eq.${draftId}");
    expect(fn).toContain("owner_id=eq.${user.id}");
    expect(fn).toContain("upload_state=eq.uploaded");
  });

  it("bounds the number of photos sent to Claude for one group, per MAX_GENERATION_IMAGES_PER_GROUP", () => {
    expect(source).toContain("const eligibleImages = images.slice(0, MAX_GENERATION_IMAGES_PER_GROUP);");
  });

  it("never applies/persists anything on an AI failure — only an audit row is written, so a retry always safely repeats the same call", () => {
    const failureBlock = source.slice(source.indexOf('if (outcome.status !== "success")'), source.indexOf("const fields = outcome.data;"));
    expect(failureBlock).toContain('status: "failed"');
    expect(failureBlock).not.toContain("listing_drafts?id=eq");
    expect(failureBlock).toContain('const status = outcome.status === "not_configured" ? 503 : 502;');
  });

  it("REGRESSION: derives title/description from the structured fields via listing-template.ts — never sends or accepts a title/description from the AI", () => {
    expect(source).toContain("generateListingTitle(structuredFields)");
    expect(source).toContain("generateListingDescription(structuredFields)");
    expect(source).not.toMatch(/outcome\.data\.title|outcome\.data\.description/);
  });

  it("persists every structured field, the derived/preserved UK size and its provenance, the raw source size, the fixed condition text, both generated fields, and marks the draft ready, in one real (non-swallowed) write", () => {
    const patchStart = source.indexOf("await supabaseRequest(`listing_drafts?id=eq.${draftId}");
    const patchBlock = source.slice(patchStart, source.indexOf("await supabaseRequest(\"listing_analysis_runs\"", patchStart));
    expect(patchBlock).not.toContain(".catch(() => {})"); // the real write is never best-effort
    for (const field of ["brand: structuredFields.brand", "model: structuredFields.model", "product_type: structuredFields.productType", "colours: structuredFields.colours", "material: structuredFields.material", "uk_size: finalUkSize", "uk_size_source: finalUkSizeSource", "sku: structuredFields.sku", "source_size_system: fields.sourceSize.system", "source_size_value: fields.sourceSize.value", "source_size_gender: fields.sourceSize.gender", "condition: LISTING_CONDITION_TEXT", "generated_title: generatedTitle", "generated_description: generatedDescription", 'status: "ready"', "ai_result_json: fields"]) {
      expect(patchBlock).toContain(field);
    }
  });

  it("REGRESSION (Milestone 4 sizing coverage correction): derives ukSize deterministically via lib/listing-studio/size-conversion.ts — a directly observed UK size is used as-is, EU/US is converted brand-aware with a fallback, and an existing UK size (and its provenance, from a prior generation or manual Edit fields entry) is never overwritten", () => {
    expect(source).toContain("import { deriveUkSizeFromSource } from \"@/lib/listing-studio/size-conversion\";");
    const deriveIndex = source.indexOf("const derived = deriveUkSizeFromSource({");
    const deriveBlock = source.slice(deriveIndex, source.indexOf("const finalUkSize ="));
    expect(deriveBlock).toContain("sourceSizeSystem: fields.sourceSize.system,");
    expect(deriveBlock).toContain("sourceSizeValue: fields.sourceSize.value,");
    expect(deriveBlock).toContain("sourceSizeGender: fields.sourceSize.gender,");
    expect(source).toContain("const finalUkSize = draft.uk_size ?? derived.ukSize;");
    expect(source).toContain("const finalUkSizeSource = draft.uk_size ? draft.uk_size_source : derived.provenance;");
  });

  it("selects the draft's own current uk_size and uk_size_source before generating, so the preserve-existing-value check above has something real to compare against", () => {
    expect(source).toContain("select=id,title,uk_size,uk_size_source");
  });

  it("records an audit row on both success and failure — stage 'generation', model, prompt/schema version, timestamps", () => {
    for (const field of ['stage: "generation"', "model,", "prompt_version: LISTING_PROMPT_VERSIONS.generation", "schema_version: LISTING_SCHEMA_VERSIONS.generation", "started_at", "completed_at"]) {
      expect(source).toContain(field);
    }
    expect(source).toContain('status: "failed"');
    expect(source).toContain('status: "success"');
  });

  it("returns the persisted structured fields and both generated fields to the client", () => {
    const responseBlock = source.slice(source.lastIndexOf("return NextResponse.json({"), source.length);
    for (const field of ["brand:", "model:", "productType:", "colours:", "material:", "ukSize:", "sku:", "generatedTitle,", "generatedDescription,"]) {
      expect(responseBlock).toContain(field);
    }
  });

  it("catches everything through safeApiError, matching every other route in this feature", () => {
    expect(source).toContain('return safeApiError(error, "Could not generate this listing.");');
  });
});

describe("app/api/listing-studio/groups/[draftId]/fields/route.ts — Milestone 4: 'Edit fields' — no photo-analysis AI call, ever", () => {
  const source = read("app/api/listing-studio/groups/[draftId]/fields/route.ts");

  it("requires the owner, validates the group id and request body strictly", () => {
    expect(source).toContain("await requireOwner()");
    expect(source).toContain("uuidSchema.safeParse(draftId).success");
    expect(source).toContain("updateListingFieldsRequestSchema.parse(await request.json())");
  });

  it("REGRESSION: never imports or calls the photo-analysis/generation AI, and title/description are still always template-derived, never AI-authored", () => {
    expect(source).not.toMatch(/runListingGenerationAnalysis|prepareListingGenerationImageInputs/);
    expect(source).toContain("generateListingTitle(structuredFields)");
    expect(source).toContain("generateListingDescription(structuredFields)");
  });

  it("Follow-up correction (2026-08-04): MAY trigger the bounded, text-only category-selection AI step, but ONLY when the audience actually changed — never on every save", () => {
    expect(source).toContain("import { resolveVintedCategoryAssignment");
    expect(source).toContain("if (audienceChanged) {");
  });

  it("normalizes an empty/whitespace-only field to null — never stores a blank string as a 'set' value", () => {
    expect(source).toContain("function normalize(value: string | null): string | null {");
    expect(source).toContain("const trimmed = value?.trim();");
    expect(source).toContain("return trimmed ? trimmed : null;");
  });

  it("regenerates both derived fields from the submitted structured fields via listing-template.ts, and persists them together with the structured fields", () => {
    const patchStart = source.indexOf("await supabaseRequest(`listing_drafts?id=eq.${draftId}");
    const patchBlock = source.slice(patchStart, source.indexOf("return NextResponse.json({", patchStart));
    expect(source).toContain("generateListingTitle(structuredFields)");
    expect(source).toContain("generateListingDescription(structuredFields)");
    for (const field of ["brand: structuredFields.brand", "model: structuredFields.model", "product_type: structuredFields.productType", "colours: structuredFields.colours", "material: structuredFields.material", "uk_size: structuredFields.ukSize", "sku: structuredFields.sku", "generated_title: generatedTitle", "generated_description: generatedDescription"]) {
      expect(patchBlock).toContain(field);
    }
  });

  it("REGRESSION (Milestone 4 sizing coverage correction): records provenance 'manual' whenever a UK size is submitted, and null when it's cleared — a manually-entered value must never be mistaken for a generated one on a later regenerate", () => {
    const patchStart = source.indexOf("await supabaseRequest(`listing_drafts?id=eq.${draftId}");
    const patchBlock = source.slice(patchStart, source.indexOf("return NextResponse.json({", patchStart));
    expect(patchBlock).toContain('uk_size_source: structuredFields.ukSize ? "manual" : null');
  });

  it("REGRESSION: never accepts a title or description field from the client — updateListingFieldsRequestSchema has no such field, and this route never reads one from the body", () => {
    expect(source).not.toContain("body.title");
    expect(source).not.toContain("body.description");
  });

  it("catches everything through safeApiError, matching every other route in this feature", () => {
    expect(source).toContain('return safeApiError(error, "Could not save these fields.");');
  });
});
