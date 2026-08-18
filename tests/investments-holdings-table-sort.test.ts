import { describe, expect, it } from "vitest";
import { sortHoldings } from "@/lib/investments/holdings-table-sort";
import type { HoldingResponse } from "@/lib/investments/view-model-types";

/**
 * A realistic MIXED-CATEGORY holdings list — stocks, Pokémon, LEGO, and a
 * negative-return holding thrown in — exercising exactly the shape the
 * dashboard will show once every category has real holdings, not just the
 * single-Pokémon-row state this feature has mostly been tested against.
 */
function holding(overrides: Partial<HoldingResponse>): HoldingResponse {
  return {
    assetId: "x", category: "stock", displayName: "X", ticker: "X",
    quantity: "1", costBasisGbp: 100, currentGbpValue: 100, unrealizedGbp: 0, unrealizedPercent: 0,
    allocationPercent: 0, nativeCurrency: "GBP", pricingProvider: "manual", imageUrl: null, sourceUrl: null,
    currentNativePrice: 100, priceAt: null, dataQuality: null, sparkline: [],
    ...overrides,
  };
}

const MIXED_PORTFOLIO: HoldingResponse[] = [
  holding({ assetId: "nvda", category: "stock", displayName: "NVIDIA", ticker: "NVDA", currentGbpValue: 5472, unrealizedPercent: 42.83, allocationPercent: 22.0 }),
  holding({ assetId: "voo", category: "stock", displayName: "Vanguard S&P 500 ETF", ticker: "VOO", currentGbpValue: 4810.8, unrealizedPercent: 16.46, allocationPercent: 19.3 }),
  holding({ assetId: "poke1", category: "pokemon", displayName: "Prismatic Evolutions Elite Trainer Box", ticker: null, currentGbpValue: 2850, unrealizedPercent: 33.33, allocationPercent: 11.5, pricingProvider: "pokepulse" }),
  holding({ assetId: "poke2", category: "pokemon", displayName: "Chaos Rising Pokemon Center Elite Trainer Box", ticker: null, currentGbpValue: 2620, unrealizedPercent: 23.38, allocationPercent: 10.5, pricingProvider: "pokepulse" }),
  holding({ assetId: "lego1", category: "lego", displayName: "LEGO Star Wars UCS Millennium Falcon", ticker: null, currentGbpValue: 2890, unrealizedPercent: 11.12, allocationPercent: 11.6, pricingProvider: "manual" }),
  holding({ assetId: "loser", category: "stock", displayName: "Loser Corp", ticker: "LOSE", currentGbpValue: 400, unrealizedPercent: -18.5, allocationPercent: 1.6 }),
];

describe("sortHoldings — realistic multi-category dataset (stock + pokemon + lego, mixed +/- returns)", () => {
  it("sorts by GBP value, descending by default — matches the reference's own value-sorted order", () => {
    const sorted = sortHoldings(MIXED_PORTFOLIO, "value", true);
    expect(sorted.map(h => h.assetId)).toEqual(["nvda", "voo", "lego1", "poke1", "poke2", "loser"]);
  });

  it("sorts by return percentage, correctly interleaving categories and handling a negative return", () => {
    const sorted = sortHoldings(MIXED_PORTFOLIO, "return", true);
    expect(sorted.map(h => h.assetId)).toEqual(["nvda", "poke1", "poke2", "voo", "lego1", "loser"]);
    expect(sorted[sorted.length - 1].unrealizedPercent).toBeLessThan(0);
  });

  it("ascending toggles the exact reverse order, not a different sort", () => {
    const desc = sortHoldings(MIXED_PORTFOLIO, "allocation", true).map(h => h.assetId);
    const asc = sortHoldings(MIXED_PORTFOLIO, "allocation", false).map(h => h.assetId);
    expect(asc).toEqual([...desc].reverse());
  });

  it("a holding with a null unrealizedPercent (never priced) sorts last on return, never crashes or NaNs the comparator", () => {
    const withUnpriced = [...MIXED_PORTFOLIO, holding({ assetId: "unpriced", unrealizedPercent: null, currentGbpValue: 50 })];
    const sorted = sortHoldings(withUnpriced, "return", true);
    expect(sorted[sorted.length - 1].assetId).toBe("unpriced");
  });

  it("never mutates the input array (the component re-renders from the same source list on every sort-key change)", () => {
    const original = [...MIXED_PORTFOLIO];
    sortHoldings(MIXED_PORTFOLIO, "value", true);
    expect(MIXED_PORTFOLIO).toEqual(original);
  });
});
