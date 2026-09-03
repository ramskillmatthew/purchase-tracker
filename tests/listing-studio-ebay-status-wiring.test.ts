import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Phase 6/7/13 — "The product card must display eBay status, not Vinted
// status" once eBay UK is selected; "Create marketplace-aware counters."
// Source-text assertions, matching this repo's established convention.
describe("components/listing-studio/ProductGroupCard.tsx — Phase 6/13: eBay-specific card status, never blended with Vinted's own", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("computes eBay status via the shared computeEbayCardStatus — never a second ad-hoc derivation", () => {
    expect(source).toContain('import { computeEbayCardStatus, EBAY_CARD_STATUS_LABELS, EBAY_CARD_STATUS_TONES, type EbaySummary } from "@/lib/listing-studio/ebay-card-status";');
    expect(source).toContain("const ebayStatus = isUnsorted ? null : computeEbayCardStatus(ebay, isGeneratingEbay);");
  });

  it("REGRESSION: Vinted's own computeStatus is completely untouched — this is purely additive, never a shared/blended derivation", () => {
    expect(source).toContain("const status = computeStatus(isUnsorted, listing, isGenerating, hasFailedGeneration, group.vinted_category_id);");
  });

  it("shows the Vinted badge only when the workspace's marketplace view includes Vinted, and the eBay badge only when it includes eBay UK", () => {
    expect(source).toContain('const showVintedStatus = marketplaceView === "VINTED" || marketplaceView === "BOTH";');
    expect(source).toContain('const showEbayStatus = marketplaceView === "EBAY_UK" || marketplaceView === "BOTH";');
    expect(source).toContain("{showVintedStatus && status &&");
    expect(source).toContain("{showEbayStatus && ebayStatus &&");
  });

  it("Both mode prefixes each badge so the two marketplaces are never ambiguous on the same card", () => {
    expect(source).toContain('marketplaceView === "BOTH" ? `Vinted: ${STATUS_LABELS[status]}` : STATUS_LABELS[status]');
    expect(source).toContain('marketplaceView === "BOTH" ? `eBay: ${EBAY_CARD_STATUS_LABELS[ebayStatus]}` : EBAY_CARD_STATUS_LABELS[ebayStatus]');
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — Phase 7: marketplace-specific summary counters", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("REGRESSION (the exact reported miscount): eBay counters are computed from draft.ebay.contentState, never draft.status (Vinted's own column)", () => {
    expect(source).toContain('const ebayGeneratedCount = orderedProductDrafts.filter(draft => draft.ebay?.contentState === "generated").length;');
    expect(source).toContain('const ebayFailedCount = orderedProductDrafts.filter(draft => draft.ebay?.contentState === "fallback" || draft.ebay?.contentState === "failed").length;');
  });

  it("REQUIREMENT: Vinted-selected keeps the exact original counter line — zero behaviour change for the pre-existing workflow", () => {
    expect(source).toContain('{generationTarget === "VINTED" && <>');
    expect(source).toContain("{images.length} photo{images.length === 1 ? \"\" : \"s\"} · {productGroupsCount} product{productGroupsCount === 1 ? \"\" : \"s\"} · {eligibleListingGroups.length} ready to generate · {readyCount} draft{readyCount === 1 ? \"\" : \"s\"} generated");
  });

  it("REQUIREMENT: eBay UK selected shows eBay-specific counts, including failures — never Vinted's readyCount", () => {
    expect(source).toContain('{generationTarget === "EBAY_UK" && <>');
    expect(source).toContain("{ebayEligibleProducts.length} eBay draft{ebayEligibleProducts.length === 1 ? \"\" : \"s\"} to generate · {ebayGeneratedCount} generated");
  });

  it("REQUIREMENT: Both mode shows both marketplaces' own counts side by side, never collapsed into one ambiguous number", () => {
    expect(source).toContain('{generationTarget === "BOTH" && <>');
    expect(source).toContain("Vinted: {readyCount} generated · eBay: {ebayGeneratedCount} generated");
  });

  it("REQUIREMENT (Phase 14): a fallback/failed eBay product remains eligible for 'Generate listings' — never stuck needing the row deleted first", () => {
    expect(source).toContain("const ebayEligibleProducts = orderedProductDrafts.filter(draft => draft.ebay?.contentState !== \"generated\");");
  });
});
