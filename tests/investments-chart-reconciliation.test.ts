import { describe, expect, it } from "vitest";
import { reconcileFinalChartPoint } from "@/lib/investments/chart-reconciliation";

describe("reconcileFinalChartPoint", () => {
  it("matches when the final chart point exactly equals the summary total", () => {
    const result = reconcileFinalChartPoint(16548.18, 16548.18);
    expect(result.matches).toBe(true);
    expect(result.diffGbp).toBe(0);
  });

  it("matches within ordinary rounding tolerance", () => {
    const result = reconcileFinalChartPoint(16548.19, 16548.17);
    expect(result.matches).toBe(true);
  });

  it("does NOT match a genuine discrepancy beyond tolerance", () => {
    const result = reconcileFinalChartPoint(16548.18, 16000.00);
    expect(result.matches).toBe(false);
    expect(result.diffGbp).toBeCloseTo(548.18);
  });

  it("never force-corrects — diffGbp reports the real discrepancy, the inputs are never mutated to agree", () => {
    const result = reconcileFinalChartPoint(100, 90);
    expect(result.finalChartValueGbp).toBe(100);
    expect(result.summaryTotalGbp).toBe(90);
    expect(result.diffGbp).toBe(10);
  });

  it("produces an asset-level breakdown identifying exactly which asset disagrees", () => {
    const result = reconcileFinalChartPoint(1000, 950, [
      { assetId: "a", displayName: "Asset A", chartContributionGbp: 500, summaryContributionGbp: 500 },
      { assetId: "b", displayName: "Asset B", chartContributionGbp: 500, summaryContributionGbp: 450 },
    ]);
    expect(result.matches).toBe(false);
    expect(result.mismatchedAssets).toHaveLength(1);
    expect(result.mismatchedAssets[0].assetId).toBe("b");
    expect(result.mismatchedAssets[0].diffGbp).toBeCloseTo(50);
  });

  it("an asset within tolerance is excluded from the mismatch breakdown even if the total itself is checked", () => {
    const result = reconcileFinalChartPoint(1000.02, 1000, [
      { assetId: "a", displayName: "Asset A", chartContributionGbp: 500.02, summaryContributionGbp: 500 },
      { assetId: "b", displayName: "Asset B", chartContributionGbp: 500, summaryContributionGbp: 500 },
    ]);
    expect(result.matches).toBe(true);
    expect(result.mismatchedAssets).toHaveLength(0);
  });

  it("a custom tighter tolerance can be supplied", () => {
    const result = reconcileFinalChartPoint(100.03, 100, [], 0.01);
    expect(result.matches).toBe(false);
  });
});
