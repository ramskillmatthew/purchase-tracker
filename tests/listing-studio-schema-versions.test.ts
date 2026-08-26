import { describe, expect, it } from "vitest";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { listingAnalysisStages } from "@/lib/listing-studio/types";

describe("LISTING_SCHEMA_VERSIONS — versioned independently of LISTING_PROMPT_VERSIONS", () => {
  it("has exactly one version string per pipeline stage", () => {
    expect(Object.keys(LISTING_SCHEMA_VERSIONS).sort()).toEqual([...listingAnalysisStages].sort());
  });

  it("every version string ends in a version suffix (-vN)", () => {
    for (const version of Object.values(LISTING_SCHEMA_VERSIONS)) expect(version).toMatch(/-v\d+$/);
  });

  it("every version string is unique", () => {
    const values = Object.values(LISTING_SCHEMA_VERSIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("is a genuinely separate constant from LISTING_PROMPT_VERSIONS — same stage keys, distinct string values per stage", () => {
    for (const stage of listingAnalysisStages) {
      expect(LISTING_SCHEMA_VERSIONS[stage]).not.toBe(LISTING_PROMPT_VERSIONS[stage]);
    }
  });

  it("Milestone 3: automatic AI product grouping has its own recorded schema version", () => {
    expect(LISTING_SCHEMA_VERSIONS.product_grouping).toBe("listing-product-grouping-schema-v2");
  });

  it("Milestone 6 (Vinted-aware colours/materials): colour (free text) was replaced by colours (Vinted enum array, max 2) and a new material field was added — bumped to schema-v5, after the v4 childrens-gender addition", () => {
    // Superseded by schema-v6 below — kept as a version-history marker.
    expect(LISTING_SCHEMA_VERSIONS.generation).not.toBe("listing-generation-schema-v5");
  });

  it("Follow-up correction (2026-08-04): a new vintedAudience field was added to the tool's response shape — bumped to schema-v6", () => {
    // Superseded by schema-v7 below — kept as a version-history marker.
    expect(LISTING_SCHEMA_VERSIONS.generation).not.toBe("listing-generation-schema-v5");
  });

  it("Follow-up correction (2026-08-05): a new vintedAudienceEvidence field was added to the tool's response shape — bumped to schema-v7", () => {
    expect(LISTING_SCHEMA_VERSIONS.generation).toBe("listing-generation-schema-v7");
  });

  it("Follow-up correction (2026-08-05): the new audience_reassessment stage has its own recorded schema version", () => {
    expect(LISTING_SCHEMA_VERSIONS.audience_reassessment).toBe("listing-audience-reassessment-schema-v1");
  });
});
