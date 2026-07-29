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

describe("app/api/listing-studio/workspace/route.ts", () => {
  const source = read("app/api/listing-studio/workspace/route.ts");
  it("never returns the raw storage_path to the client — only image metadata and ids used with the /view route", () => {
    expect(source).not.toContain("storage_path");
  });
  it("excludes archived drafts from the Create workspace", () => {
    expect(source).toContain("status=neq.archived");
  });
});
