import { describe, expect, it } from "vitest";
import { reconstructIntradaySeries, type IntradayAssetInput } from "@/lib/investments/intraday";

describe("reconstructIntradaySeries", () => {
  it("returns an empty series when no asset has genuine intraday data (1D truthfully unavailable, not a flat fabricated line)", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 5, fxRateToday: 1, kind: "constant", nativeUnitPrice: 100 },
    ];
    expect(reconstructIntradaySeries(assets, 0)).toEqual([]);
  });

  it("one point per distinct real intraday timestamp — never a fabricated fixed interval", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 2, fxRateToday: 1, kind: "intraday", points: [
        { timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 },
        { timestamp: "2026-08-14T09:45:00", nativeUnitPrice: 101 },
      ] },
    ];
    const series = reconstructIntradaySeries(assets, 0);
    expect(series.map(p => p.timestamp)).toEqual(["2026-08-14T09:30:00", "2026-08-14T09:45:00"]);
    expect(series[0].totalGbpValue).toBe(200);
    expect(series[1].totalGbpValue).toBe(202);
  });

  it("applies today's single FX rate to a non-GBP intraday asset", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 10, fxRateToday: 0.8, kind: "intraday", points: [{ timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }] },
    ];
    expect(reconstructIntradaySeries(assets, 0)[0].totalGbpValue).toBe(800);
  });

  it("a mixed-resolution portfolio: an intraday stock plus a constant-carried-forward asset (e.g. a Pokémon card) sums correctly at every intraday timestamp", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "stock", quantity: 1, fxRateToday: 1, kind: "intraday", points: [
        { timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 500 },
        { timestamp: "2026-08-14T09:45:00", nativeUnitPrice: 510 },
      ] },
      { assetId: "card", quantity: 3, fxRateToday: 1, kind: "constant", nativeUnitPrice: 100 },
    ];
    const series = reconstructIntradaySeries(assets, 0);
    expect(series[0].totalGbpValue).toBe(500 + 300);
    expect(series[1].totalGbpValue).toBe(510 + 300);
  });

  it("dataQuality is 'market' when every contributing asset is a genuine intraday tick", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 1, fxRateToday: 1, kind: "intraday", points: [{ timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }] },
    ];
    expect(reconstructIntradaySeries(assets, 0)[0].dataQuality).toBe("market");
  });

  it("dataQuality is 'mixed' when a real intraday tick and a constant-carried-forward asset both contribute", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "stock", quantity: 1, fxRateToday: 1, kind: "intraday", points: [{ timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }] },
      { assetId: "card", quantity: 1, fxRateToday: 1, kind: "constant", nativeUnitPrice: 50 },
    ];
    expect(reconstructIntradaySeries(assets, 0)[0].dataQuality).toBe("mixed");
  });

  it("a sold-out (zero quantity) asset contributes £0, even though its own real timestamps still define the session's timeline", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 0, fxRateToday: 1, kind: "intraday", points: [{ timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }] },
    ];
    expect(reconstructIntradaySeries(assets, 0)[0].totalGbpValue).toBe(0);
  });

  it("a constant asset with no known price (never priced) is skipped rather than treated as zero", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "stock", quantity: 1, fxRateToday: 1, kind: "intraday", points: [{ timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }] },
      { assetId: "unpriced", quantity: 5, fxRateToday: 1, kind: "constant", nativeUnitPrice: null },
    ];
    expect(reconstructIntradaySeries(assets, 0)[0].totalGbpValue).toBe(100);
  });

  it("cash is added as a flat constant at every timestamp", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 1, fxRateToday: 1, kind: "intraday", points: [
        { timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }, { timestamp: "2026-08-14T09:45:00", nativeUnitPrice: 105 },
      ] },
    ];
    const series = reconstructIntradaySeries(assets, 250);
    expect(series[0].totalGbpValue).toBe(350);
    expect(series[1].totalGbpValue).toBe(355);
  });

  it("uses the most recent intraday bar AT OR BEFORE each timestamp — never a future bar, never interpolation", () => {
    const assets: IntradayAssetInput[] = [
      { assetId: "a", quantity: 1, fxRateToday: 1, kind: "intraday", points: [{ timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 100 }] },
      { assetId: "b", quantity: 1, fxRateToday: 1, kind: "intraday", points: [
        { timestamp: "2026-08-14T09:30:00", nativeUnitPrice: 50 }, { timestamp: "2026-08-14T09:45:00", nativeUnitPrice: 60 },
      ] },
    ];
    const series = reconstructIntradaySeries(assets, 0);
    // at 09:45, asset "a" has no bar of its own yet — it must use its LAST
    // known bar (09:30's 100), never asset b's 09:45 bar or an average.
    const at0945 = series.find(p => p.timestamp === "2026-08-14T09:45:00")!;
    expect(at0945.totalGbpValue).toBe(100 + 60);
  });
});
