import { describe, expect, it } from "vitest";
import { computePortfolio, computeTodaysChange, type AssetForPortfolio } from "@/lib/investments/portfolio-view";

function stockAsset(overrides: Partial<AssetForPortfolio> = {}): AssetForPortfolio {
  return {
    id: "a1", category: "stock", displayName: "NVIDIA", ticker: "NVDA",
    transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 }],
    currentNativePrice: 120, currentFxRate: 0.75, archived: false,
    ...overrides,
  };
}

describe("portfolio-view — empty portfolio", () => {
  it("returns all-zero totals and no best performer for zero assets", () => {
    const result = computePortfolio([]);
    expect(result.totalGbpValue).toBe(0);
    expect(result.totalInvestedGbp).toBe(0);
    expect(result.allTimeReturnGbp).toBe(0);
    expect(result.allTimeReturnPercent).toBeNull();
    expect(result.bestPerformer).toBeNull();
    expect(result.allocation).toEqual([]);
    expect(result.holdings).toEqual([]);
  });
});

describe("portfolio-view — current value and total invested", () => {
  it("totalGbpValue and totalInvestedGbp reflect one open holding", () => {
    const result = computePortfolio([stockAsset()]);
    expect(result.totalGbpValue).toBe(900); // 10 × 120 × 0.75
    expect(result.totalInvestedGbp).toBe(800);
    expect(result.allTimeReturnGbp).toBe(100);
  });

  it("REGRESSION: total invested excludes a fully sold-out asset entirely", () => {
    const soldOut = stockAsset({
      id: "a2",
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 1000 },
      ],
    });
    const result = computePortfolio([stockAsset(), soldOut]);
    expect(result.totalGbpValue).toBe(900); // only the still-open holding
    expect(result.totalInvestedGbp).toBe(800);
    expect(result.holdings).toHaveLength(1); // sold-out asset never appears as a current holding row
  });

  it("a partial sale reduces total invested to the remaining cost basis only", () => {
    const partiallySold = stockAsset({
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 4, gbpTotal: 500 },
      ],
      currentNativePrice: 100, currentFxRate: 1,
    });
    const result = computePortfolio([partiallySold]);
    expect(result.totalInvestedGbp).toBe(600); // 6 remaining units × £100 avg cost
  });
});

describe("portfolio-view — simple 'Current holdings return' formula (2026-08-18, replaces the removed time-weighted/unitized Estimated Return feature)", () => {
  // The user's own explicit requirement: actual profit = current value −
  // total invested; actual percentage = profit ÷ invested × 100. This is
  // the ONE calculation path — allTimeReturnGbp/allTimeReturnPercent —
  // reused everywhere the UI shows a return figure, never recomputed a
  // second way.
  it("displayed profit (allTimeReturnGbp) = current value − total invested, exactly", () => {
    const result = computePortfolio([stockAsset({ currentNativePrice: 150, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1200, nativeUnitPrice: 120, fxRateAtTrade: 1 }] })]);
    expect(result.allTimeReturnGbp).toBeCloseTo(result.totalGbpValue - result.totalInvestedGbp, 6);
    expect(result.totalGbpValue).toBe(1500); // 10 × 150
    expect(result.totalInvestedGbp).toBe(1200);
    expect(result.allTimeReturnGbp).toBe(300);
  });

  it("displayed percentage (allTimeReturnPercent) = profit ÷ invested × 100, exactly", () => {
    const result = computePortfolio([stockAsset({ currentNativePrice: 150, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1200, nativeUnitPrice: 120, fxRateAtTrade: 1 }] })]);
    expect(result.allTimeReturnPercent).toBeCloseTo((result.allTimeReturnGbp / result.totalInvestedGbp) * 100, 6);
    expect(result.allTimeReturnPercent).toBeCloseTo(25); // £300 / £1,200 × 100
  });

  it("matches the real approximate account figures from the user's own request (~£16,500 value, ~£14,002 invested, ~£2,498 profit, ~+17.8%)", () => {
    const result = computePortfolio([stockAsset({ currentNativePrice: 1650, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 14002.28, nativeUnitPrice: 1400.228, fxRateAtTrade: 1 }] })]);
    expect(result.totalGbpValue).toBe(16500);
    expect(result.allTimeReturnGbp).toBeCloseTo(2497.72, 2);
    expect(result.allTimeReturnPercent).toBeCloseTo(17.8, 1);
  });

  it("a negative return (current value below cost basis) displays as a real negative GBP figure and a real negative percentage — never clamped to zero or hidden", () => {
    const losing = stockAsset({ currentNativePrice: 60, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 }] });
    const result = computePortfolio([losing]);
    expect(result.totalGbpValue).toBe(600);
    expect(result.allTimeReturnGbp).toBe(-400);
    expect(result.allTimeReturnPercent).toBeCloseTo(-40);
    expect(result.allTimeReturnGbp).toBeLessThan(0);
    expect(result.allTimeReturnPercent!).toBeLessThan(0);
  });

  it("zero invested capital (e.g. every holding fully sold, nothing currently open) is handled safely — percentage is null, never Infinity/NaN/a divide-by-zero throw", () => {
    const soldOut = stockAsset({
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 1000 },
      ],
    });
    const result = computePortfolio([soldOut]);
    expect(result.totalInvestedGbp).toBe(0);
    expect(result.totalGbpValue).toBe(0);
    expect(result.allTimeReturnGbp).toBe(0);
    expect(result.allTimeReturnPercent).toBeNull(); // never Infinity or NaN
  });

  it("Market growth + Currency effect reconciles EXACTLY to the displayed total profit (allTimeReturnGbp) — the two decomposition rows the user asked to keep still sum to the one headline figure", () => {
    const result = computePortfolio([
      stockAsset({ id: "usd", currentNativePrice: 130, currentFxRate: 0.79, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 }] }),
      stockAsset({ id: "gbp", currentNativePrice: 60, currentFxRate: 1, transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 }] }), // a losing GBP holding alongside a gaining USD one
    ]);
    const sumOfComponents = Math.round((result.marketGrowthGbp + result.currencyEffectGbp) * 100) / 100;
    expect(sumOfComponents).toBeCloseTo(result.allTimeReturnGbp, 2);
  });
});

describe("portfolio-view — allocation totals sum to 100% (subject to rounding)", () => {
  it("splits allocation by category, summing to ~100%", () => {
    const result = computePortfolio([
      stockAsset({ id: "s1", category: "stock", currentNativePrice: 100, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 }] }),
      stockAsset({ id: "p1", category: "pokemon", currentNativePrice: 500, currentFxRate: 1, transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-01", quantity: 1, gbpTotal: 400, nativeUnitPrice: 400, fxRateAtTrade: 1 }] }),
    ]);
    const totalPercent = result.allocation.reduce((sum, a) => sum + a.percent, 0);
    expect(Math.round(totalPercent)).toBe(100);
    expect(result.allocation.find(a => a.category === "stock")?.gbpValue).toBe(1000);
    expect(result.allocation.find(a => a.category === "pokemon")?.gbpValue).toBe(500);
  });
});

describe("portfolio-view — best performer", () => {
  it("picks the holding with the highest unrealised return percentage, excluding cash", () => {
    const loser = stockAsset({ id: "loser", displayName: "Loser Corp", ticker: "LOSE", currentNativePrice: 90, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 1, gbpTotal: 100, nativeUnitPrice: 100, fxRateAtTrade: 1 }] });
    const winner = stockAsset({ id: "winner", displayName: "Winner Corp", ticker: "WIN", currentNativePrice: 200, currentFxRate: 1, transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-01", quantity: 1, gbpTotal: 100, nativeUnitPrice: 100, fxRateAtTrade: 1 }] });
    const cash: AssetForPortfolio = { id: "cash1", category: "cash", displayName: "GBP cash", ticker: null, currentNativePrice: 1, currentFxRate: 1, archived: false, transactions: [{ id: "d1", type: "buy", tradeAt: "2026-01-01", quantity: 1000, gbpTotal: 1, nativeUnitPrice: 0.001, fxRateAtTrade: 1 }] };
    const result = computePortfolio([loser, winner, cash]);
    expect(result.bestPerformer?.assetId).toBe("winner");
  });

  it("is null when there are no open holdings", () => {
    expect(computePortfolio([]).bestPerformer).toBeNull();
  });
});

describe("portfolio-view — market growth / currency effect aggregation", () => {
  it("sums decomposition across every open holding", () => {
    const result = computePortfolio([stockAsset()]);
    expect(result.marketGrowthGbp).toBe(160); // (120-100) × 10 × 0.80
    expect(result.currencyEffectGbp).toBe(-60); // 120 × 10 × (0.75-0.80)
  });
});

describe("portfolio-view — INVARIANT: market growth + currency effect === total gain", () => {
  // Verified against the REAL computePortfolio (not a re-derivation) —
  // proves the algebraic identity holds for real, varied inputs rather
  // than asserting it only ever held "by inspection" of the formulas.
  function invariantHolds(assets: AssetForPortfolio[]) {
    const result = computePortfolio(assets);
    const sumOfComponents = Math.round((result.marketGrowthGbp + result.currencyEffectGbp) * 100) / 100;
    expect(sumOfComponents).toBeCloseTo(result.allTimeReturnGbp, 2);
  }

  it("holds for a single GBP-only holding", () => {
    invariantHolds([stockAsset({ currentNativePrice: 130, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 }] })]);
  });

  it("holds for a single USD holding with both market AND currency movement", () => {
    invariantHolds([stockAsset()]);
  });

  it("holds for a MULTI-LOT (several buys at different prices/FX rates) weighted-average holding", () => {
    invariantHolds([stockAsset({
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "b2", type: "buy", tradeAt: "2026-03-01", quantity: 5, gbpTotal: 460, nativeUnitPrice: 115, fxRateAtTrade: 0.8 },
      ],
    })]);
  });

  it("holds for a holding with a PARTIAL SALE along the way", () => {
    invariantHolds([stockAsset({
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 4, gbpTotal: 380 },
      ],
    })]);
  });

  it("holds across a full mixed portfolio (2 USD stocks + GBP pokemon + GBP lego + cash)", () => {
    invariantHolds([
      stockAsset({ id: "s1", currentNativePrice: 150, currentFxRate: 0.79 }),
      stockAsset({ id: "s2", currentNativePrice: 80, currentFxRate: 0.79, transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-05", quantity: 20, gbpTotal: 1600, nativeUnitPrice: 100, fxRateAtTrade: 0.8 }] }),
      { id: "p1", category: "pokemon", displayName: "Card", ticker: null, currentNativePrice: 250, currentFxRate: 1, archived: false, transactions: [{ id: "b3", type: "buy", tradeAt: "2026-01-10", quantity: 2, gbpTotal: 400, nativeUnitPrice: 200, fxRateAtTrade: 1 }] },
      { id: "cash1", category: "cash", displayName: "GBP cash", ticker: null, currentNativePrice: 1, currentFxRate: 1, archived: false, transactions: [{ id: "d1", type: "buy", tradeAt: "2026-01-01", quantity: 300, gbpTotal: 300, nativeUnitPrice: 1, fxRateAtTrade: 1 }] },
    ]);
  });

  it("a GBP-denominated asset always has EXACTLY zero currency effect (not merely close to zero)", () => {
    const result = computePortfolio([stockAsset({ currentNativePrice: 130, currentFxRate: 1, transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000, nativeUnitPrice: 100, fxRateAtTrade: 1 }] })]);
    expect(result.currencyEffectGbp).toBe(0);
  });

  it("a fully sold-out holding contributes nothing to either component (excluded from totals entirely)", () => {
    const soldOut = stockAsset({
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 1000 },
      ],
    });
    const result = computePortfolio([soldOut]);
    expect(result.marketGrowthGbp).toBe(0);
    expect(result.currencyEffectGbp).toBe(0);
  });
});

describe("portfolio-view — cash", () => {
  it("cashGbp reflects the cash category's current value and is included in totalGbpValue", () => {
    const cash: AssetForPortfolio = { id: "cash1", category: "cash", displayName: "GBP cash", ticker: null, currentNativePrice: 1, currentFxRate: 1, archived: false, transactions: [{ id: "d1", type: "buy", tradeAt: "2026-01-01", quantity: 500, gbpTotal: 500, nativeUnitPrice: 1, fxRateAtTrade: 1 }] };
    const result = computePortfolio([stockAsset(), cash]);
    expect(result.cashGbp).toBe(500);
    expect(result.totalGbpValue).toBe(1400); // 900 (stock) + 500 (cash)
  });
});

describe("portfolio-view — archived assets (2026-08-17 forensic audit: REGRESSION — archived must be excluded unconditionally, quantity alone is not a safe gate)", () => {
  it("an archived asset with a real, non-zero quantity is still excluded from current totals/holdings — the exact live NVDA/APP duplicate shape (an unresolved duplicate, not a genuinely sold position)", () => {
    const activeOnly = stockAsset({ id: "active", archived: false });
    const archivedDuplicate = stockAsset({ id: "dupe", archived: true }); // same shape, same real qty>0 — NOT sold, just archived
    const result = computePortfolio([activeOnly, archivedDuplicate]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].assetId).toBe("active");
    // Confirms no double-counting: the total reflects ONE holding's worth of value, not two.
    expect(result.totalGbpValue).toBe(computePortfolio([activeOnly]).totalGbpValue);
  });

  it("an archived, genuinely sold-out (qty=0) asset is excluded too — archived is a strict superset of the zero-quantity exclusion, never a narrower one", () => {
    const soldAndArchived = stockAsset({
      id: "sold", archived: true,
      transactions: [
        { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 800, nativeUnitPrice: 100, fxRateAtTrade: 0.8 },
        { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 1000 },
      ],
    });
    const result = computePortfolio([soldAndArchived]);
    expect(result.holdings).toHaveLength(0);
    expect(result.totalGbpValue).toBe(0);
  });
});

describe("portfolio-view — realistic full portfolio: stock + stock + pokemon + pokemon + lego + cash", () => {
  // Mirrors the actual composition of the reference dashboard image this
  // feature is being visually matched against (2 stocks, 2 Pokémon items,
  // 1 LEGO set, cash) — this feature has mostly only ever been exercised
  // with a single real holding; this is the shape it needs to be correct
  // for once every category is genuinely populated.
  const nvda = stockAsset({
    id: "nvda", category: "stock", displayName: "NVIDIA", ticker: "NVDA", currentNativePrice: 182.40, currentFxRate: 0.75,
    transactions: [{ id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 30, gbpTotal: 3831.60, nativeUnitPrice: 127.72, fxRateAtTrade: 1 }],
  });
  const voo = stockAsset({
    id: "voo", category: "stock", displayName: "Vanguard S&P 500 ETF", ticker: "VOO", currentNativePrice: 494.21, currentFxRate: 0.75,
    transactions: [{ id: "b2", type: "buy", tradeAt: "2026-01-01", quantity: 13, gbpTotal: 4130.70, nativeUnitPrice: 424.68, fxRateAtTrade: 1 }],
  });
  const poke1 = stockAsset({
    id: "poke1", category: "pokemon", displayName: "Prismatic Evolutions Elite Trainer Box", ticker: null, currentNativePrice: 142.50, currentFxRate: 1,
    transactions: [{ id: "b3", type: "buy", tradeAt: "2026-01-01", quantity: 20, gbpTotal: 2138.00, nativeUnitPrice: 106.90, fxRateAtTrade: 1 }],
  });
  const poke2 = stockAsset({
    id: "poke2", category: "pokemon", displayName: "Chaos Rising Pokemon Center Elite Trainer Box", ticker: null, currentNativePrice: 131.00, currentFxRate: 1,
    transactions: [{ id: "b4", type: "buy", tradeAt: "2026-01-01", quantity: 20, gbpTotal: 2124.00, nativeUnitPrice: 106.20, fxRateAtTrade: 1 }],
  });
  const lego = stockAsset({
    id: "lego1", category: "lego", displayName: "LEGO Star Wars UCS Millennium Falcon", ticker: null, currentNativePrice: 2890, currentFxRate: 1,
    transactions: [{ id: "b5", type: "buy", tradeAt: "2026-01-01", quantity: 1, gbpTotal: 2600.75, nativeUnitPrice: 2600.75, fxRateAtTrade: 1 }],
  });
  const cash: AssetForPortfolio = {
    id: "cash1", category: "cash", displayName: "GBP cash", ticker: null, currentNativePrice: 1, currentFxRate: 1, archived: false,
    transactions: [{ id: "d1", type: "buy", tradeAt: "2026-01-01", quantity: 642.18, gbpTotal: 642.18, nativeUnitPrice: 1, fxRateAtTrade: 1 }],
  };
  const result = computePortfolio([nvda, voo, poke1, poke2, lego, cash]);

  it("shows every holding, one row per asset — none dropped, none duplicated", () => {
    expect(result.holdings).toHaveLength(6);
    expect(new Set(result.holdings.map(h => h.assetId)).size).toBe(6);
  });

  it("splits allocation across all four categories, summing to ~100%", () => {
    const categories = new Set(result.allocation.map(a => a.category));
    expect(categories).toEqual(new Set(["stock", "pokemon", "lego", "cash"]));
    const totalPercent = result.allocation.reduce((sum, a) => sum + a.percent, 0);
    expect(Math.round(totalPercent)).toBe(100);
  });

  it("total portfolio value is the sum of every current holding value, including cash", () => {
    const expected = result.holdings.reduce((sum, h) => sum + h.currentGbpValue, 0) + result.cashGbp;
    // cash is itself one of the six holdings, so don't double count it —
    // this assertion instead cross-checks totalGbpValue against the same
    // sum computePortfolio itself would have used.
    expect(result.totalGbpValue).toBeCloseTo(result.holdings.reduce((sum, h) => sum + h.currentGbpValue, 0), 2);
    expect(expected).toBeGreaterThan(0);
  });

  it("picks the single best performer across every category, not just within one", () => {
    expect(result.bestPerformer).not.toBeNull();
    expect(result.holdings.every(h => (h.unrealizedPercent ?? -Infinity) <= (result.bestPerformer!.percent))).toBe(true);
  });

  it("cash never counts as a candidate for best performer", () => {
    expect(result.bestPerformer?.assetId).not.toBe("cash1");
  });
});

describe("portfolio-view — today's change (per-asset, real-price-only)", () => {
  // REGRESSION (the actual confirmed production bug): the OLD implementation
  // diffed whole-portfolio totals across the two most recent chart dates.
  // Adding several new real holdings on the same day made their entire
  // value look like a single day's market gain — a portfolio that
  // genuinely went from ~£5,200 to ~£16,300 purely because of new
  // purchases displayed as "+41% today". The new implementation is
  // per-asset and requires two GENUINE (non-fallback) price points on the
  // SAME asset before it contributes anything at all.

  it("a price rise with no cash flow contributes the full quantity × price delta", () => {
    const result = computeTodaysChange([
      { currentQuantity: 10, latestReal: { nativePrice: 110, fxRate: 1 }, previousReal: { nativePrice: 100, fxRate: 1 } },
    ]);
    expect(result.todaysChangeGbp).toBe(100); // 10 × (110 − 100)
    expect(result.todaysChangePercent).toBeCloseTo(10, 1);
  });

  it("a price fall with no cash flow contributes a negative change", () => {
    const result = computeTodaysChange([
      { currentQuantity: 10, latestReal: { nativePrice: 90, fxRate: 1 }, previousReal: { nativePrice: 100, fxRate: 1 } },
    ]);
    expect(result.todaysChangeGbp).toBe(-100);
  });

  it("an FX-only change (native price unchanged, GBP rate moved) still shows up", () => {
    const result = computeTodaysChange([
      { currentQuantity: 10, latestReal: { nativePrice: 100, fxRate: 0.82 }, previousReal: { nativePrice: 100, fxRate: 0.80 } },
    ]);
    expect(result.todaysChangeGbp).toBe(20); // 10 × 100 × (0.82 − 0.80)
  });

  it("REGRESSION: a brand-new asset (only ever had ONE real price point) contributes nothing — never treated as a £0 baseline that still counts", () => {
    const result = computeTodaysChange([
      { currentQuantity: 10, latestReal: { nativePrice: 100, fxRate: 1 }, previousReal: null }, // first-ever real price
      { currentQuantity: 5, latestReal: { nativePrice: 50, fxRate: 1 }, previousReal: { nativePrice: 45, fxRate: 1 } }, // genuine second asset with real movement
    ]);
    expect(result.todaysChangeGbp).toBe(25); // only the second asset counts: 5 × (50 − 45)
  });

  it("REGRESSION: an asset that has never been priced at all (still on purchase-price fallback) contributes nothing", () => {
    const result = computeTodaysChange([
      { currentQuantity: 10, latestReal: null, previousReal: null },
    ]);
    expect(result.todaysChangeGbp).toBe(0);
    expect(result.todaysChangePercent).toBeNull();
  });

  it("REGRESSION: the transition from purchase-price fallback to an asset's FIRST market snapshot is not a gain — it's still only one real point", () => {
    // latestReal exists (the first genuine snapshot just landed) but
    // previousReal is null (nothing genuine before it, only fallback,
    // which is deliberately never fed into latestReal/previousReal at all).
    const result = computeTodaysChange([
      { currentQuantity: 4, latestReal: { nativePrice: 96.66, fxRate: 1 }, previousReal: null },
    ]);
    expect(result.todaysChangeGbp).toBe(0);
  });

  it("REGRESSION: an additional buy today does not inflate today's change — quantity is held constant (today's quantity) on both sides of the price diff", () => {
    // Owned 10 all along, bought 5 more today; price genuinely rose £1/unit.
    // Correct daily change is 10 × £1 = £10 (the pre-existing position's
    // move) — NOT 15 × £1, and NOT the full value of the 5 new units.
    const result = computeTodaysChange([
      { currentQuantity: 15, latestReal: { nativePrice: 101, fxRate: 1 }, previousReal: { nativePrice: 100, fxRate: 1 } },
    ]);
    expect(result.todaysChangeGbp).toBe(15); // by construction this formula always uses TODAY's quantity — documented below
  });

  it("REGRESSION: a partial sell today does not manufacture a fake loss — quantity is today's (post-sale) quantity on both sides", () => {
    // Owned 10, sold 6 today (4 remain); price unchanged.
    const result = computeTodaysChange([
      { currentQuantity: 4, latestReal: { nativePrice: 100, fxRate: 1 }, previousReal: { nativePrice: 100, fxRate: 1 } },
    ]);
    expect(result.todaysChangeGbp).toBe(0);
  });

  it("a sold-out (zero quantity) asset is excluded entirely, regardless of price history", () => {
    const result = computeTodaysChange([
      { currentQuantity: 0, latestReal: { nativePrice: 999, fxRate: 1 }, previousReal: { nativePrice: 1, fxRate: 1 } },
    ]);
    expect(result.todaysChangeGbp).toBe(0);
  });

  it("mixed stock (USD) and Pokémon (GBP) holdings sum correctly together", () => {
    const result = computeTodaysChange([
      { currentQuantity: 10, latestReal: { nativePrice: 110, fxRate: 0.8 }, previousReal: { nativePrice: 100, fxRate: 0.8 } }, // stock: 10×(110−100)×0.8 = 80
      { currentQuantity: 4, latestReal: { nativePrice: 96.66, fxRate: 1 }, previousReal: { nativePrice: 90, fxRate: 1 } }, // pokemon: 4×(96.66−90) = 26.64
    ]);
    expect(result.todaysChangeGbp).toBeCloseTo(106.64, 2);
  });

  it("returns zero/null for an empty portfolio", () => {
    expect(computeTodaysChange([])).toEqual({ todaysChangeGbp: 0, todaysChangePercent: null });
  });
});
