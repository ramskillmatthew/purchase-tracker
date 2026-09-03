import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePriceToPence, formatPenceForInput } from "@/lib/listing-studio/ebay-price-input";
import { buildEbaySummary, computeEbayCardStatus } from "@/lib/listing-studio/ebay-card-status";
import type { MarketplaceReadiness } from "@/lib/listing-studio/marketplace-types";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const READY_ASIDE_FROM_PRICE: MarketplaceReadiness = {
  ready: true, completionPercent: 100, requiredComplete: 9, requiredTotal: 9, recommendedComplete: 0, recommendedTotal: 0,
};

/** A realistic persisted `listing_marketplace_drafts` row, exactly the
 * shape `buildEbaySummary` (the SAME function the workspace route uses to
 * build the product card's data) actually reads — the "On Running Cloud 5"
 * reproduction from the screenshots: content generated, category and
 * condition already set, only price varies between tests. */
function ebayDraftRow(overrides: Partial<Parameters<typeof buildEbaySummary>[0]> = {}): Parameters<typeof buildEbaySummary>[0] {
  return {
    title: "On Running Cloud 5 Womens UK 4 Blue Grey Mesh Running Trainers", description: "Genuine On Running Cloud 5 trainers.",
    source_type: "generated", content_mode: "seo_optimised", dynamic_data_json: {},
    category_id: "95672", category_name: "Trainers", category_path: "Women's Shoes > Women > Trainers", category_confidence: "high", category_source: "ai",
    condition_value: "Used", price_pence: null, quantity: 1,
    readiness_json: READY_ASIDE_FROM_PRICE,
    ...overrides,
  };
}

describe("PROVEN ROOT CAUSE — the product-row badge read a stale EbaySummary the dialog's save never refreshed", () => {
  describe("the real state path: DB row -> buildEbaySummary -> computeEbayCardStatus (the exact functions the app itself uses)", () => {
    it("REGRESSION reproducing the screenshots: a persisted row with no price is needs_price, and the SAME row re-read after price_pence becomes 3000 (£30.00) is no longer needs_price", () => {
      const beforeSave = buildEbaySummary(ebayDraftRow({ price_pence: null }));
      expect(computeEbayCardStatus(beforeSave, false)).toBe("needs_price");

      // Simulates exactly what the PATCH .../marketplace-drafts/EBAY_UK
      // route persists for a "30.00" input (parsePriceToPence("30.00") ===
      // 3000, proven below) — re-reading the SAME row-shaped data through
      // the SAME buildEbaySummary the workspace route uses, never a
      // reimplemented/second mapping.
      const afterSave = buildEbaySummary(ebayDraftRow({ price_pence: 3000 }));
      const status = computeEbayCardStatus(afterSave, false);
      expect(status).not.toBe("needs_price");
      expect(status).toBe("draft_complete"); // every other requirement was already satisfied
    });

    it("REQUIREMENT: an update from £30 to £35 is reflected the same way — persistence, summary, and status all move together", () => {
      const at30 = computeEbayCardStatus(buildEbaySummary(ebayDraftRow({ price_pence: 3000 })), false);
      const at35 = buildEbaySummary(ebayDraftRow({ price_pence: 3500 }));
      expect(at30).toBe("draft_complete");
      expect(at35.pricePence).toBe(3500);
      expect(computeEbayCardStatus(at35, false)).toBe("draft_complete");
    });

    it("REQUIREMENT: removing a previously saved price restores needs_price", () => {
      const withPrice = computeEbayCardStatus(buildEbaySummary(ebayDraftRow({ price_pence: 3000 })), false);
      const withoutPrice = computeEbayCardStatus(buildEbaySummary(ebayDraftRow({ price_pence: null })), false);
      expect(withPrice).toBe("draft_complete");
      expect(withoutPrice).toBe("needs_price");
    });

    it("REQUIREMENT: other genuine requirements still take priority over price — a missing category is needs_category even with a price already saved", () => {
      const status = computeEbayCardStatus(buildEbaySummary(ebayDraftRow({ price_pence: 3000, category_id: null })), false);
      expect(status).toBe("needs_category");
    });

    it("REQUIREMENT: a price of exactly 0 pence is treated as missing, never as a genuinely-priced £0.00 item", () => {
      expect(computeEbayCardStatus(buildEbaySummary(ebayDraftRow({ price_pence: 0 })), false)).toBe("needs_price");
    });
  });

  describe("the wiring that closes the gap: the dialog notifies the parent workspace, which re-fetches the authoritative summary", () => {
    const dialogSource = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");
    const workspaceSource = read("components/listing-studio/GroupingWorkspace.tsx");

    it("the dialog accepts an onDraftUpdated callback and calls it after a successful price save", () => {
      expect(dialogSource).toContain("onDraftUpdated?: () => void");
      const savePriceBody = dialogSource.slice(dialogSource.indexOf("async function savePrice"), dialogSource.indexOf("async function savePrice") + 2000);
      expect(savePriceBody).toContain("onDraftUpdated?.();");
    });

    it("REQUIREMENT: a failed price save returns before onDraftUpdated is ever called — a failure is never treated as saved", () => {
      const savePriceBody = dialogSource.slice(dialogSource.indexOf("async function savePrice"), dialogSource.indexOf("async function savePrice") + 2000);
      const failureReturnIndex = savePriceBody.indexOf('return { ok: false, error: body.error || "Could not save this price." };');
      const onDraftUpdatedIndex = savePriceBody.indexOf("onDraftUpdated?.();");
      expect(failureReturnIndex).toBeGreaterThan(-1);
      expect(onDraftUpdatedIndex).toBeGreaterThan(failureReturnIndex); // the failure `return` exits the function first
    });

    it("category selection and item-specific saves also notify the parent, not just price — the same stale-row-badge bug applied to all of them", () => {
      expect(dialogSource).toMatch(/setUsedFixture\(Boolean\(body\.usedFixture\)\);\s*await load\(\);\s*onDraftUpdated\?\.\(\);/);
      expect(dialogSource).toMatch(/setSearchQuery\(""\);\s*await load\(\);\s*onDraftUpdated\?\.\(\);/);
      expect(dialogSource).toContain('JSON.stringify({ aspectName, value, confirm: true }),\n    });\n    await load();\n    onDraftUpdated?.();');
    });

    it("PROVEN ROOT CAUSE FIX: GroupingWorkspace wires onDraftUpdated to the SAME loadWorkspace() every other mutating action already refreshes through — not a second, bespoke refresh path", () => {
      expect(workspaceSource).toContain("onDraftUpdated={() => { void loadWorkspace(); }}");
    });
  });

  describe("canonical £<->pence conversion (the exact value a save actually persists)", () => {
    it("REQUIREMENT: '30', '30.0', and '30.00' all resolve to exactly 3000 pence", () => {
      expect(parsePriceToPence("30")).toBe(3000);
      expect(parsePriceToPence("30.0")).toBe(3000);
      expect(parsePriceToPence("30.00")).toBe(3000);
    });

    it("REQUIREMENT: empty, whitespace, zero, negative, and malformed input are all invalid (null)", () => {
      expect(parsePriceToPence("")).toBeNull();
      expect(parsePriceToPence("   ")).toBeNull();
      expect(parsePriceToPence("0")).toBeNull();
      expect(parsePriceToPence("0.00")).toBeNull();
      expect(parsePriceToPence("-30")).toBeNull();
      expect(parsePriceToPence("-30.00")).toBeNull();
      expect(parsePriceToPence("NaN")).toBeNull();
      expect(parsePriceToPence("Infinity")).toBeNull();
      expect(parsePriceToPence("abc")).toBeNull();
      expect(parsePriceToPence("£")).toBeNull();
    });

    it("accepts a leading £ symbol and comma decimal separator", () => {
      expect(parsePriceToPence("£30.00")).toBe(3000);
      expect(parsePriceToPence("30,50")).toBe(3050);
    });

    it("formatPenceForInput round-trips the canonical pence value back to a display string", () => {
      expect(formatPenceForInput(3000)).toBe("30.00");
      expect(formatPenceForInput(null)).toBe("");
      expect(formatPenceForInput(parsePriceToPence("30.00")!)).toBe("30.00");
    });
  });

  describe("REGRESSION: Vinted's own price/status behaviour is completely untouched", () => {
    it("the price-save route is called with the literal EBAY_UK marketplace segment, never a generic/shared one that could touch a Vinted draft", () => {
      const dialogSource = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");
      expect(dialogSource).toContain("/api/listing-studio/groups/${draftId}/marketplace-drafts/EBAY_UK");
    });

    it("Vinted's own computeStatus in ProductGroupCard.tsx is untouched by this fix", () => {
      const cardSource = read("components/listing-studio/ProductGroupCard.tsx");
      expect(cardSource).toContain("const status = computeStatus(isUnsorted, listing, isGenerating, hasFailedGeneration, group.vinted_category_id);");
    });
  });
});
