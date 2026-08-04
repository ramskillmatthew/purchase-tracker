import { describe, expect, it } from "vitest";
import {
  getMissingRequiredFields, buildListingWarnings, matchesQuickFilter, isListingEdited,
  computeListingReviewStatus, matchesListingSearch, REVIEW_REQUIRED_FIELDS,
  type ReviewableListing,
} from "@/lib/listing-studio/listing-review";
import type { ListingGenerationFields, VintedColour, VintedMaterial } from "@/lib/listing-studio/listing-generation-schemas";

function aiFields(overrides: Partial<Record<"brand" | "model" | "productType" | "sku", string | null> & { colours: VintedColour[]; material: VintedMaterial | null }> = {}): ListingGenerationFields {
  return {
    brand: { value: overrides.brand ?? "Nike", confidence: "high" },
    model: { value: overrides.model ?? "Pegasus", confidence: "high" },
    productType: { value: overrides.productType ?? "Trainers", confidence: "medium" },
    colours: { value: overrides.colours ?? ["Black", "White"], confidence: "medium" },
    material: { value: overrides.material ?? "Mesh", confidence: "medium" },
    sourceSize: { system: "UK", value: "9", gender: null, confidence: "high" },
    // Follow-up correction (2026-08-04, extended 2026-08-05).
    vintedAudience: { value: "womens", confidence: "high" },
    vintedAudienceEvidence: ["Model identified as the women's version"],
    sku: { value: overrides.sku ?? "1648", confidence: "high" },
    notes: null,
  };
}

function completeListing(overrides: Partial<ReviewableListing> = {}): ReviewableListing {
  return {
    brand: "Nike", model: "Pegasus", productType: "Trainers", colours: ["Black", "White"], material: "Mesh",
    ukSize: "9", sku: "1648", ukSizeSource: "observed",
    aiResultJson: aiFields(), reviewMarkedReadyAt: null, updatedAt: "2026-01-01T00:00:00.000Z",
    // Milestone 7 (Vinted category catalogue sync) — a valid category by
    // default so pre-existing tests' "nothing missing" baseline still holds.
    vintedCategoryId: 1906, vintedCategoryValid: true, vintedCategorySource: "ai",
    // Follow-up correction (2026-08-04).
    vintedCategoryStatus: "category_assigned", vintedAudienceSource: "ai",
    ...overrides,
  };
}

describe("getMissingRequiredFields — brand/model/colours/ukSize/sku, never productType or material", () => {
  it("reports nothing missing when every required field is set", () => {
    expect(getMissingRequiredFields(completeListing())).toEqual([]);
  });

  it("reports each of the 5 required fields when blank (null, whitespace-only, or an empty colours array)", () => {
    expect(getMissingRequiredFields(completeListing({ brand: null }))).toEqual(["brand"]);
    expect(getMissingRequiredFields(completeListing({ model: "   " }))).toEqual(["model"]);
    expect(getMissingRequiredFields(completeListing({ colours: [] }))).toEqual(["colours"]);
    expect(getMissingRequiredFields(completeListing({ ukSize: null }))).toEqual(["ukSize"]);
    expect(getMissingRequiredFields(completeListing({ sku: "" }))).toEqual(["sku"]);
  });

  it("empty colour array: reported as missing exactly like any other blank required field", () => {
    expect(getMissingRequiredFields(completeListing({ colours: [] }))).toContain("colours");
  });

  it("a single colour (not two) is NOT missing — one is enough to satisfy the requirement", () => {
    expect(getMissingRequiredFields(completeListing({ colours: ["Black"] }))).toEqual([]);
  });

  it("REGRESSION: a missing productType or material is never reported — neither is a required field for review purposes", () => {
    expect(getMissingRequiredFields(completeListing({ productType: null }))).toEqual([]);
    expect(getMissingRequiredFields(completeListing({ material: null }))).toEqual([]);
  });

  it("reports every missing field at once, in REVIEW_REQUIRED_FIELDS order", () => {
    expect(getMissingRequiredFields(completeListing({ brand: null, sku: null }))).toEqual(
      REVIEW_REQUIRED_FIELDS.filter(f => f === "brand" || f === "sku"),
    );
  });
});

describe("buildListingWarnings — human-readable, in the spec's own example order (SKU, Size, Brand, Colour, Model)", () => {
  it("empty when nothing is missing", () => {
    expect(buildListingWarnings(completeListing())).toEqual([]);
  });

  it("orders multiple warnings as SKU, Size, Brand, Colour, Model regardless of which fields are actually missing", () => {
    const listing = completeListing({ model: null, brand: null, sku: null, ukSize: null, colours: [] });
    expect(buildListingWarnings(listing)).toEqual(["Missing SKU", "Missing Size", "Missing Brand", "Missing Colour", "Missing Model"]);
  });

  it("one warning per missing field, exact wording", () => {
    expect(buildListingWarnings(completeListing({ sku: null }))).toEqual(["Missing SKU"]);
    expect(buildListingWarnings(completeListing({ ukSize: null }))).toEqual(["Missing Size"]);
    expect(buildListingWarnings(completeListing({ brand: null }))).toEqual(["Missing Brand"]);
    expect(buildListingWarnings(completeListing({ colours: [] }))).toEqual(["Missing Colour"]);
    expect(buildListingWarnings(completeListing({ model: null }))).toEqual(["Missing Model"]);
  });

  it("REGRESSION: warnings disappear automatically once the field is filled in — recomputed fresh from current values every time, no stale state", () => {
    const missing = completeListing({ sku: null });
    const fixed: ReviewableListing = { ...missing, sku: "1648" };
    expect(buildListingWarnings(missing)).toEqual(["Missing SKU"]);
    expect(buildListingWarnings(fixed)).toEqual([]);
  });

  it("Edit Fields behaviour: filling in an empty colours array with even one colour clears the Missing Colour warning", () => {
    const missingColour = completeListing({ colours: [] });
    const editedInStudio: ReviewableListing = { ...missingColour, colours: ["Grey"] };
    expect(buildListingWarnings(missingColour)).toContain("Missing Colour");
    expect(buildListingWarnings(editedInStudio)).not.toContain("Missing Colour");
  });

  it("Milestone 7: 'Missing category' is appended last when the category is null or invalid", () => {
    expect(buildListingWarnings(completeListing({ vintedCategoryId: null, vintedCategoryValid: false, vintedCategoryStatus: "no_candidates" }))).toEqual(["Missing category"]);
    expect(buildListingWarnings(completeListing({ vintedCategoryId: 1906, vintedCategoryValid: false, vintedCategoryStatus: "no_candidates" }))).toEqual(["Missing category"]);
    expect(buildListingWarnings(completeListing({ sku: null, vintedCategoryId: null, vintedCategoryValid: false, vintedCategoryStatus: "no_candidates" }))).toEqual(["Missing SKU", "Missing category"]);
  });

  it("Follow-up correction (2026-08-04): shows the specific, actionable 'Audience required' instead of the generic 'Missing category' whenever that's genuinely why", () => {
    expect(buildListingWarnings(completeListing({ vintedCategoryId: null, vintedCategoryValid: false, vintedCategoryStatus: "audience_missing" }))).toEqual(["Audience required"]);
  });

  it("every other category-assignment reason still falls back to the generic 'Missing category' — never a raw internal code shown to the user", () => {
    for (const status of ["item_family_uncertain", "no_candidates", "too_many_candidates", "ai_selection_failed", "ai_selection_invalid", null]) {
      expect(buildListingWarnings(completeListing({ vintedCategoryId: null, vintedCategoryValid: false, vintedCategoryStatus: status }))).toEqual(["Missing category"]);
    }
  });
});

describe("matchesQuickFilter — Missing SKU / Missing Size / Missing Brand / Missing Colour only (no Missing Model quick filter)", () => {
  it("matches exactly the listings missing that one field", () => {
    expect(matchesQuickFilter(completeListing({ sku: null }), "missing_sku")).toBe(true);
    expect(matchesQuickFilter(completeListing(), "missing_sku")).toBe(false);
    expect(matchesQuickFilter(completeListing({ ukSize: null }), "missing_size")).toBe(true);
    expect(matchesQuickFilter(completeListing({ brand: null }), "missing_brand")).toBe(true);
    expect(matchesQuickFilter(completeListing({ colours: [] }), "missing_colour")).toBe(true);
    expect(matchesQuickFilter(completeListing({ colours: ["Black"] }), "missing_colour")).toBe(false);
  });

  it("Milestone 7: missing_category matches a null or invalid category", () => {
    expect(matchesQuickFilter(completeListing({ vintedCategoryId: null, vintedCategoryValid: false }), "missing_category")).toBe(true);
    expect(matchesQuickFilter(completeListing({ vintedCategoryId: 1906, vintedCategoryValid: false }), "missing_category")).toBe(true);
    expect(matchesQuickFilter(completeListing(), "missing_category")).toBe(false);
  });
});

describe("isListingEdited — differs from the frozen ai_result_json snapshot, or uk_size_source is 'manual'", () => {
  it("false for a freshly generated, unedited listing", () => {
    expect(isListingEdited(completeListing())).toBe(false);
  });

  it("true when any structured field (brand/model/productType/colours/material/sku) differs from the AI's original value", () => {
    expect(isListingEdited(completeListing({ brand: "Adidas" }))).toBe(true);
    expect(isListingEdited(completeListing({ model: "Samba" }))).toBe(true);
    expect(isListingEdited(completeListing({ productType: "Sandals" }))).toBe(true);
    expect(isListingEdited(completeListing({ colours: ["Red"] }))).toBe(true);
    expect(isListingEdited(completeListing({ material: "Leather" }))).toBe(true);
    expect(isListingEdited(completeListing({ sku: "9999" }))).toBe(true);
  });

  it("REGRESSION: colours comparison is order-insensitive — re-selecting the same two colours in a different dropdown order is not an edit", () => {
    expect(isListingEdited(completeListing({ colours: ["White", "Black"] }))).toBe(false);
  });

  it("a genuinely different colour SET (not just reordered) is detected as edited, even with the same count", () => {
    expect(isListingEdited(completeListing({ colours: ["Black", "Grey"] }))).toBe(true);
  });

  it("clearing colours down to an empty array from a previously-set pair is detected as edited", () => {
    expect(isListingEdited(completeListing({ colours: [] }))).toBe(true);
  });

  it("true whenever uk_size_source is 'manual', regardless of the actual UK size value — the AI never returns a raw ukSize to compare against", () => {
    expect(isListingEdited(completeListing({ ukSizeSource: "manual" }))).toBe(true);
    expect(isListingEdited(completeListing({ ukSizeSource: "manual", ukSize: "9" }))).toBe(true);
  });

  it("false for the other provenance values (observed/brand_converted/fallback_converted) when nothing else was edited", () => {
    expect(isListingEdited(completeListing({ ukSizeSource: "observed" }))).toBe(false);
    expect(isListingEdited(completeListing({ ukSizeSource: "brand_converted" }))).toBe(false);
    expect(isListingEdited(completeListing({ ukSizeSource: "fallback_converted" }))).toBe(false);
  });

  it("REGRESSION: never throws and reports false when ai_result_json is null (should never happen for a generated draft, but must degrade safely)", () => {
    expect(isListingEdited(completeListing({ aiResultJson: null }))).toBe(false);
  });

  it("Milestone 7: true whenever vintedCategorySource is 'manual' — no AI snapshot exists to diff a category against", () => {
    expect(isListingEdited(completeListing({ vintedCategorySource: "manual" }))).toBe(true);
  });

  it("Milestone 7: false when vintedCategorySource is 'ai' and nothing else changed", () => {
    expect(isListingEdited(completeListing({ vintedCategorySource: "ai" }))).toBe(false);
  });

  it("Follow-up correction (2026-08-04): true whenever vintedAudienceSource is 'manual' — a manually-corrected audience is itself a user edit", () => {
    expect(isListingEdited(completeListing({ vintedAudienceSource: "manual" }))).toBe(true);
  });

  it("Follow-up correction: false when vintedAudienceSource is 'ai' and nothing else changed", () => {
    expect(isListingEdited(completeListing({ vintedAudienceSource: "ai" }))).toBe(false);
  });
});

describe("computeListingReviewStatus — Needs Review always wins; Mark Ready only ever resolves Edited, never a genuinely incomplete listing", () => {
  it("Ready: nothing missing, nothing edited", () => {
    expect(computeListingReviewStatus(completeListing())).toBe("ready");
  });

  it("Needs Review: any required field missing, regardless of edit history", () => {
    expect(computeListingReviewStatus(completeListing({ sku: null }))).toBe("needs_review");
    expect(computeListingReviewStatus(completeListing({ sku: null, ukSizeSource: "manual" }))).toBe("needs_review");
  });

  it("Needs Review: an empty colours array is treated exactly like any other missing required field", () => {
    expect(computeListingReviewStatus(completeListing({ colours: [] }))).toBe("needs_review");
  });

  it("Edited: nothing missing, but a field was manually changed since generation", () => {
    expect(computeListingReviewStatus(completeListing({ brand: "Adidas" }))).toBe("edited");
  });

  it("REGRESSION: missing fields ALWAYS win over Mark Ready — 'automatic' per the spec, no override exists for this rule", () => {
    const listing = completeListing({ sku: null, reviewMarkedReadyAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(computeListingReviewStatus(listing)).toBe("needs_review");
  });

  it("Mark Ready resolves an Edited listing back to Ready when marked ready AFTER the last edit", () => {
    const listing = completeListing({ brand: "Adidas", updatedAt: "2026-01-01T00:00:00.000Z", reviewMarkedReadyAt: "2026-01-02T00:00:00.000Z" });
    expect(computeListingReviewStatus(listing)).toBe("ready");
  });

  it("REGRESSION: editing AGAIN after being marked ready reverts to Edited with no extra bookkeeping (updatedAt moves back past reviewMarkedReadyAt)", () => {
    const listing = completeListing({ brand: "Adidas", reviewMarkedReadyAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(computeListingReviewStatus(listing)).toBe("edited");
  });

  it("a listing marked ready before ever being edited stays Ready (markedReadyAt at/after updatedAt is the not-edited-since condition)", () => {
    const listing = completeListing({ reviewMarkedReadyAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(computeListingReviewStatus(listing)).toBe("ready");
  });

  it("Milestone 7: Needs Review whenever the category is null or invalid, even with nothing else missing/edited", () => {
    expect(computeListingReviewStatus(completeListing({ vintedCategoryId: null, vintedCategoryValid: false }))).toBe("needs_review");
    expect(computeListingReviewStatus(completeListing({ vintedCategoryId: 1906, vintedCategoryValid: false }))).toBe("needs_review");
  });

  it("Milestone 7: category rule wins over Mark Ready too, exactly like a missing required field", () => {
    const listing = completeListing({
      vintedCategoryId: null, vintedCategoryValid: false,
      reviewMarkedReadyAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(computeListingReviewStatus(listing)).toBe("needs_review");
  });
});

describe("matchesListingSearch — instant substring search across title/SKU/brand/model/colours", () => {
  const listing = { generatedTitle: "Nike Pegasus Trainers - \"Black & White\" - Very Good Condition - Size UK 9", sku: "1648", brand: "Nike", model: "Pegasus", colours: ["Black", "White"] };

  it("an empty query matches everything", () => {
    expect(matchesListingSearch(listing, "")).toBe(true);
    expect(matchesListingSearch(listing, "   ")).toBe(true);
  });

  it("matches by title, SKU, brand, model, or a colour in the colours array, case-insensitively", () => {
    expect(matchesListingSearch(listing, "pegasus")).toBe(true);
    expect(matchesListingSearch(listing, "1648")).toBe(true);
    expect(matchesListingSearch(listing, "NIKE")).toBe(true);
    expect(matchesListingSearch(listing, "black")).toBe(true);
    expect(matchesListingSearch(listing, "white")).toBe(true);
    expect(matchesListingSearch(listing, "PEGASUS")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesListingSearch(listing, "adidas")).toBe(false);
  });

  it("never throws when a field is null or colours is empty", () => {
    expect(matchesListingSearch({ ...listing, sku: null, colours: [] }, "nike")).toBe(true);
  });
});
