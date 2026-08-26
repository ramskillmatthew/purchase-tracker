import { describe, expect, it } from "vitest";
import { reconstructPortfolioValue } from "@/lib/investments/reconstruction";

describe("FX-only movement (sign-off audit item 4 — required invariant, full real pipeline)", () => {
  it("a USD holding with an UNCHANGED native price but two different genuine historical FX rates produces a genuinely different, non-zero GBP portfolio value, with no contribution or withdrawal", () => {
    const points = reconstructPortfolioValue([{
      assetId: "usd-holding",
      transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1440, nativeUnitPrice: 180, fxRateAtTrade: 0.8 }],
      priceHistory: [
        { date: "2026-01-01", nativeUnitPrice: 180, fxRate: 0.8, dataQuality: "market" }, // GBP/USD = 0.80
        { date: "2026-01-02", nativeUnitPrice: 180, fxRate: 0.75, dataQuality: "market" }, // native price UNCHANGED; only the real FX rate moved to 0.75
      ],
      fallbackNativePrice: 180, fallbackFxRate: 0.8,
    }]);

    const day1 = points.find(p => p.date === "2026-01-01")!;
    const day2 = points.find(p => p.date === "2026-01-02")!;

    // The reconstruction itself must reflect the FX move even though quantity and native price are both unchanged.
    expect(day1.totalGbpValue).toBe(1440); // 10 x 180 x 0.80
    expect(day2.totalGbpValue).toBe(1350); // 10 x 180 x 0.75 — a genuine £90 GBP-value drop from FX alone
    expect(day2.totalGbpValue).not.toBe(day1.totalGbpValue);
  });
});

describe("historical reconstruction — purchase-price fallback before real data", () => {
  it("uses purchase price/FX before the first real snapshot, then switches to real market data", () => {
    const points = reconstructPortfolioValue([{
      assetId: "a1",
      transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 }],
      priceHistory: [{ date: "2026-02-01", nativeUnitPrice: 120, fxRate: 0.75, dataQuality: "market" }],
      fallbackNativePrice: 100, fallbackFxRate: 0.8,
    }]);
    const jan = points.find(p => p.date === "2026-01-01");
    const feb = points.find(p => p.date === "2026-02-01");
    expect(jan?.dataQuality).toBe("purchase_price_fallback");
    expect(jan?.totalGbpValue).toBe(800); // 10 × 100 × 0.8, fallback
    expect(feb?.dataQuality).toBe("market");
    expect(feb?.totalGbpValue).toBe(900); // 10 × 120 × 0.75, real
  });

  it("an asset never bought contributes nothing and never fabricates a fallback value", () => {
    const points = reconstructPortfolioValue([{
      assetId: "a1", transactions: [], priceHistory: [], fallbackNativePrice: null, fallbackFxRate: null,
    }]);
    expect(points).toEqual([]);
  });
});

describe("historical reconstruction — transaction quantities apply on their real dates", () => {
  it("a sale reduces the asset's contribution to the total from its trade date onward", () => {
    const points = reconstructPortfolioValue([{
      assetId: "a1",
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 },
        { id: "s1", type: "sell", tradeAt: "2026-01-15", quantity: 4, gbpTotal: 500 },
      ],
      priceHistory: [{ date: "2026-01-01", nativeUnitPrice: 100, fxRate: 1, dataQuality: "market" }],
      fallbackNativePrice: 100, fallbackFxRate: 1,
    }]);
    const beforeSale = points.find(p => p.date === "2026-01-01");
    const afterSale = points.find(p => p.date === "2026-01-15");
    expect(beforeSale?.totalGbpValue).toBe(1000); // 10 units
    expect(afterSale?.totalGbpValue).toBe(600); // 6 units remain × 100
  });

  it("a fully-sold asset contributes zero from its final sale date onward", () => {
    const points = reconstructPortfolioValue([{
      assetId: "a1",
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 },
        { id: "s1", type: "sell", tradeAt: "2026-01-15", quantity: 10, gbpTotal: 1200 },
      ],
      priceHistory: [{ date: "2026-01-01", nativeUnitPrice: 100, fxRate: 1, dataQuality: "market" }],
      fallbackNativePrice: 100, fallbackFxRate: 1,
    }]);
    const afterSale = points.find(p => p.date === "2026-01-15");
    expect(afterSale?.totalGbpValue).toBe(0);
  });
});

describe("historical reconstruction — multi-asset portfolio totals and data-quality mixing", () => {
  it("sums GBP value across assets on the same date", () => {
    const points = reconstructPortfolioValue([
      {
        assetId: "a1",
        transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 }],
        priceHistory: [{ date: "2026-01-01", nativeUnitPrice: 100, fxRate: 1, dataQuality: "market" }],
        fallbackNativePrice: 100, fallbackFxRate: 1,
      },
      {
        assetId: "a2",
        transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-01", quantity: 5, gbpTotal: 500, nativeUnitPrice: 100, fxRateAtTrade: 1 }],
        priceHistory: [{ date: "2026-01-01", nativeUnitPrice: 100, fxRate: 1, dataQuality: "market" }],
        fallbackNativePrice: 100, fallbackFxRate: 1,
      },
    ]);
    expect(points.find(p => p.date === "2026-01-01")?.totalGbpValue).toBe(1500);
  });

  it("marks a date 'mixed' when one asset is on real data and another is still on purchase-price fallback", () => {
    const points = reconstructPortfolioValue([
      {
        assetId: "a1",
        transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 1, gbpTotal: 100, nativeUnitPrice: 100, fxRateAtTrade: 1 }],
        priceHistory: [{ date: "2026-01-01", nativeUnitPrice: 100, fxRate: 1, dataQuality: "market" }],
        fallbackNativePrice: 100, fallbackFxRate: 1,
      },
      {
        assetId: "a2",
        transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-01", quantity: 1, gbpTotal: 50, nativeUnitPrice: 50, fxRateAtTrade: 1 }],
        priceHistory: [], // no real data yet — still on fallback
        fallbackNativePrice: 50, fallbackFxRate: 1,
      },
    ]);
    expect(points.find(p => p.date === "2026-01-01")?.dataQuality).toBe("mixed");
  });
});
