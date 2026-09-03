import type { Marketplace } from "@/lib/listing-studio/marketplace-types";

/**
 * Bug fix (proven root cause of "Despite eBay UK being selected, Preview
 * still showed Vinted content"): GroupingWorkspace.tsx's own
 * `eligibleListingGroups` used to check ONLY `!draft.generated_title` — a
 * single Vinted-only signal, completely blind to which marketplace was
 * actually selected. A product that already had a Vinted draft (as "On
 * Running Cloud 5" did, from an earlier run) was excluded from every
 * future "Generate listings" click, no matter what marketplace was
 * selected — so the POST to /generate was never even sent, and no EBAY_UK
 * row could ever be created.
 *
 * Extracted to a pure function (rather than left inline in the component)
 * specifically so it can be tested with real data and real assertions —
 * see tests/listing-studio-generation-eligibility.test.ts — instead of
 * only via source-text string matching.
 */
export type EligibilityDraft = {
  id: string;
  title: string | null;
  generatedTitle: string | null;
  ebayGenerated: boolean;
  hasPhoto: boolean;
};

export function isEligibleForGeneration(draft: EligibilityDraft, targetedMarketplaces: readonly Marketplace[]): boolean {
  if (draft.title === "Unsorted") return false;
  if (!draft.hasPhoto) return false;
  const needsVinted = targetedMarketplaces.includes("VINTED") && !draft.generatedTitle;
  const needsEbay = targetedMarketplaces.includes("EBAY_UK") && !draft.ebayGenerated;
  return needsVinted || needsEbay;
}
