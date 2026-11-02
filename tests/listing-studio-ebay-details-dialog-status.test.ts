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

describe("eBay details editor — in-place AI fill, condition choices and purchase price context", () => {
  const source = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");
  const css = read("app/globals.css");

  it("keeps the editor mounted while category and item specifics are filled", () => {
    expect(source).toContain("const load = useCallback(async (preserveEditor = false) =>");
    expect(source).toContain("if (!preserveEditor) setLoading(true);");
    expect(source).toMatch(/async function suggestCategory\(\)[\s\S]*?await load\(true\);/);
    expect(source).toMatch(/async function suggestAspects\(\)[\s\S]*?await load\(true\);/);
    expect(source).toContain('hasFilledSpecificsWithAi ? "Refill with AI" : "Fill with AI"');
    expect(source).not.toContain(">Run again<");
  });

  it("uses rounded, directly clickable eBay condition choices rather than a native rectangular dropdown", () => {
    const conditionSection = source.slice(source.indexOf("function ConditionSection"), source.indexOf("function PackageSizeSection"));
    expect(conditionSection).toContain('className="ebay-condition-options"');
    expect(conditionSection).toContain('role="radio"');
    expect(conditionSection).not.toContain("<select");
    expect(css).toContain(".ebay-condition-option");
    expect(css).toContain("border-radius:999px");
  });

  it("shows the exact purchase matching result beside the eBay price input in the bright red treatment", () => {
    expect(source).toContain('fetch(`/api/listing-studio/groups/${draftId}/selling-price`)');
    expect(source).toContain('<p className="ebay-price-paid">{purchasePriceText}</p>');
    expect(css).toMatch(/\.ebay-price-paid\s*\{[^}]*color:#ff4d68/);
  });

  it("shows live profit or loss from the staged selling price without saving the field immediately", () => {
    expect(source).toContain("const profitPence = parsedPrice !== null && purchasePricePence !== null ? parsedPrice - purchasePricePence : null;");
    expect(source).toContain('{profitPence >= 0 ? "Profit" : "Loss"}: {formatPenceAsGBP(Math.abs(profitPence))}');
    expect(source).toContain("function stagePrice(value: string)");
    expect(source.slice(source.indexOf("function stagePrice(value: string)"), source.indexOf("const saveCondition"))).not.toContain("fetch(");
  });

  it("prompts before discarding dirty eBay changes and offers the two requested exit choices", () => {
    expect(source).toContain("if (hasUnsavedChanges) setConfirmingClose(true);");
    expect(source).toContain("<UnsavedChangesDialog");
    const prompt = read("components/listing-studio/UnsavedChangesDialog.tsx");
    expect(prompt).toContain("Save changes and exit");
    expect(prompt).toContain("Exit without saving");
  });
});
