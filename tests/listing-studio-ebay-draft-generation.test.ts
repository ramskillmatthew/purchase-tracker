import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { runEbayListingGeneration } = vi.hoisted(() => ({ runEbayListingGeneration: vi.fn() }));
vi.mock("@/lib/listing-studio/ebay-listing-generation-ai", () => ({ runEbayListingGeneration }));

const { buildEbayDraftFromGeneratedFields } = await import("@/lib/listing-studio/ebay-draft-generation");

function fields(overrides: Record<string, unknown> = {}): import("@/lib/listing-studio/listing-generation-schemas").ListingGenerationFields {
  return {
    brand: { value: "On Running", confidence: "high" }, model: { value: "Cloud 5", confidence: "high" },
    productType: { value: "Trainers", confidence: "high" }, colours: { value: ["Blue", "Grey"], confidence: "high" },
    material: { value: "Mesh", confidence: "high" },
    sourceSize: { system: "UK", value: "4", gender: null, confidence: "high" },
    vintedAudience: { value: "womens", confidence: "high" },
    vintedAudienceEvidence: [], sku: { value: "1648", confidence: "high" }, notes: null,
    ...overrides,
  } as import("@/lib/listing-studio/listing-generation-schemas").ListingGenerationFields;
}
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    fields: fields(), ukSize: "4", vintedAudience: "womens" as const, itemFamily: "footwear" as const,
    hasPhoto: true, pricePence: 2000, quantity: 1, knownConditionEvidence: null, previousAttemptCount: 0,
    ...overrides,
  };
}
function aiSuccess(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    data: {
      styleCode: null, styleCodeConfidence: null, styleCodeEvidence: null,
      otherKeywords: [], conditionEvidence: null, categorySearchTerms: [], warnings: [],
      ...overrides,
    },
  };
}

beforeEach(() => { runEbayListingGeneration.mockReset(); });

describe("buildEbayDraftFromGeneratedFields — AI success path", () => {
  it("REQUIREMENT: never claims ready when category is unresolved — always needs_information at this stage", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ categorySearchTerms: ["On Running", "Cloud 5"] }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.status).toBe("needs_information");
    expect(result.readiness.ready).toBe(false);
  });

  it("condition resolves to the standard pre-owned label by default (no evidence given) — never left null when it doesn't need to be", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.conditionValue).toBe("Used – Very Good");
    expect(result.productFacts.conditionState).toBe("very_good_preowned");
    expect(result.validationMessages.map(m => m.code)).not.toContain("condition_not_set");
  });

  it("Problem 8 / live-diagnostic follow-up: returns the resolved style code (only when high confidence) as part of the FULL structured productFacts, for future persistence regardless of Vinted", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ styleCode: "M2002RST", styleCodeConfidence: "high" }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.productFacts.styleCode).toBe("M2002RST");
    expect(result.productFacts.brand).toBe("On Running");
    expect(result.productFacts.model).toBe("Cloud 5");
    expect(result.productFacts.gender).toBe("womens");
    expect(result.productFacts.ukShoeSize).toBe("4");
    expect(result.productFacts.internalSku).toBe("1648");
  });

  it("REQUIREMENT: a flagged defect in the AI's condition evidence leaves conditionValue null and needs_review, never a fabricated standard sentence", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ conditionEvidence: "There is a tear near the sole and a stain on the upper." }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.conditionValue).toBeNull();
    expect(result.validationMessages.some(m => m.code === "condition_needs_review")).toBe(true);
    expect(result.validationMessages.some(m => m.code === "condition_not_set")).toBe(false); // the specific message, not the generic one
  });

  it("PROVEN ROOT CAUSE FIX: 'On Running' (brand) and 'Running Trainers' (product type) are different, non-adjacent fields — both real occurrences of 'Running' are kept, never silently dropped", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput({ fields: fields({ brand: { value: "On Running", confidence: "high" }, productType: { value: "Running Trainers", confidence: "high" } }) }));
    expect(result.title).toBe("On Running Cloud 5 Womens UK 4 Blue Grey Mesh Running Trainers");
    expect(result.title.toLowerCase().match(/\brunning\b/g)?.length).toBe(2);
    expect(result.title).not.toMatch(/\brunning running\b/i); // never an ADJACENT literal doubling
    expect(result.title).not.toContain('"');
    expect(result.title).not.toMatch(/very good condition/i);
  });

  it("Problem 2/3 fix: title and description are composed DETERMINISTICALLY from facts — the AI response carries no title/description text at all", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.title).toBe("On Running Cloud 5 Womens UK 4 Blue Grey Mesh Trainers");
    expect(result.description.split("\n\n")[0]).toBe("On Running Cloud 5 Women's Trainers – UK 4");
  });

  it("the internal SKU (from the shared Vinted-proven evidence pipeline, fields.sku) appears as the LAST Details bullet in the eBay description", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput({ fields: fields({ sku: { value: "1644", confidence: "high" } }) }));
    const detailsBlock = result.description.split("\n\n").find(b => b.startsWith("Details"))!;
    const bullets = detailsBlock.split("\n").filter(l => l.startsWith("•"));
    expect(bullets[bullets.length - 1]).toBe("• SKU: 1644");
  });

  it("REQUIREMENT: a manufacturer style code is only ever included when the AI reports HIGH confidence — medium/low confidence never leaks into title or description", async () => {
    const withMedium = await (async () => {
      runEbayListingGeneration.mockResolvedValue(aiSuccess({ styleCode: "M2002RST", styleCodeConfidence: "medium" }));
      return buildEbayDraftFromGeneratedFields(baseInput());
    })();
    expect(withMedium.title).not.toContain("M2002RST");
    expect(withMedium.description).not.toContain("M2002RST");

    runEbayListingGeneration.mockResolvedValue(aiSuccess({ styleCode: "M2002RST", styleCodeConfidence: "high" }));
    const withHigh = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(withHigh.title).toContain("M2002RST");
    expect(withHigh.description).toContain("Style code: M2002RST");
  });

  it("REQUIREMENT: never confuses the manufacturer style code with the seller's own internal SKU — both can appear, in different places, never merged", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ styleCode: "M2002RST", styleCodeConfidence: "high" }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput({ fields: fields({ sku: { value: "1648", confidence: "high" } }) }));
    expect(result.title).not.toContain("1648"); // internal SKU never in the title
    expect(result.description).toContain("Style code: M2002RST");
    expect(result.description).toContain("SKU: 1648");
  });

  it("REGRESSION (adversarial, safety-critical): an adversarial 'new condition' evidence string smuggling Vinted boilerplate is stripped by the post-render repair pass, never shipped verbatim", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ conditionEvidence: "Brand new, unworn. Bundle discount available, please look at my other items!" }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.description.toLowerCase()).not.toContain("bundle discount");
    expect(result.description.toLowerCase()).not.toContain("look at my other items");
  });

  it("REGRESSION (adversarial): repairs an overlong title by dropping lower-priority components, never mid-word truncation", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ otherKeywords: ["Lightweight", "Breathable", "Limited Edition Colourway"] }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput({ fields: fields({ model: { value: "Cloud 5 Special Edition Collaboration Release", confidence: "high" } }) }));
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.title.startsWith("On Running")).toBe(true);
  });

  it("flags missing price and quantity as blocking, but not when they're supplied", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const missing = await buildEbayDraftFromGeneratedFields(baseInput({ pricePence: null, quantity: null }));
    expect(missing.validationMessages.map(m => m.code)).toEqual(expect.arrayContaining(["price_not_set", "quantity_not_set"]));
    const present = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(present.validationMessages.map(m => m.code)).not.toEqual(expect.arrayContaining(["price_not_set", "quantity_not_set"]));
  });

  it("surfaces the AI's own warnings as suggestion-severity validation messages", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ warnings: ["Could not confirm exact release year."] }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.validationMessages.some(m => m.code === "ai_warning" && m.message.includes("release year"))).toBe(true);
  });

  it("passes categorySearchTerms through for the category-suggestion pipeline to use", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ categorySearchTerms: ["On Running", "Cloud 5", "Trainers"] }));
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.categorySearchTermsHint).toEqual(["On Running", "Cloud 5", "Trainers"]);
  });

  it("Step 5 (parcel-size suggestion): every result carries a deterministic package suggestion derived from the product's own fields — footwear suggests a medium parcel", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.packageSuggestion.size).toBe("medium_parcel");
  });

  it("REQUIREMENT: gender is taken from the already-determined Vinted audience, never re-guessed independently — an 'unknown' audience omits gender cleanly", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput({ vintedAudience: "unknown" }));
    expect(result.title).not.toMatch(/\b(mens|womens)\b/i);
  });

  it("clothing item family: uses the raw source-size label as the clothing size, never a footwear UK-size conversion", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const result = await buildEbayDraftFromGeneratedFields(baseInput({
      itemFamily: "clothing",
      fields: fields({ productType: { value: "Hoodie", confidence: "high" }, sourceSize: { system: "UK", value: "Large", gender: null, confidence: "high" } }),
    }));
    expect(result.title).toContain("Size Large");
  });
});

describe("buildEbayDraftFromGeneratedFields — AI failure falls back safely", () => {
  it("REQUIREMENT: a failed eBay AI call never blocks the draft — falls back to a deterministic, honest description", async () => {
    runEbayListingGeneration.mockResolvedValue({ status: "request_failed" });
    const result = await buildEbayDraftFromGeneratedFields(baseInput());
    expect(result.title).toBeTruthy();
    expect(result.description).toBeTruthy();
    expect(result.description).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(result.validationMessages.some(m => m.code === "ebay_generation_degraded")).toBe(true);
    expect(result.conditionValue).toBeNull();
  });

  it("not_configured also falls back gracefully rather than throwing", async () => {
    runEbayListingGeneration.mockResolvedValue({ status: "not_configured" });
    await expect(buildEbayDraftFromGeneratedFields(baseInput())).resolves.toBeTruthy();
  });
});
