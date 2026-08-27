import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCachedCategoryTreeId, getCategorySuggestions, runEbayCategoryRanking } = vi.hoisted(() => ({
  getCachedCategoryTreeId: vi.fn(),
  getCategorySuggestions: vi.fn(),
  runEbayCategoryRanking: vi.fn(),
}));
vi.mock("@/lib/listing-studio/ebay-taxonomy-cache", () => ({ getCachedCategoryTreeId }));
vi.mock("@/lib/listing-studio/ebay-taxonomy-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-taxonomy-client")>();
  return { ...actual, getCategorySuggestions };
});
vi.mock("@/lib/listing-studio/ebay-category-ranking-ai", () => ({ runEbayCategoryRanking }));

import { suggestEbayCategory, describeEbayCategorySuggestionFailure } from "@/lib/listing-studio/ebay-category-service";

const ORIGINAL_ENV = { ...process.env };

function facts(overrides: Partial<Parameters<typeof suggestEbayCategory>[0]> = {}) {
  return { brand: "Pokémon TCG", productType: "Elite Trainer Box", model: null, set: "Prismatic Evolutions", configuration: null, title: null, knownCategoryName: null, keyAttributes: ["sealed"], ...overrides };
}

function suggestion(categoryId: string, categoryName: string, relevancy: string) {
  return { category: { categoryId, categoryName }, categoryTreeNodeAncestors: [{ categoryId: "1", categoryName: "Collectables" }], relevancy };
}

beforeEach(() => {
  getCachedCategoryTreeId.mockReset(); getCategorySuggestions.mockReset(); runEbayCategoryRanking.mockReset();
  getCachedCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: false } });
  process.env.EBAY_CLIENT_ID = "test-id";
  process.env.EBAY_CLIENT_SECRET = "test-secret";
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => { vi.unstubAllEnvs(); process.env = { ...ORIGINAL_ENV }; });

describe("suggestEbayCategory — no usable search terms", () => {
  it("returns no_results without ever calling eBay when structured facts produce no search terms", async () => {
    const outcome = await suggestEbayCategory(facts({ brand: null, productType: null, set: null, keyAttributes: [] }));
    expect(outcome.status).toBe("no_results");
    expect(getCachedCategoryTreeId).not.toHaveBeenCalled();
  });
});

describe("suggestEbayCategory — honest failure passthrough", () => {
  it("REQUIREMENT: surfaces not_configured rather than fabricating a category", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: false, error: "not_configured" });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome).toEqual({ status: "not_configured" });
  });

  it("surfaces an upstream failure honestly", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: false, error: "timeout" });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome).toEqual({ status: "upstream_unavailable", reason: "timeout" });
  });

  it("no_results when eBay genuinely returns nothing", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [] });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("no_results");
  });

  it("describeEbayCategorySuggestionFailure never exposes a raw provider error", () => {
    expect(describeEbayCategorySuggestionFailure({ status: "not_configured" })).toBe("eBay category access has not been configured yet.");
    expect(describeEbayCategorySuggestionFailure({ status: "upstream_unavailable", reason: "rate_limited" })).toMatch(/rate-limiting/);
  });
});

describe("suggestEbayCategory — deterministic ranking by eBay's own relevancy", () => {
  it("REQUIREMENT: exactly one candidate with a specific enough query is selected with high confidence", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "300.0")] });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.selected.categoryId).toBe("183454");
      expect(outcome.selected.confidence).toBe("high");
      expect(outcome.selected.categoryPath).toBe("Collectables > CCG Sealed Boxes");
      expect(outcome.alternatives).toEqual([]);
    }
    expect(runEbayCategoryRanking).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: a clear relevancy leader (large gap) is selected automatically with high confidence, no AI call needed", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "300.0"), suggestion("183455", "Individual Cards", "50.0")] });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.selected.categoryId).toBe("183454");
      expect(outcome.selected.confidence).toBe("high");
    }
    expect(runEbayCategoryRanking).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: a moderate gap is selected with medium confidence and flagged alternatives, still no AI call", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "200.0"), suggestion("183455", "Individual Cards", "170.0")] });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.selected.confidence).toBe("medium");
      expect(outcome.alternatives.length).toBeGreaterThan(0);
    }
    expect(runEbayCategoryRanking).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: a genuinely close race sends the real candidates to the bounded AI ranking step", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "200.0"), suggestion("183455", "Individual Cards", "195.0")] });
    runEbayCategoryRanking.mockResolvedValue({ status: "success", categoryId: "183454", reason: "Matches a sealed box.", model: "test", inputTokens: 1, outputTokens: 1 });
    const outcome = await suggestEbayCategory(facts());
    expect(runEbayCategoryRanking).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.selected.categoryId).toBe("183454");
      expect(outcome.selected.confidence).toBe("medium");
      expect(outcome.selected.reason).toBe("Matches a sealed box.");
    }
  });

  it("REGRESSION: the AI can only choose among the candidates eBay actually returned — verified by construction (runEbayCategoryRanking's own schema does the real enforcement, tested separately)", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "200.0"), suggestion("183455", "Individual Cards", "195.0")] });
    runEbayCategoryRanking.mockResolvedValue({ status: "success", categoryId: null, reason: "", model: "test", inputTokens: 1, outputTokens: 1 });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      // AI declined -> falls back to eBay's own top relevancy result, honestly low confidence.
      expect(outcome.selected.categoryId).toBe("183454");
      expect(outcome.selected.confidence).toBe("low");
    }
  });

  it("falls back to the top relevancy result, honestly low confidence, when the AI ranking call itself fails", async () => {
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "200.0"), suggestion("183455", "Individual Cards", "195.0")] });
    runEbayCategoryRanking.mockResolvedValue({ status: "request_failed" });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.selected.confidence).toBe("low");
  });

  it("propagates a stale-cache flag honestly rather than hiding it", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: true } });
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [suggestion("183454", "CCG Sealed Boxes", "300.0")] });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.stale).toBe(true);
  });
});

describe("suggestEbayCategory — development-only fixture gate", () => {
  it("REQUIREMENT: uses the fixture (never the real API) when credentials are absent AND NODE_ENV is not production", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    vi.stubEnv("NODE_ENV", "development");
    const outcome = await suggestEbayCategory(facts());
    expect(outcome.status).toBe("success");
    expect(getCachedCategoryTreeId).not.toHaveBeenCalled();
    expect(getCategorySuggestions).not.toHaveBeenCalled();
  });

  it("REQUIREMENT (safety-critical): NEVER uses the fixture when NODE_ENV is production, even with no credentials — an honest not_configured error instead", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    getCachedCategoryTreeId.mockResolvedValue({ ok: false, error: "not_configured" });
    const outcome = await suggestEbayCategory(facts());
    expect(outcome).toEqual({ status: "not_configured" });
  });
});
