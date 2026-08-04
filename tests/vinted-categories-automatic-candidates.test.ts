import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string) => new Response(JSON.stringify([]), { status: 200 })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll: vi.fn(async () => []) }));

import { searchAutomaticSelectionCandidates, MAX_AUTOMATIC_SELECTION_CANDIDATES } from "@/lib/listing-studio/vinted-categories-data";

function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: 1906, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null, ...overrides };
}

beforeEach(() => { supabaseRequest.mockClear(); supabaseRequest.mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 })); });

describe("searchAutomaticSelectionCandidates — the one query the AI candidate list is built from", () => {
  it("returns no results and never queries at all when no branches are supplied (e.g. audience 'unknown')", async () => {
    const results = await searchAutomaticSelectionCandidates({ branchFullPaths: [] });
    expect(results).toEqual([]);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("with no productType query, issues exactly ONE query combining multiple branch prefixes via a single nested OR group — never one query per branch", async () => {
    await searchAutomaticSelectionCandidates({ branchFullPaths: ["Kids > Girls clothing", "Kids > Girls clothing > Shoes"] });
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain("or(");
    expect(path).toContain(encodeURIComponent("Kids > Girls clothing%"));
    expect(path).toContain(encodeURIComponent("Kids > Girls clothing > Shoes%"));
  });

  it("only ever queries active + selectable categories (parents and inactive categories excluded)", async () => {
    await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"] });
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain("is_active.eq.true");
    expect(path).toContain("is_selectable.eq.true");
  });

  it("is hard-capped at 25 candidates — never more, regardless of how many categories exist under the branch", async () => {
    await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Clothing"] });
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain(`limit=${MAX_AUTOMATIC_SELECTION_CANDIDATES}`);
    expect(MAX_AUTOMATIC_SELECTION_CANDIDATES).toBe(25);
  });

  it("maps the raw rows into the expected candidate shape", async () => {
    supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([categoryRow()]), { status: 200 }));
    const results = await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"] });
    expect(results).toEqual([{ id: 1906, label: "Trainers", fullPath: "Women > Shoes > Trainers", audience: "womens", itemFamily: null }]);
  });

  describe("Follow-up correction (2026-08-07) — production bug fix: productType narrows by individual WORD (OR'd), never the whole phrase as one literal substring", () => {
    it("REGRESSION (the exact production bug): 'Running Trainers' narrows by 'running' OR 'trainers' independently — never requires the literal phrase 'Running Trainers' to appear anywhere", async () => {
      supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([
        categoryRow({ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers" }),
        categoryRow({ id: 2651, label: "Running shoes", full_path: "Women > Shoes > Sports shoes > Running shoes" }),
      ]), { status: 200 }));
      const results = await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"], query: "Running Trainers" });
      expect(supabaseRequest).toHaveBeenCalledTimes(1);
      const [path] = supabaseRequest.mock.calls[0];
      expect(path).not.toContain(encodeURIComponent("Running Trainers"));
      expect(path).toContain(`full_path.ilike.*${encodeURIComponent("running")}*`);
      expect(path).toContain(`full_path.ilike.*${encodeURIComponent("trainers")}*`);
      expect(results.map((r) => r.id).sort()).toEqual([2632, 2651]);
    });

    it("the keyword OR-group is nested inside the same and=(...) as the branch OR-group and the active/selectable filters — a genuine AND of two independent OR-groups, not one flat OR of everything", async () => {
      await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"], query: "Trainers" });
      const [path] = supabaseRequest.mock.calls[0];
      expect(path).toMatch(/and=\(is_active\.eq\.true,is_selectable\.eq\.true,or\(.*\),or\(.*\)\)/);
    });

    it("REGRESSION: falls back to the unnarrowed branch scope when the keyword-narrowed query finds nothing — a vocabulary mismatch must never be mistaken for 'no real candidates exist'", async () => {
      supabaseRequest
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })) // narrowed query: nothing
        .mockResolvedValueOnce(new Response(JSON.stringify([categoryRow()]), { status: 200 })); // fallback: real candidates
      const results = await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"], query: "Completely Unmatched Wording" });
      expect(supabaseRequest).toHaveBeenCalledTimes(2);
      const [narrowedPath] = supabaseRequest.mock.calls[0];
      const [fallbackPath] = supabaseRequest.mock.calls[1];
      expect(narrowedPath).toContain("unmatched");
      // The fallback query keeps the branch scope + active/selectable, but drops the keyword OR-group entirely.
      expect(fallbackPath).not.toContain("unmatched");
      expect(fallbackPath).toMatch(/and=\(is_active\.eq\.true,is_selectable\.eq\.true,or\([^)]*\)\)/);
      expect(results).toEqual([{ id: 1906, label: "Trainers", fullPath: "Women > Shoes > Trainers", audience: "womens", itemFamily: null }]);
    });

    it("skips keyword narrowing entirely (single query, no second OR-group) when productType has no meaningful words", async () => {
      await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"], query: "Shoes" });
      expect(supabaseRequest).toHaveBeenCalledTimes(1);
      const [path] = supabaseRequest.mock.calls[0];
      expect(path).toMatch(/and=\(is_active\.eq\.true,is_selectable\.eq\.true,or\([^)]*\)\)/);
    });

    it("skips keyword narrowing entirely when no query is supplied at all", async () => {
      await searchAutomaticSelectionCandidates({ branchFullPaths: ["Women > Shoes"] });
      expect(supabaseRequest).toHaveBeenCalledTimes(1);
    });
  });
});
