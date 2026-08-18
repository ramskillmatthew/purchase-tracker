import { describe, expect, it } from "vitest";
import { aggregateDecompositions, decomposeReturn } from "@/lib/investments/currency-decomposition";
import { roundGbp } from "@/lib/investments/decimal";

describe("currency-decomposition — market growth vs. currency effect", () => {
  it("SPEC EXAMPLE shape: a USD lot decomposes into market + currency components matching the exact given formulas", () => {
    // 10 shares bought at $100, purchase FX 0.80 GBP/USD (initial GBP cost £800).
    // Now $120/share, FX 0.75 GBP/USD.
    const result = decomposeReturn({
      quantity: 10, purchaseNativePrice: 100, purchaseFxRate: "0.80", currentNativePrice: 120, currentFxRate: "0.75",
    });
    expect(result.initialGbpMarketCost.toString()).toBe("800"); // 100 × 10 × 0.80
    expect(result.marketComponentGbp.toString()).toBe("160"); // (120-100) × 10 × 0.80
    expect(result.currencyComponentGbp.toString()).toBe("-60"); // 120 × 10 × (0.75-0.80)
  });

  it("a rising native price with a strengthening GBP (falling native-per-GBP rate) shows positive market growth offset by negative currency effect", () => {
    const result = decomposeReturn({
      quantity: 5, purchaseNativePrice: 50, purchaseFxRate: 0.9, currentNativePrice: 70, currentFxRate: 0.7,
    });
    expect(result.marketComponentGbp.toNumber()).toBeGreaterThan(0);
    expect(result.currencyComponentGbp.toNumber()).toBeLessThan(0);
  });

  it("REGRESSION: a GBP-denominated asset (Pokémon/LEGO/GBP cash) has EXACTLY zero currency effect — purchaseFxRate and currentFxRate both 1", () => {
    const result = decomposeReturn({
      quantity: 3, purchaseNativePrice: 40, purchaseFxRate: 1, currentNativePrice: 55, currentFxRate: 1,
    });
    expect(result.currencyComponentGbp.toString()).toBe("0");
    // Market component still reflects the real GBP price movement.
    expect(result.marketComponentGbp.toString()).toBe("45"); // (55-40) × 3 × 1
  });

  it("an unchanged FX rate produces zero currency effect even for a non-GBP asset", () => {
    const result = decomposeReturn({
      quantity: 10, purchaseNativePrice: 100, purchaseFxRate: 0.8, currentNativePrice: 150, currentFxRate: 0.8,
    });
    expect(result.currencyComponentGbp.toString()).toBe("0");
  });

  it("a flat native price with a moved FX rate shows zero market growth and non-zero currency effect", () => {
    const result = decomposeReturn({
      quantity: 10, purchaseNativePrice: 100, purchaseFxRate: 0.8, currentNativePrice: 100, currentFxRate: 0.85,
    });
    expect(result.marketComponentGbp.toString()).toBe("0");
    expect(result.currencyComponentGbp.toString()).toBe("50"); // 100 × 10 × (0.85-0.80)
  });

  it("aggregateDecompositions sums market/currency components across multiple lots independently", () => {
    const lotA = decomposeReturn({ quantity: 10, purchaseNativePrice: 100, purchaseFxRate: 0.8, currentNativePrice: 120, currentFxRate: 0.75 });
    const lotB = decomposeReturn({ quantity: 5, purchaseNativePrice: 40, purchaseFxRate: 1, currentNativePrice: 55, currentFxRate: 1 });
    const totals = aggregateDecompositions([lotA, lotB]);
    expect(roundGbp(totals.marketGrowthGbp).toString()).toBe("235"); // 160 + 75 (lotB: (55-40) × 5 × 1)
    expect(roundGbp(totals.currencyEffectGbp).toString()).toBe("-60"); // -60 + 0
  });

  it("fees are not part of either component (accounted for separately in total return)", () => {
    // Decomposition has no fee parameter at all — this test documents that
    // omission is deliberate, not an oversight, by confirming the function
    // signature only accepts price/quantity/fx inputs.
    const result = decomposeReturn({ quantity: 1, purchaseNativePrice: 10, purchaseFxRate: 1, currentNativePrice: 10, currentFxRate: 1 });
    expect(Object.keys(result).sort()).toEqual(["currencyComponentGbp", "initialGbpMarketCost", "marketComponentGbp"]);
  });
});
