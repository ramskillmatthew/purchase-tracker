import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll, runVintedCategorySelection, runVintedAudienceTextReassessment } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string) => new Response(JSON.stringify([]), { status: 200 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  runVintedCategorySelection: vi.fn(),
  runVintedAudienceTextReassessment: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
vi.mock("@/lib/listing-studio/vinted-category-selection-ai", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-category-selection-ai")>();
  return { ...actual, runVintedCategorySelection };
});
vi.mock("@/lib/listing-studio/vinted-audience-reassessment-ai", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-audience-reassessment-ai")>();
  return { ...actual, runVintedAudienceTextReassessment };
});

import { resolveVintedCategoryAssignment, resolveVintedCategoryAssignmentForExistingDraft, describeVintedCategoryAssignmentReason } from "@/lib/listing-studio/vinted-category-assignment";

function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1231, root_id: 5, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null, ...overrides };
}

beforeEach(() => {
  supabaseRequest.mockReset(); supabaseRequestAll.mockReset(); runVintedCategorySelection.mockReset(); runVintedAudienceTextReassessment.mockReset();
  supabaseRequest.mockImplementation(async (path: string) => (
    path.startsWith("vinted_categories?") ? new Response(JSON.stringify([]), { status: 200 }) : new Response(null, { status: 204 })
  ));
});

describe("resolveVintedCategoryAssignment — Men + Trainers / Women + Trainers resolve to the real verified leaves", () => {
  it("Men + Trainers deterministically resolves to Men > Shoes > Trainers, using the genuine catalogue id — no hard-coded/invented id", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_categories?") && path.includes("Men")) {
        return new Response(JSON.stringify([{ id: 1906, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    supabaseRequestAll.mockResolvedValueOnce([categoryRow()]); // getVintedCategoryById(1906)

    const { result, aiCost } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: "Nike", model: "Air" });
    expect(result).toEqual({ reason: "category_assigned", categoryId: 1906, categoryPath: "Men > Shoes > Trainers", method: "deterministic" });
    expect(aiCost).toBeNull();
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
  });

  it("Women + Trainers deterministically resolves to Women > Shoes > Trainers", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_categories?") && path.includes("Women")) {
        return new Response(JSON.stringify([{ id: 2001, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2001, full_path: "Women > Shoes > Trainers", root_id: 1904, audience: "womens" })]);

    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "womens", productType: "Trainers", brand: null, model: null });
    expect(result).toEqual({ reason: "category_assigned", categoryId: 2001, categoryPath: "Women > Shoes > Trainers", method: "deterministic" });
  });

  it("the search is scoped to the Men branch's own path — never sends the query to the Women branch or vice versa", async () => {
    await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: null, model: null });
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain(encodeURIComponent("Men > Shoes%"));
    expect(path).not.toContain(encodeURIComponent("Women"));
  });
});

describe("resolveVintedCategoryAssignment — Business-rule follow-up correction: footwear must never be listed under a children's Vinted audience (boys/girls -> womens)", () => {
  it("Boys + footwear: searches the WOMEN'S branch, never the Kids Boys branch, and returns the normalised 'womens' audience", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2632, full_path: "Women > Shoes > Trainers", audience: "womens" })]);

    const { result, vintedAudience } = await resolveVintedCategoryAssignment({ vintedAudience: "boys", productType: "Trainers", brand: null, model: null });

    expect(vintedAudience).toBe("womens");
    expect(result).toEqual({ reason: "category_assigned", categoryId: 2632, categoryPath: "Women > Shoes > Trainers", method: "deterministic" });
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain(encodeURIComponent("Women > Shoes%"));
    expect(path).not.toContain(encodeURIComponent("Kids"));
  });

  it("Girls + footwear: searches the WOMEN'S branch, never the Kids Girls branch, and returns the normalised 'womens' audience", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2632, full_path: "Women > Shoes > Trainers", audience: "womens" })]);

    const { result, vintedAudience } = await resolveVintedCategoryAssignment({ vintedAudience: "girls", productType: "Trainers", brand: null, model: null });

    expect(vintedAudience).toBe("womens");
    expect(result).toMatchObject({ reason: "category_assigned", categoryId: 2632 });
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain(encodeURIComponent("Women > Shoes%"));
    expect(path).not.toContain(encodeURIComponent("Kids"));
  });

  it("REGRESSION: Boys/Girls on a CLOTHING product type is never normalised — still resolves via the real Kids branch, audience returned unchanged", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Kids")
        ? new Response(JSON.stringify([{ id: 1195, label: "Jacket", full_path: "Kids > Girls clothing > Jacket", audience: "girls", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 1195, full_path: "Kids > Girls clothing > Jacket", audience: "girls" })]);

    const { vintedAudience } = await resolveVintedCategoryAssignment({ vintedAudience: "girls", productType: "Jacket", brand: null, model: null });
    expect(vintedAudience).toBe("girls");
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain(encodeURIComponent("Kids > Girls clothing%"));
  });

  it("Men/Women footwear are returned completely unchanged (never accidentally touched by the boys/girls-only rule)", async () => {
    const men = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: null, model: null });
    expect(men.vintedAudience).toBe("mens");
    const women = await resolveVintedCategoryAssignment({ vintedAudience: "womens", productType: "Trainers", brand: null, model: null });
    expect(women.vintedAudience).toBe("womens");
  });

  it("Unisex/Unknown footwear are returned completely unchanged", async () => {
    const unisex = await resolveVintedCategoryAssignment({ vintedAudience: "unisex", productType: "Trainers", brand: null, model: null });
    expect(unisex.vintedAudience).toBe("unisex");
    expect(unisex.result.reason).toBe("audience_missing"); // unisex has no automatic branch — unrelated to this rule
    const unknown = await resolveVintedCategoryAssignment({ vintedAudience: "unknown", productType: "Trainers", brand: null, model: null });
    expect(unknown.vintedAudience).toBe("unknown");
  });
});

describe("resolveVintedCategoryAssignmentForExistingDraft — Business-rule follow-up correction: normalises boys/girls footwear even for a manually-protected audience", () => {
  it("a MANUALLY-protected boys/girls footwear audience is still normalised to womens — manual protection only means 'don't re-run AI reassessment', never 'keep a value that violates this business rule'", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2632, full_path: "Women > Shoes > Trainers", audience: "womens" })]);

    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "boys", vintedAudienceSource: "manual", vintedAudienceEvidence: null,
      productType: "Trainers", brand: "Nike", model: "Air",
    });

    expect(outcome.vintedAudience).toBe("womens");
    expect(runVintedAudienceTextReassessment).not.toHaveBeenCalled(); // still protected from AI re-guessing
    expect(outcome.result).toMatchObject({ reason: "category_assigned", categoryId: 2632 });
  });

  it("a MANUALLY-protected girls footwear audience is likewise normalised", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2632, full_path: "Women > Shoes > Trainers", audience: "womens" })]);

    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "girls", vintedAudienceSource: "manual", vintedAudienceEvidence: null,
      productType: "Trainers", brand: null, model: null,
    });
    expect(outcome.vintedAudience).toBe("womens");
  });

  it("REGRESSION: a manually-protected WOMEN'S footwear audience remains completely untouched — this rule only ever converts boys/girls, never re-decides an already-valid audience", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2632, full_path: "Women > Shoes > Trainers", audience: "womens" })]);

    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "womens", vintedAudienceSource: "manual", vintedAudienceEvidence: null,
      productType: "Trainers", brand: null, model: null,
    });
    expect(outcome.vintedAudience).toBe("womens");
    expect(runVintedAudienceTextReassessment).not.toHaveBeenCalled();
  });
});

describe("resolveVintedCategoryAssignment — Follow-up correction (2026-08-07): production bug fix, 'Running Trainers' no longer returns no_candidates. Uses the real, live-verified catalogue leaves for both audiences (Women > Shoes > Trainers id 2632 / Women > Shoes > Sports shoes > Running shoes id 2651; Men > Shoes > Trainers id 1242 / Men > Shoes > Sports shoes > Running shoes id 1453) — see vinted-categories-data.ts's own comment for the root cause this fixes.", () => {
  it("REGRESSION (the exact ASICS Novablast 4 / On Cloud 5 production examples): Women + 'Running Trainers' returns BOTH real women's running-footwear candidates to the AI selector — never zero", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([
            { id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null },
            { id: 2651, label: "Running shoes", full_path: "Women > Shoes > Sports shoes > Running shoes", audience: "womens", item_family: null },
          ]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: 2632, model: "claude-sonnet-5", inputTokens: 50, outputTokens: 5 });
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2632, full_path: "Women > Shoes > Trainers", audience: "womens" })]);

    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "womens", productType: "Running Trainers", brand: "ASICS", model: "Novablast 4" });

    expect(runVintedCategorySelection).toHaveBeenCalledOnce();
    const [, candidatesPassed] = runVintedCategorySelection.mock.calls[0];
    expect(candidatesPassed.map((c: { id: number }) => c.id).sort((a: number, b: number) => a - b)).toEqual([2632, 2651]);
    expect(result).toMatchObject({ reason: "category_assigned", categoryId: 2632, categoryPath: "Women > Shoes > Trainers", method: "ai" });
  });

  it("REGRESSION (the exact On Cloud 5 mens production example): Men + 'Running Trainers' returns BOTH real men's running-footwear candidates to the AI selector — never zero", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Men") && !path.includes("Women")
        ? new Response(JSON.stringify([
            { id: 1242, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null },
            { id: 1453, label: "Running shoes", full_path: "Men > Shoes > Sports shoes > Running shoes", audience: "mens", item_family: null },
          ]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: 1453, model: "claude-sonnet-5", inputTokens: 50, outputTokens: 5 });
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 1453, full_path: "Men > Shoes > Sports shoes > Running shoes", audience: "mens" })]);

    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Running Trainers", brand: "On", model: "Cloud 5" });

    expect(runVintedCategorySelection).toHaveBeenCalledOnce();
    const [, candidatesPassed] = runVintedCategorySelection.mock.calls[0];
    expect(candidatesPassed.map((c: { id: number }) => c.id).sort((a: number, b: number) => a - b)).toEqual([1242, 1453]);
    expect(result).toMatchObject({ reason: "category_assigned", categoryId: 1453, categoryPath: "Men > Shoes > Sports shoes > Running shoes", method: "ai" });
  });

  it("category ids stay numbers end-to-end — never stringified, never silently coerced", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Men")
        ? new Response(JSON.stringify([{ id: 1242, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 1242, full_path: "Men > Shoes > Trainers", audience: "mens" })]);

    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: "On", model: "Cloud 5" });
    expect(result.reason).toBe("category_assigned");
    if (result.reason === "category_assigned") expect(typeof result.categoryId).toBe("number");
    expect(runVintedCategorySelection).not.toHaveBeenCalled(); // exactly one real candidate -> deterministic, no AI call needed
  });

  it("exact suitable deterministic match (using a real, narrow catalogue leaf) avoids a second AI call entirely", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2644, label: "Golf shoes", full_path: "Women > Shoes > Sports shoes > Golf shoes", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2644, full_path: "Women > Shoes > Sports shoes > Golf shoes", audience: "womens" })]);

    const { result, aiCost } = await resolveVintedCategoryAssignment({ vintedAudience: "womens", productType: "Golf Shoes", brand: null, model: null });
    expect(result).toMatchObject({ reason: "category_assigned", categoryId: 2644, method: "deterministic" });
    expect(aiCost).toBeNull();
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
  });
});

describe("resolveVintedCategoryAssignment — the exact four live production examples reported (all had audience resolved, vinted_category_status stuck on 'no_candidates')", () => {
  const examples = [
    { brand: "ASICS", model: "Novablast 4", audience: "womens" as const, branch: "Women", trainersId: 2632, runningId: 2651 },
    { brand: "On", model: "Cloud 5", audience: "mens" as const, branch: "Men", trainersId: 1242, runningId: 1453 },
    { brand: "On", model: "Cloud 5 Waterproof", audience: "womens" as const, branch: "Women", trainersId: 2632, runningId: 2651 },
    { brand: "On", model: "Cloud 5", audience: "womens" as const, branch: "Women", trainersId: 2632, runningId: 2651 },
  ];

  it.each(examples)("$brand $model, audience $audience, productType 'Running Trainers' — resolves via the real catalogue leaves, never no_candidates", async ({ brand, model, audience, branch, trainersId, runningId }) => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes(branch)
        ? new Response(JSON.stringify([
            { id: trainersId, label: "Trainers", full_path: `${branch} > Shoes > Trainers`, audience, item_family: null },
            { id: runningId, label: "Running shoes", full_path: `${branch} > Shoes > Sports shoes > Running shoes`, audience, item_family: null },
          ]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: trainersId, model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 });
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: trainersId, full_path: `${branch} > Shoes > Trainers`, audience })]);

    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: audience, productType: "Running Trainers", brand, model });
    expect(result.reason).toBe("category_assigned");
    if (result.reason === "category_assigned") expect(result.categoryId).toBe(trainersId);
  });
});

describe("resolveVintedCategoryAssignment — every reason code", () => {
  it("audience_missing when vintedAudience is 'unknown', 'unisex', or null — never a guess", async () => {
    for (const audience of ["unknown", "unisex", null] as const) {
      const { result, aiCost } = await resolveVintedCategoryAssignment({ vintedAudience: audience, productType: "Trainers", brand: null, model: null });
      expect(result.reason).toBe("audience_missing");
      expect(aiCost).toBeNull();
    }
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("no_candidates when a known audience+item-family search finds nothing", async () => {
    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: null, model: null });
    expect(result.reason).toBe("no_candidates");
  });

  it("item_family_uncertain when productType gives no clothing/footwear signal and the broadened search finds nothing", async () => {
    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Widget", brand: null, model: null });
    expect(result.reason).toBe("item_family_uncertain");
  });

  it("ai_selection_failed when the bounded AI call itself fails", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?")
        ? new Response(JSON.stringify([{ id: 1, label: "A", full_path: "Men > Shoes > A", audience: "mens", item_family: null }, { id: 2, label: "B", full_path: "Men > Shoes > B", audience: "mens", item_family: null }]), { status: 200 })
        : new Response(null, { status: 204 })
    ));
    runVintedCategorySelection.mockResolvedValueOnce({ status: "request_failed" });
    const { result, aiCost } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: null, model: null });
    expect(result.reason).toBe("ai_selection_failed");
    expect(aiCost).toEqual({ model: null, inputTokens: null, outputTokens: null, candidateCount: 2, status: "failed" });
  });

  it("ai_selection_invalid when the AI confidently finds no good candidate among genuine options", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?")
        ? new Response(JSON.stringify([{ id: 1, label: "A", full_path: "Men > Shoes > A", audience: "mens", item_family: null }, { id: 2, label: "B", full_path: "Men > Shoes > B", audience: "mens", item_family: null }]), { status: 200 })
        : new Response(null, { status: 204 })
    ));
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: null, model: "claude-sonnet-5", inputTokens: 10, outputTokens: 2 });
    const { result, aiCost } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: null, model: null });
    expect(result.reason).toBe("ai_selection_invalid");
    expect(aiCost?.status).toBe("success");
  });

  it("category_assigned via the AI path when multiple candidates exist and the AI picks a genuine one", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?")
        ? new Response(JSON.stringify([{ id: 1, label: "A", full_path: "Men > Shoes > A", audience: "mens", item_family: null }, { id: 2, label: "B", full_path: "Men > Shoes > B", audience: "mens", item_family: null }]), { status: 200 })
        : new Response(null, { status: 204 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2, full_path: "Men > Shoes > B" })]);
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: 2, model: "claude-sonnet-5", inputTokens: 10, outputTokens: 2 });
    const { result } = await resolveVintedCategoryAssignment({ vintedAudience: "mens", productType: "Trainers", brand: null, model: null });
    expect(result).toMatchObject({ reason: "category_assigned", categoryId: 2, method: "ai" });
  });
});

describe("resolveVintedCategoryAssignmentForExistingDraft — follow-up correction (2026-08-05): tries a cheap text-only audience reassessment before giving up", () => {
  it("existing draft reassessment uses stored evidence first: attempts text reassessment (never photos) when audience is unknown and there's a stored text signal, passing the prior audience/evidence through", async () => {
    runVintedAudienceTextReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "mens", vintedAudienceEvidence: ["Model identified as the men's version"],
      model: "claude-sonnet-5", inputTokens: 100, outputTokens: 10,
    });
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Men")
        ? new Response(JSON.stringify([{ id: 1906, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow()]);

    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "unknown", vintedAudienceSource: "ai", vintedAudienceEvidence: ["Label in photo 1 shows UK 5 / EU 37.5"],
      productType: "Trainers", brand: "New Balance", model: "327",
    });

    expect(runVintedAudienceTextReassessment).toHaveBeenCalledWith(expect.objectContaining({
      brand: "New Balance", model: "327", productType: "Trainers",
      priorVintedAudience: "unknown", priorEvidence: ["Label in photo 1 shows UK 5 / EU 37.5"],
    }));
    expect(outcome.audienceReassessmentAttempted).toBe(true);
    expect(outcome.vintedAudience).toBe("mens");
    expect(outcome.vintedAudienceEvidence).toEqual(["Model identified as the men's version"]);
    expect(outcome.result).toMatchObject({ reason: "category_assigned", categoryId: 1906 });
  });

  it("Audience required appears only after meaningful evidence evaluation: when there IS a stored text signal, the text reassessment is tried before audience_missing is ever returned", async () => {
    runVintedAudienceTextReassessment.mockResolvedValueOnce({ status: "success", vintedAudience: "unknown", vintedAudienceEvidence: [], model: "claude-sonnet-5", inputTokens: 50, outputTokens: 5 });
    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "unknown", vintedAudienceSource: "ai", vintedAudienceEvidence: null,
      productType: "Trainers", brand: "New Balance", model: "327",
    });
    expect(runVintedAudienceTextReassessment).toHaveBeenCalledOnce();
    expect(outcome.result.reason).toBe("audience_missing");
    expect(outcome.canReassessWithPhotos).toBe(true);
  });

  it("never wastes an AI call when there is genuinely no stored text signal at all", async () => {
    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "unknown", vintedAudienceSource: "ai", vintedAudienceEvidence: null,
      productType: null, brand: null, model: null,
    });
    expect(runVintedAudienceTextReassessment).not.toHaveBeenCalled();
    expect(outcome.audienceReassessmentAttempted).toBe(false);
    expect(outcome.result.reason).toBe("audience_missing");
  });

  it("manual audience remains protected: never attempts reassessment when the audience source is manual, even if it's 'unknown'", async () => {
    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "unknown", vintedAudienceSource: "manual", vintedAudienceEvidence: null,
      productType: "Trainers", brand: "New Balance", model: "327",
    });
    expect(runVintedAudienceTextReassessment).not.toHaveBeenCalled();
    expect(outcome.audienceReassessmentAttempted).toBe(false);
    expect(outcome.vintedAudience).toBe("unknown");
  });

  it("a manually-set, already-resolved audience is used as-is and never re-sent to the AI", async () => {
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2001, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow({ id: 2001, full_path: "Women > Shoes > Trainers", audience: "womens" })]);
    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "womens", vintedAudienceSource: "manual", vintedAudienceEvidence: null,
      productType: "Trainers", brand: "New Balance", model: "327",
    });
    expect(runVintedAudienceTextReassessment).not.toHaveBeenCalled();
    expect(outcome.vintedAudience).toBe("womens");
    expect(outcome.result).toMatchObject({ reason: "category_assigned" });
  });

  it("a failed text reassessment leaves the audience unchanged and still reports audience_missing, never crashes", async () => {
    runVintedAudienceTextReassessment.mockResolvedValueOnce({ status: "request_failed" });
    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "unknown", vintedAudienceSource: "ai", vintedAudienceEvidence: null,
      productType: "Trainers", brand: "New Balance", model: "327",
    });
    expect(outcome.vintedAudience).toBe("unknown");
    expect(outcome.audienceAiCost).toEqual({ model: null, inputTokens: null, outputTokens: null, status: "failed" });
    expect(outcome.result.reason).toBe("audience_missing");
  });

  it("canReassessWithPhotos is true exactly when the final result is still audience_missing, false for every other reason", async () => {
    const stillUnknown = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "unknown", vintedAudienceSource: "ai", vintedAudienceEvidence: null, productType: null, brand: null, model: null,
    });
    expect(stillUnknown.canReassessWithPhotos).toBe(true);

    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Men")
        ? new Response(JSON.stringify([{ id: 1906, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));
    supabaseRequestAll.mockResolvedValueOnce([categoryRow()]);
    const resolved = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: "mens", vintedAudienceSource: "manual", vintedAudienceEvidence: null, productType: "Trainers", brand: "Nike", model: "Air",
    });
    expect(resolved.canReassessWithPhotos).toBe(false);
  });
});

describe("describeVintedCategoryAssignmentReason — safe, actionable, fixed messages", () => {
  it("audience_missing produces the actionable Men/Women prompt", () => {
    expect(describeVintedCategoryAssignmentReason("audience_missing")).toMatch(/Men or Women/);
  });

  it("returns a non-empty string for every reason, never a raw internal code", () => {
    const reasons = ["audience_missing", "item_family_uncertain", "no_candidates", "too_many_candidates", "ai_selection_failed", "ai_selection_invalid", "category_assigned"] as const;
    for (const reason of reasons) {
      const message = describeVintedCategoryAssignmentReason(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(reason);
    }
  });
});
