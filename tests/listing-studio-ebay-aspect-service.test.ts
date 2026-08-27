import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCachedCategoryTreeId, getCachedItemAspects, runEbayAspectSuggestion } = vi.hoisted(() => ({
  getCachedCategoryTreeId: vi.fn(),
  getCachedItemAspects: vi.fn(),
  runEbayAspectSuggestion: vi.fn(),
}));
vi.mock("@/lib/listing-studio/ebay-taxonomy-cache", () => ({ getCachedCategoryTreeId, getCachedItemAspects }));
vi.mock("@/lib/listing-studio/ebay-aspect-suggestion-ai", () => ({ runEbayAspectSuggestion }));

import { resolveEbayAspects, getEbayAspectDefinitions } from "@/lib/listing-studio/ebay-aspect-service";

function baseInput(overrides: Partial<Parameters<typeof resolveEbayAspects>[0]> = {}) {
  return {
    categoryId: "183454", brand: "Pokémon TCG", productType: "Elite Trainer Box", model: null, title: "Elite Trainer Box",
    importedItemSpecifics: {}, sharedFacts: {}, vintedColours: [], vintedMaterial: null, automationMode: "balanced" as const,
    ...overrides,
  };
}

beforeEach(() => {
  getCachedCategoryTreeId.mockReset(); getCachedItemAspects.mockReset(); runEbayAspectSuggestion.mockReset();
  getCachedCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: false } });
});

describe("resolveEbayAspects — honest failure passthrough", () => {
  it("surfaces not_configured without ever calling the AI step", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: false, error: "not_configured" });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome).toEqual({ status: "not_configured" });
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled();
  });

  it("surfaces an upstream aspect-fetch failure honestly", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: false, error: "timeout" });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome).toEqual({ status: "upstream_unavailable", reason: "timeout" });
  });
});

describe("resolveEbayAspects — deterministic matching before any AI call", () => {
  it("REQUIREMENT: an exact imported eBay item specific resolves an aspect with no AI call at all", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [{ localizedAspectName: "Game", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Pokémon TCG" }] }], stale: false } });
    const outcome = await resolveEbayAspects(baseInput({ importedItemSpecifics: { Game: "Pokémon TCG" } }));
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.dynamicData.Game).toMatchObject({ value: "Pokémon TCG", confidence: "high", source: "imported_ebay_item_specifics" });
    }
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled();
  });

  it("uses the product's own brand field to resolve a 'Brand' aspect", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [{ localizedAspectName: "Brand", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Pokémon TCG" }] }], stale: false } });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.dynamicData.Brand?.value).toBe("Pokémon TCG");
  });

  it("REQUIREMENT: never invents a value for an unresolvable OPTIONAL aspect — it stays null/unknown, never sent to the AI either", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [{ localizedAspectName: "Year Manufactured", aspectConstraint: { aspectUsage: "OPTIONAL", aspectMode: "FREE_TEXT" } }], stale: false } });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.dynamicData["Year Manufactured"]).toMatchObject({ value: null, confidence: "unknown" });
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled();
  });
});

describe("resolveEbayAspects — bounded AI fallback for unresolved required/recommended aspects", () => {
  it("sends only the unresolved REQUIRED/RECOMMENDED selection-only aspects to the AI step", async () => {
    getCachedItemAspects.mockResolvedValue({
      ok: true, data: { aspects: [
        { localizedAspectName: "Set", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Prismatic Evolutions" }] },
        { localizedAspectName: "Configuration", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "FREE_TEXT" } },
      ], stale: false },
    });
    runEbayAspectSuggestion.mockResolvedValue({ status: "success", values: { Set: "Prismatic Evolutions" }, model: "test", inputTokens: 1, outputTokens: 1 });
    const outcome = await resolveEbayAspects(baseInput());
    expect(runEbayAspectSuggestion).toHaveBeenCalledTimes(1);
    const sentAspects = runEbayAspectSuggestion.mock.calls[0][1];
    expect(sentAspects.map((a: { name: string }) => a.name)).toEqual(["Set"]); // FREE_TEXT Configuration never sent
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.dynamicData.Set?.value).toBe("Prismatic Evolutions");
  });

  it("REQUIREMENT: an AI 'no confident match' (null) leaves the aspect unknown, never a fabricated value", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [{ localizedAspectName: "Set", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "X" }] }], stale: false } });
    runEbayAspectSuggestion.mockResolvedValue({ status: "success", values: { Set: null }, model: "test", inputTokens: 1, outputTokens: 1 });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.dynamicData.Set).toMatchObject({ value: null, confidence: "unknown" });
  });

  it("a failed AI call leaves unresolved aspects unknown rather than crashing the whole pipeline", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [{ localizedAspectName: "Set", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "X" }] }], stale: false } });
    runEbayAspectSuggestion.mockResolvedValue({ status: "request_failed" });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.dynamicData.Set?.confidence).toBe("unknown");
  });

  it("propagates a stale flag from either the tree or the aspects cache", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: true } });
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [], stale: false } });
    const outcome = await resolveEbayAspects(baseInput());
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.stale).toBe(true);
  });
});

describe("getEbayAspectDefinitions — read-only, no matching, no AI", () => {
  it("REQUIREMENT: never calls the AI suggestion step — this is purely definitions", async () => {
    getCachedItemAspects.mockResolvedValue({ ok: true, data: { aspects: [{ localizedAspectName: "Game", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Pokémon TCG" }] }], stale: false } });
    const outcome = await getEbayAspectDefinitions("183454");
    expect(outcome).toEqual({ status: "success", grouped: { required: [{ name: "Game", usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["Pokémon TCG"] }], recommended: [], optional: [] }, stale: false });
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled();
  });

  it("surfaces not_configured honestly", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: false, error: "not_configured" });
    expect(await getEbayAspectDefinitions("183454")).toEqual({ status: "not_configured" });
  });
});
