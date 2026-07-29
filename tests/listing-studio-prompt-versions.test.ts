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
    expect(LISTING_PROMPT_VERSIONS.generation).toBe("listing-generation-v1");
  });
});
