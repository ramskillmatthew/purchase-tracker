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

  it("Milestone 4 sizing coverage correction: sourceSize.gender gained a 4th value (\"childrens\") — bumped to schema-v4, after the v3 rebuild that replaced ukSize with sourceSize", () => {
    expect(LISTING_SCHEMA_VERSIONS.generation).toBe("listing-generation-schema-v4");
  });
});
