import { describe, expect, it } from "vitest";
import { computeMarketplaceReadiness, type MarketplaceReadinessInput } from "@/lib/listing-studio/marketplace-readiness";

function fullyReadyInput(overrides: Partial<MarketplaceReadinessInput> = {}): MarketplaceReadinessInput {
  return {
    hasCategory: true, hasCondition: true, hasTitle: true, hasDescriptionOrGenerationPath: true,
    hasPhoto: true, hasPrice: true, hasQuantity: true, hasSufficientSellingSettings: true,
    requiredAspectsFilled: [], recommendedAspectsFilled: [],
    ...overrides,
  };
}

describe("computeMarketplaceReadiness — Phase 4/5: hasGeneratedContent as a genuine, separate blocking gate", () => {
  it("REGRESSION (backward compatibility): omitting hasGeneratedContent entirely defaults to true — no existing caller is silently blocked by a field it never knew about", () => {
    const readiness = computeMarketplaceReadiness(fullyReadyInput());
    expect(readiness.ready).toBe(true);
    expect(readiness.requiredTotal).toBe(8); // 7 original core checks (hasPrice excluded — see Stage 6) + hasGeneratedContent
  });

  it("PROVEN ROOT CAUSE FIX: hasGeneratedContent: false blocks readiness even when every other field (including a FALLBACK draft's own non-empty title/description) is present", () => {
    const readiness = computeMarketplaceReadiness(fullyReadyInput({ hasGeneratedContent: false }));
    expect(readiness.ready).toBe(false);
    expect(readiness.requiredComplete).toBe(7); // everything else still counts, only this one gate fails
  });

  it("missing category blocks readiness", () => {
    expect(computeMarketplaceReadiness(fullyReadyInput({ hasCategory: false })).ready).toBe(false);
  });
  it("missing condition blocks readiness", () => {
    expect(computeMarketplaceReadiness(fullyReadyInput({ hasCondition: false })).ready).toBe(false);
  });
  it("Stage 6 correction: missing price never blocks readiness — content can be complete with no price yet (entered later in Listings Review)", () => {
    const readiness = computeMarketplaceReadiness(fullyReadyInput({ hasPrice: false }));
    expect(readiness.ready).toBe(true);
    expect(readiness.completionPercent).toBe(100);
  });
  it("a missing required aspect blocks readiness", () => {
    expect(computeMarketplaceReadiness(fullyReadyInput({ requiredAspectsFilled: [true, false] })).ready).toBe(false);
  });
  it("optional/recommended aspects never block readiness, only completionPercent", () => {
    const readiness = computeMarketplaceReadiness(fullyReadyInput({ recommendedAspectsFilled: [true, false, false] }));
    expect(readiness.ready).toBe(true);
    expect(readiness.completionPercent).toBeLessThan(100);
  });
});
