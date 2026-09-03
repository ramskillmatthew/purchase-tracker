import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// PROVEN ROOT CAUSE FIX — the exact reported "Needs review with no visible
// reason" bug. Source-text assertions, matching this repo's established
// convention for every other *-ui.test.ts file (this .tsx file cannot be
// rendered directly — see EbayCategoryAndAspectsDialog.tsx's own price
// helpers, which had to be extracted to a plain .ts module for the same
// reason). Behavioural coverage of the underlying logic lives in
// listing-studio-ebay-category-review.test.ts and
// listing-studio-ebay-review-state-integration.test.ts.
describe("components/listing-studio/EbayCategoryAndAspectsDialog.tsx — Review summary section", () => {
  const source = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");

  it("REQUIREMENT: renders the review summary from the SAME resolveCategoryReviewState the row badge reads from — never a second, bespoke review derivation", () => {
    expect(source).toContain('import { resolveCategoryReviewState, readCategoryConfirmation, CATEGORY_CONFIRMATION_KEY } from "@/lib/listing-studio/ebay-category-review";');
    expect(source).toContain("const categoryReview = resolveCategoryReviewState({");
  });

  it('REQUIREMENT: shows "No fields require review." when there are zero genuine reasons', () => {
    expect(source).toContain('<p className="ebay-details-review-clear">No fields require review.</p>');
  });

  it('REQUIREMENT: shows a "N field(s) need(s) review" count and a listed reason for each, when review is required', () => {
    expect(source).toContain('{reasonCount} field{reasonCount === 1 ? "" : "s"} need{reasonCount === 1 ? "s" : ""} review');
    expect(source).toContain('<ul className="ebay-details-review-list">');
    expect(source).toContain("{name}: needs review.");
  });

  it("ACCESSIBILITY REQUIREMENT: every aspect review reason carries a direct 'Review field' action (no review reason is a dead end)", () => {
    expect(source).toContain('<button type="button" className="ebay-details-review-action" onClick={() => reviewField(name)}>Review field</button>');
    // the count and the listed aspect reasons come from the SAME partition
    // the form's "Needs review" group renders from
    expect(source).toContain("const aspectReviewNames = reviewPartition.needsReview.map(a => a.name);");
  });

  it("ACCESSIBILITY REQUIREMENT: 'Review field' scrolls the flagged field into view and focuses its control", () => {
    expect(source).toContain('element.scrollIntoView({ block: "center", behavior: "smooth" });');
    expect(source).toContain('(element.querySelector("select, input, textarea, button") as HTMLElement | null)?.focus();');
  });

  it("ACCESSIBILITY REQUIREMENT: unresolved-review aspects render in an always-visible 'Needs review' group, never only behind the collapsed optional section", () => {
    expect(source).toContain('import { partitionAspectsForReview } from "@/lib/listing-studio/ebay-aspect-review-grouping";');
    expect(source).toContain('<AspectGroup title="Needs review" className="ebay-aspect-group-needs-review" aspects={reviewPartition.needsReview}');
    // the normal groups render the REMAINDER (review-flagged aspects pulled out), so nothing is shown twice
    expect(source).toContain("aspects={reviewPartition.required}");
    expect(source).toContain("aspects={reviewPartition.recommended}");
    expect(source).toContain("aspects={reviewPartition.optional}");
    expect(source).toContain("`Show optional fields (${reviewPartition.optional.length})`");
  });

  it('REQUIREMENT: shows "Ready to create an eBay draft" when every requirement is satisfied and no review reason remains', () => {
    expect(source).toContain("Ready to create an eBay draft.");
  });

  it("REQUIREMENT: offers a genuine 'Confirm category' action for an ordinary AI-confidence review, distinct from a footwear-rule mismatch (which offers only 'Change category', since confirming would not resolve a genuine mismatch)", () => {
    expect(source).toContain('categoryReview.needsReview && categoryReview.provenance === "ai_suggestion"');
    expect(source).toContain('<button type="button" className="button-secondary" onClick={confirmCategory}>Confirm category</button>');
    expect(source).toContain('categoryReview.provenance === "footwear_size_rule_mismatch"');
  });

  it("REQUIREMENT: confirmCategory persists via the SAME reserved-pseudo-aspect + PATCH /ebay-aspects route every other confirmation in this app uses (merge-safe, triggers onDraftUpdated through saveAspect)", () => {
    const fn = source.slice(source.indexOf("async function confirmCategory"), source.indexOf("async function confirmCategory") + 300);
    expect(fn).toContain("await saveAspect(CATEGORY_CONFIRMATION_KEY, draft.categoryId);");
  });

  it("REQUIREMENT: the category badge shows the EFFECTIVE confidence/review state (from resolveCategoryReviewState), not the raw stored confidence with no review signal", () => {
    expect(source).toContain("<ConfidenceBadge confidence={categoryReview.effectiveConfidence} needsReview={categoryReview.needsReview} />");
  });

  it("REQUIREMENT: Required and Recommended completion are shown as two separate lines, and recommended completion is explicitly labelled as never blocking readiness", () => {
    expect(source).toContain("Required fields: {draft.readiness.requiredComplete}/{draft.readiness.requiredTotal} complete");
    expect(source).toContain("(Recommended completion is an optimisation score — it never blocks readiness.)");
  });
});
