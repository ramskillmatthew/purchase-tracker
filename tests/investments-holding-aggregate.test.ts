import { describe, expect, it } from "vitest";
import { computeHolding, deriveEffectiveFxRate, deriveFallbackPrice } from "@/lib/investments/holding-aggregate";
import { roundGbp } from "@/lib/investments/decimal";

describe("holding-aggregate — single-buy USD holding matches the currency-decomposition spec example exactly", () => {
  it("reproduces the exact market/currency split for one buy", () => {
    const result = computeHolding(
      [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 }],
      120, // current native price
      0.75, // current fx rate
    );
    expect(result.quantity.toString()).toBe("10");
    expect(result.costBasisGbp.toString()).toBe("800");
    expect(result.decomposition).not.toBeNull();
    expect(result.decomposition!.marketComponentGbp.toString()).toBe("160"); // (120-100) × 10 × 0.80
    expect(result.decomposition!.currencyComponentGbp.toString()).toBe("-60"); // 120 × 10 × (0.75-0.80)
    expect(result.decomposition!.initialGbpMarketCost.toString()).toBe("800");
  });

  it("current GBP value and unrealised return are computed from current price × quantity × current FX", () => {
    const result = computeHolding(
      [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 }],
      120, 0.75,
    );
    expect(roundGbp(result.currentGbpValue).toString()).toBe("900"); // 120 × 10 × 0.75
    expect(roundGbp(result.unrealizedGbp).toString()).toBe("100"); // 900 - 800
  });
});

describe("holding-aggregate — weighted-average multi-buy decomposition", () => {
  it("uses a native-spend-weighted average purchase price and FX rate across two buys at different rates", () => {
    const result = computeHolding(
      [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "b2", type: "buy", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 900, nativeUnitPrice: 100, fxRateAtTrade: 0.9 },
      ],
      120, 0.75,
    );
    // Native spend: 1000 (100×10 + 100×10) over 20 units -> avg native price 100.
    // GBP spend: 1700 over native spend 1000 -> avg fx rate 1.7.
    expect(result.decomposition!.initialGbpMarketCost.toString()).toBe("1700"); // reconstructs the real total cost basis exactly
    expect(result.costBasisGbp.toString()).toBe("1700");
  });
});

describe("holding-aggregate — GBP-denominated asset (Pokémon/LEGO) has zero currency effect", () => {
  it("decomposition currencyComponentGbp is exactly zero when fxRateAtTrade is 1 throughout", () => {
    const result = computeHolding(
      [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 3, gbpTotal: 120, nativeUnitPrice: 40, fxRateAtTrade: 1 }],
      55, 1,
    );
    expect(result.decomposition!.currencyComponentGbp.toString()).toBe("0");
    expect(result.decomposition!.marketComponentGbp.toString()).toBe("45"); // (55-40) × 3 × 1
  });
});

describe("holding-aggregate — no decomposition for an empty (fully sold) position", () => {
  it("decomposition is null once quantity is zero — nothing to decompose", () => {
    const result = computeHolding(
      [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 900 },
      ],
      120, 0.75,
    );
    expect(result.quantity.toString()).toBe("0");
    expect(result.decomposition).toBeNull();
    expect(result.realizedSales).toHaveLength(1);
  });
});

describe("holding-aggregate — realised sales carry through unchanged from reduceLedger", () => {
  it("a partial sale reduces quantity/cost basis and produces one realised sale entry", () => {
    const result = computeHolding(
      [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 4, gbpTotal: 500 },
      ],
      110, 1,
    );
    expect(result.quantity.toString()).toBe("6");
    expect(result.realizedSales).toHaveLength(1);
    expect(result.realizedSales[0].realizedPnlGbp.toString()).toBe("100"); // 500 - (4×100)
  });
});

describe("deriveEffectiveFxRate — REGRESSION: recovers the real rate from recorded amounts when fx_rate_at_trade is null", () => {
  it("derives gbp_total / (native_unit_price × quantity) exactly", () => {
    expect(deriveEffectiveFxRate(100, 10, 800)).toBe(0.8);
  });

  it("returns null for a non-finite/non-positive native price — never guesses", () => {
    expect(deriveEffectiveFxRate(null, 10, 800)).toBeNull();
    expect(deriveEffectiveFxRate(0, 10, 800)).toBeNull();
    expect(deriveEffectiveFxRate(-5, 10, 800)).toBeNull();
    expect(deriveEffectiveFxRate(NaN, 10, 800)).toBeNull();
  });

  it("returns null for a non-positive quantity", () => {
    expect(deriveEffectiveFxRate(100, 0, 800)).toBeNull();
    expect(deriveEffectiveFxRate(100, -1, 800)).toBeNull();
  });

  it("returns null for a non-positive derived rate (e.g. a genuinely zero/negative gbpTotal)", () => {
    expect(deriveEffectiveFxRate(100, 10, 0)).toBeNull();
    expect(deriveEffectiveFxRate(100, 10, -50)).toBeNull();
  });
});

describe("deriveFallbackPrice — REGRESSION: the confirmed-live null fx_rate_at_trade bug", () => {
  it("CONFIRMED LIVE: every real buy transaction in this database has fx_rate_at_trade=null — a non-GBP asset must still derive a real fallback rate, never silently exclude the holding (the duplicate-NVDA 9-month gap) or silently assume 1:1 (the holding-detail route's own prior bug)", () => {
    const { fallbackNativePrice, fallbackFxRate } = deriveFallbackPrice(
      { nativeUnitPrice: 450, quantity: 2, gbpTotal: 720, fxRateAtTrade: null }, "USD",
    );
    expect(fallbackNativePrice).toBe(450);
    expect(fallbackFxRate).toBeCloseTo(0.8); // 720 / (450×2) — never null, never 1
  });

  it("GBP-native assets are pinned to exactly 1 — never the derived value (which would just be floating-point noise around 1)", () => {
    const { fallbackFxRate } = deriveFallbackPrice({ nativeUnitPrice: 60, quantity: 1, gbpTotal: 60.0000001, fxRateAtTrade: null }, "GBP");
    expect(fallbackFxRate).toBe(1);
  });

  it("prefers a genuinely recorded fx_rate_at_trade over the derived value when one exists", () => {
    const { fallbackFxRate } = deriveFallbackPrice({ nativeUnitPrice: 100, quantity: 10, gbpTotal: 800, fxRateAtTrade: 0.79 }, "USD");
    expect(fallbackFxRate).toBe(0.79);
  });

  it("no buy transaction at all — both null, nothing to fall back to", () => {
    expect(deriveFallbackPrice(undefined, "USD")).toEqual({ fallbackNativePrice: null, fallbackFxRate: null });
  });

  it("a buy with no recorded native price and no fx_rate_at_trade cannot derive anything — both null, never guessed", () => {
    const { fallbackNativePrice, fallbackFxRate } = deriveFallbackPrice({ nativeUnitPrice: null, quantity: 10, gbpTotal: 800, fxRateAtTrade: null }, "USD");
    expect(fallbackNativePrice).toBeNull();
    expect(fallbackFxRate).toBeNull();
  });
});
