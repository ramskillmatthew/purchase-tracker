import { describe, expect, it } from "vitest";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { listingAnalysisStages } from "@/lib/listing-studio/types";

describe("LISTING_PROMPT_VERSIONS — Stage 1 spec §18", () => {
  it("has exactly one version string per pipeline stage", () => {
    expect(Object.keys(LISTING_PROMPT_VERSIONS).sort()).toEqual([...listingAnalysisStages].sort());
  });

  it("every version string ends in a version suffix (-vN) so a bump is always visible in the string itself", () => {
    for (const version of Object.values(LISTING_PROMPT_VERSIONS)) expect(version).toMatch(/-v\d+$/);
  });

  it("every version string is unique", () => {
    const values = Object.values(LISTING_PROMPT_VERSIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("matches the exact suggested names from the spec", () => {
    expect(LISTING_PROMPT_VERSIONS.image_quality).toBe("listing-image-quality-v1");
    expect(LISTING_PROMPT_VERSIONS.label_extraction).toBe("listing-label-extraction-v1");
    expect(LISTING_PROMPT_VERSIONS.visual_identification).toBe("listing-visual-identification-v1");
    expect(LISTING_PROMPT_VERSIONS.consistency_check).toBe("listing-consistency-check-v1");
  });

  it("Milestone 3: automatic AI product grouping has its own recorded prompt version", () => {
    expect(LISTING_PROMPT_VERSIONS.product_grouping).toBe("listing-product-grouping-v3"); // v3: replaces free-clustering with ordered boundary detection
  });

  it("Milestone 6 (Vinted-aware colours/materials): COLOUR was rewritten to COLOURS (Vinted enum, max 2) and a new MATERIAL instruction was added — bumped to v5, after the v4 childrens-category addition", () => {
    // Superseded by v6 below — kept as a version-history marker; the
    // constant itself always reflects the CURRENT version.
    expect(LISTING_PROMPT_VERSIONS.generation).not.toBe("listing-generation-v5");
  });

  it("Follow-up correction (2026-08-04): a new independent VINTED AUDIENCE instruction was added, and SIZE was reworded to stop sourceSize.gender being mistaken for audience — bumped to v6", () => {
    // Superseded by v7 below — kept as a version-history marker.
    expect(LISTING_PROMPT_VERSIONS.generation).not.toBe("listing-generation-v5");
  });

  it("Follow-up correction (2026-08-05): VINTED AUDIENCE was rewritten with a priority-ordered evidence rule and a new vintedAudienceEvidence field — bumped to v7", () => {
    expect(LISTING_PROMPT_VERSIONS.generation).toBe("listing-generation-v7");
  });

  it("Follow-up correction (2026-08-05): the new audience_reassessment stage (used by 'Assign category' and the explicit 'Reassess audience' action) has its own recorded prompt version", () => {
    expect(LISTING_PROMPT_VERSIONS.audience_reassessment).toBe("listing-audience-reassessment-v1");
  });
});
