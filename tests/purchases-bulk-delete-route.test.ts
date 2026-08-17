import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Next.js server route touching Supabase directly — no live database in
// this test suite, so it's checked structurally, consistent with
// tests/security-boundaries.test.ts and tests/bulk-arrivals.test.ts's own
// convention for this project's route.ts files.
describe("app/api/purchases/bulk-delete/route.ts — dedicated multi-select bulk delete", () => {
  const source = readFileSync("app/api/purchases/bulk-delete/route.ts", "utf8");

  it("requires owner authentication, same as the other purchase routes", () => {
    expect(source).toContain("await requireOwner();");
  });

  it("validates the request body with a strict zod schema requiring at least one uuid", () => {
    expect(source).toContain("z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_DELETE_IDS) }).strict()");
    expect(source).toContain("bulkDeleteSchema.parse(await request.json())");
  });

  it("sets a sensible maximum batch size", () => {
    expect(source).toContain("const MAX_BULK_DELETE_IDS = 500;");
  });

  it("deduplicates the supplied ids before deleting", () => {
    expect(source).toContain("const uniqueIds = Array.from(new Set(ids));");
  });

  it("performs exactly one bulk DELETE via id=in.(...) — never a per-id loop of requests", () => {
    expect(source).toContain("purchases?id=in.(${uniqueIds.join(\",\")})");
    expect(source).toContain('method: "DELETE"');
    expect(source.match(/supabaseRequest\(/g)?.length).toBe(1);
  });

  it("REQUIREMENT: never reuses or triggers the existing clear-all path — no ?clear=all and no unconditional 'id=not.is.null' delete", () => {
    expect(source).not.toContain("clear=all");
    expect(source).not.toContain("id=not.is.null");
  });

  it("requests return=representation so the client can reconcile exactly which ids were actually deleted", () => {
    expect(source).toContain('Prefer: "return=representation"');
    expect(source).toContain("deletedIds: deleted.map(row => row.id)");
  });

  it("routes failures through the shared safeApiError helper, never leaking raw errors", () => {
    expect(source).toContain('return safeApiError(error, "Could not delete the selected purchases.");');
  });
});

describe("app/api/purchases/route.ts — existing clear-all and single-delete paths are unchanged", () => {
  const source = readFileSync("app/api/purchases/route.ts", "utf8");

  it("still supports the original ?clear=all path, untouched by the new dedicated bulk-delete route", () => {
    expect(source).toContain('if (params.get("clear") === "all")');
    expect(source).toContain('await supabaseRequest("purchases?id=not.is.null", { method: "DELETE" });');
  });

  it("still supports single-id delete by query param", () => {
    expect(source).toContain("await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}`, { method: \"DELETE\" });");
  });
});
