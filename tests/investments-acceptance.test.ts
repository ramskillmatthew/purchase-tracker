import { describe, expect, it } from "vitest";
import { computeHolding } from "@/lib/investments/holding-aggregate";

/**
 * The exact real-world acceptance case supplied during the visual-fidelity
 * repair pass: 4 units of "Chaos Rising Pokemon Center Elite Trainer Box"
 * bought at a weighted-average cost of £54.99/unit, currently priced by
 * PokePulse at £96.66/unit (GBP, so no currency effect). Pinned here as a
 * regression guard — these numbers must never silently drift.
 */
describe("acceptance — Chaos Rising Pokemon Center Elite Trainer Box (qty 4, cost £54.99, market £96.66)", () => {
  const holding = computeHolding(
    [{ id: "buy-1", type: "buy", tradeAt: "2026-05-17", quantity: 4, gbpTotal: 219.96, nativeUnitPrice: 54.99, fxRateAtTrade: 1 }],
    96.66, 1,
  );

  it("invested cost is exactly £219.96", () => {
    expect(holding.costBasisGbp.toDecimalPlaces(2).toNumber()).toBe(219.96);
  });

  it("current value is exactly £386.64", () => {
    expect(holding.currentGbpValue.toDecimalPlaces(2).toNumber()).toBe(386.64);
  });

  it("unrealised return is exactly +£166.68", () => {
    expect(holding.unrealizedGbp.toDecimalPlaces(2).toNumber()).toBe(166.68);
  });

  it("unrealised return percentage is approximately +75.8%", () => {
    expect(holding.unrealizedPercent!.toDecimalPlaces(1).toNumber()).toBeCloseTo(75.8, 1);
  });

  it("the entire return is market growth — currency effect is exactly £0.00 for a GBP-native asset", () => {
    expect(holding.decomposition).not.toBeNull();
    expect(holding.decomposition!.marketComponentGbp.toDecimalPlaces(2).toNumber()).toBe(166.68);
    expect(holding.decomposition!.currencyComponentGbp.toDecimalPlaces(2).toNumber()).toBe(0);
  });
});
