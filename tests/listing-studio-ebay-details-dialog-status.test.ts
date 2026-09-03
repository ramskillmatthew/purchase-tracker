import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Phase 12 fix — "The dialog currently says 'eBay readiness: 63%'. This
// percentage is misleading when content generation failed... A failed
// content state cannot appear healthy merely because several shared
// fields exist." Source-text assertions, matching this repo's established
// convention for every other *-ui.test.ts file.
describe("components/listing-studio/EbayCategoryAndAspectsDialog.tsx — Phase 12: generation status leads, never a bare misleading percentage", () => {
  const source = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");

  it("reads the SAME authoritative content-generation state every other eBay-aware surface uses", () => {
    expect(source).toContain('import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";');
    expect(source).toContain("const contentGeneration = readContentGenerationState(draft.dynamicData, {");
  });

  it("REGRESSION (the exact reported bug): never leads with a bare completion percentage — generation status is always the headline", () => {
    expect(source).not.toContain('<strong>eBay readiness: {draft.readiness.completionPercent}%</strong>');
    expect(source).toContain('eBay draft status: {degraded ? "Generation failed" : "Content generated"}');
  });

  it("REQUIREMENT: required and recommended completion are shown as two clearly separate, explicitly labelled lines — never blended into one misleading percentage", () => {
    expect(source).toContain("Required fields: {draft.readiness.requiredComplete}/{draft.readiness.requiredTotal} complete");
    expect(source).toContain("Recommended specifics: ${draft.readiness.recommendedComplete}/${draft.readiness.recommendedTotal} complete");
  });

  it("a degraded (fallback/failed) state shows its own safe message alongside the headline", () => {
    expect(source).toContain("{degraded && contentGeneration.message && <p className=\"ebay-details-empty\">{contentGeneration.message}</p>}");
  });

  it("colours the headline distinctly for failure vs success — never the same neutral text weight for both", () => {
    expect(source).toContain('className={degraded ? "ebay-details-status-failed" : "ebay-details-status-ok"}');
  });
});
