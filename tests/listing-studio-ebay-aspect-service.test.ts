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
    importedItemSpecifics: {}, sharedFacts: {}, vintedColours: [], vintedMaterial: null, productFacts: null, automationMode: "balanced" as const,
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

describe("resolveEbayAspects — automatic product-facts mapping (Live-diagnostic follow-up fix, real On Running Cloud 5 reproduction)", () => {
  const cloud5ProductFacts = {
    brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Blue", "Grey"], material: "Mesh",
    ukShoeSize: "4", clothingSize: null, gender: "womens" as const, itemFamily: "footwear" as const,
    internalSku: "1644", styleCode: null, conditionState: "very_good_preowned" as const, updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function footwearAspects() {
    getCachedItemAspects.mockResolvedValue({
      ok: true, data: { aspects: [
        { localizedAspectName: "Brand", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "On Running" }, { localizedValue: "Nike" }] },
        { localizedAspectName: "Department", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Women" }, { localizedValue: "Men" }] },
        { localizedAspectName: "UK Shoe Size", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "3" }, { localizedValue: "4" }, { localizedValue: "5" }, { localizedValue: "7" }] },
        { localizedAspectName: "Type", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Running Trainers" }, { localizedValue: "Trainers" }] },
        { localizedAspectName: "Colour", aspectConstraint: { aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "MULTI" }, aspectValues: [{ localizedValue: "Blue" }, { localizedValue: "Grey" }] },
        { localizedAspectName: "Upper Material", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Mesh" }, { localizedValue: "Leather" }] },
        { localizedAspectName: "Model", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "FREE_TEXT" } },
        { localizedAspectName: "Vintage", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Yes" }, { localizedValue: "No" }] },
        { localizedAspectName: "Customised", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Yes" }, { localizedValue: "No" }] },
        { localizedAspectName: "US Shoe Size", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "5" }, { localizedValue: "6" }] },
        { localizedAspectName: "EU Shoe Size", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "37" }, { localizedValue: "38" }] },
      ], stale: false },
    });
  }

  it("REQUIREMENT: maps Brand/Department/UK Shoe Size/Type/Colour/Upper Material/Model all automatically from productFacts, high confidence, never needing review", async () => {
    footwearAspects();
    const outcome = await resolveEbayAspects(baseInput({ productFacts: cloud5ProductFacts, brand: null, productType: null, model: null }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData.Brand).toMatchObject({ value: "On Running", confidence: "high", needsReview: false });
    expect(outcome.dynamicData.Department).toMatchObject({ value: "Women", confidence: "high", needsReview: false });
    expect(outcome.dynamicData["UK Shoe Size"]).toMatchObject({ value: "4", confidence: "high", needsReview: false });
    expect(outcome.dynamicData.Type).toMatchObject({ value: "Running Trainers", confidence: "high", needsReview: false });
    expect(outcome.dynamicData.Colour).toMatchObject({ value: ["Blue", "Grey"], confidence: "high", needsReview: false });
    expect(outcome.dynamicData["Upper Material"]).toMatchObject({ value: "Mesh", confidence: "high", needsReview: false });
    expect(outcome.dynamicData.Model).toMatchObject({ value: "Cloud 5", confidence: "high", needsReview: false });
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled(); // every REQUIRED/RECOMMENDED aspect resolved deterministically — no AI call needed
  });

  it("PROVEN ROOT CAUSE FIX: the deterministic below-UK-7 footwear rule wins over gender/vintedAudience for the Department aspect, even when they conflict", async () => {
    footwearAspects();
    const outcome = await resolveEbayAspects(baseInput({ productFacts: { ...cloud5ProductFacts, ukShoeSize: "4", gender: "mens" } }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData.Department).toMatchObject({ value: "Women", confidence: "high", needsReview: false, source: "footwear_size_rule" });
  });

  it("REQUIREMENT: at UK size 7 and above, the deterministic rule does not apply — Department falls back to the ordinary gender-derived candidate", async () => {
    footwearAspects();
    const outcome = await resolveEbayAspects(baseInput({ productFacts: { ...cloud5ProductFacts, ukShoeSize: "7", gender: "mens" } }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData.Department).toMatchObject({ value: "Men", source: "product_facts" });
  });

  it("REQUIREMENT: Vintage and Customised default to 'No', high confidence, never needing review, with no productFacts input required for them specifically", async () => {
    footwearAspects();
    const outcome = await resolveEbayAspects(baseInput({ productFacts: cloud5ProductFacts }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData.Vintage).toMatchObject({ value: "No", confidence: "high", needsReview: false });
    expect(outcome.dynamicData.Customised).toMatchObject({ value: "No", confidence: "high", needsReview: false });
  });

  it("PROVEN ROOT CAUSE FIX: US/EU Shoe Size are never auto-populated or guessed — marked not_applicable, excluded from the AI fallback too", async () => {
    footwearAspects();
    const outcome = await resolveEbayAspects(baseInput({ productFacts: cloud5ProductFacts }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData["US Shoe Size"]).toMatchObject({ value: null, source: "not_applicable" });
    expect(outcome.dynamicData["EU Shoe Size"]).toMatchObject({ value: null, source: "not_applicable" });
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled();
  });
});

describe("resolveEbayAspects — Performance/Activity for running trainers (screenshot fix)", () => {
  const cloud5ProductFacts = {
    brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Blue"], material: "Mesh",
    ukShoeSize: "4", clothingSize: null, gender: "womens" as const, itemFamily: "footwear" as const,
    internalSku: "1644", styleCode: null, conditionState: "very_good_preowned" as const, updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function aspectsWithPerformanceActivity(allowedActivityValues: string[], usage: "REQUIRED" | "RECOMMENDED" | "OPTIONAL" = "RECOMMENDED") {
    getCachedItemAspects.mockResolvedValue({
      ok: true, data: { aspects: [
        // eBay's real aspect name literally contains a slash.
        { localizedAspectName: "Performance/Activity", aspectConstraint: { aspectUsage: usage, aspectMode: "SELECTION_ONLY" }, aspectValues: allowedActivityValues.map(localizedValue => ({ localizedValue })) },
      ], stale: false },
    });
  }

  it("4/5/6/7/8. maps explicit running-trainer facts to the exact allowed 'Running & Jogging' value at HIGH confidence, no review, no AI call (slash in the aspect name does not break it)", async () => {
    aspectsWithPerformanceActivity(["Running & Jogging", "Gym & Training", "Walking"]);
    const outcome = await resolveEbayAspects(baseInput({ productFacts: cloud5ProductFacts, title: "On Running Cloud 5 Running Trainers Women's UK 4", brand: null, productType: null, model: null }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData["Performance/Activity"]).toMatchObject({
      value: "Running & Jogging", confidence: "high", needsReview: false, source: "footwear_activity_rule",
    });
    expect(runEbayAspectSuggestion).not.toHaveBeenCalled();
  });

  it("6. when the category uses the shorter 'Running' value instead, that exact value is selected at HIGH confidence", async () => {
    aspectsWithPerformanceActivity(["Basketball", "Running", "Tennis"]);
    const outcome = await resolveEbayAspects(baseInput({ productFacts: cloud5ProductFacts, title: "On Running Cloud 5 Running Trainers", brand: null, productType: null, model: null }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData["Performance/Activity"]).toMatchObject({ value: "Running", confidence: "high", needsReview: false });
  });

  it("9/10. an unsupported free-text value is NEVER stored — with no matching allowed value the aspect stays unresolved (recommended → blank, not a fabricated paraphrase)", async () => {
    aspectsWithPerformanceActivity(["Casual", "Skateboarding", "Fashion"]); // no running-ish value at all
    runEbayAspectSuggestion.mockResolvedValue({ status: "success", values: { "Performance/Activity": "Running & Jogging" }, model: "test", inputTokens: 1, outputTokens: 1 });
    const outcome = await resolveEbayAspects(baseInput({ productFacts: cloud5ProductFacts, title: "Running Trainers", brand: null, productType: null, model: null }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    // Neither the deterministic candidates nor the AI's paraphrase match an
    // allowed value → nothing stored, never "Running & Jogging" verbatim.
    expect(outcome.dynamicData["Performance/Activity"].value).toBeNull();
    expect(outcome.dynamicData["Performance/Activity"].confidence).toBe("unknown");
  });

  it("10. non-running footwear (gym trainers) gets no deterministic high-confidence value — falls to the ordinary heuristic/AI path", async () => {
    aspectsWithPerformanceActivity(["Running & Jogging", "Gym & Training"]);
    runEbayAspectSuggestion.mockResolvedValue({ status: "success", values: { "Performance/Activity": null }, model: "test", inputTokens: 0, outputTokens: 0 });
    const outcome = await resolveEbayAspects(baseInput({
      productFacts: { ...cloud5ProductFacts, productType: "Gym Trainers" }, title: "Reebok Nano Gym Trainers", brand: null, productType: null, model: null,
    }));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.dynamicData["Performance/Activity"].source).not.toBe("footwear_activity_rule");
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
