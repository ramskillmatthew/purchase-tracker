/**
 * Proves (rather than assumes) that the chart's own final reconstructed
 * point agrees with the portfolio summary's current total — both are
 * supposed to describe "the portfolio right now", computed via two
 * genuinely different code paths (reconstructPortfolioValue's per-date
 * walk vs. computePortfolio's direct current-price sum), so nothing
 * guarantees they stay in sync automatically; this makes that agreement a
 * checkable fact instead of a hope. Never "fixes" a mismatch by forcing
 * one number to equal the other — a real mismatch means one of the two
 * computations has a genuine defect, and this utility's whole job is
 * surfacing exactly which asset it's in.
 */

export type AssetContribution = { assetId: string; displayName: string; chartContributionGbp: number; summaryContributionGbp: number };
export type AssetReconciliationRow = AssetContribution & { diffGbp: number };
export type ReconciliationResult = {
  matches: boolean; diffGbp: number; toleranceGbp: number;
  finalChartValueGbp: number; summaryTotalGbp: number;
  /** Only the assets whose own chart-vs-summary contribution actually differs beyond tolerance — empty when everything reconciles, or when no breakdown was supplied. */
  mismatchedAssets: AssetReconciliationRow[];
};

/**
 * Default tolerance covers ordinary 2-decimal-place GBP rounding drift
 * across several assets' contributions summing together — never so wide
 * that it would silently swallow a genuine data defect.
 */
const DEFAULT_TOLERANCE_GBP = 0.05;

export function reconcileFinalChartPoint(
  finalChartValueGbp: number,
  summaryTotalGbp: number,
  assetBreakdown: AssetContribution[] = [],
  toleranceGbp: number = DEFAULT_TOLERANCE_GBP,
): ReconciliationResult {
  const diffGbp = Math.round((finalChartValueGbp - summaryTotalGbp) * 1e6) / 1e6;
  const mismatchedAssets = assetBreakdown
    .map(a => ({ ...a, diffGbp: Math.round((a.chartContributionGbp - a.summaryContributionGbp) * 1e6) / 1e6 }))
    .filter(a => Math.abs(a.diffGbp) > toleranceGbp);

  return {
    matches: Math.abs(diffGbp) <= toleranceGbp,
    diffGbp, toleranceGbp, finalChartValueGbp, summaryTotalGbp, mismatchedAssets,
  };
}
