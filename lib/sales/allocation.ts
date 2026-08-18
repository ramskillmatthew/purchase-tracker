export type RevenueInputMode = "total" | "average";

/**
 * Normalises either revenue-entry method to one authoritative total, in
 * pence. "average" mode means the user entered a per-item average price —
 * the total is that average times how many purchase rows are being sold in
 * this order. "total" mode means the user entered the order's total
 * directly, unchanged.
 */
export function normalizeRevenueInputPence(mode: RevenueInputMode, valuePence: number, itemCount: number): number {
  return mode === "average" ? valuePence * itemCount : valuePence;
}

/**
 * Splits `totalPence` evenly across `count` positions, exact to the penny:
 * every position gets floor(total/count), and the remainder
 * (total - floor(total/count) * count) is handed out one penny at a time to
 * the FIRST `remainder` positions of the returned array — a fixed,
 * deterministic rule, never based on magnitude, randomness, or insertion
 * order into a Set/Map. The returned pence values always sum to exactly
 * `totalPence`; nothing is ever lost or invented to rounding.
 *
 * Callers control determinism entirely through the ORDER they pass their
 * items in — Stage 2 always sorts the selected purchases by UUID before
 * calling this (see supabase-sales.sql's create_completed_sale and
 * app/api/sales/route.ts), so the remainder recipient never depends on
 * client-submission order.
 *
 * This is also the "allocate proportionally by each line's revenue" rule
 * for platform fees/postage: in this stage every line always receives an
 * equal share of revenue (there is no per-line differing sale price yet),
 * so proportional-by-revenue and equal-split are the same computation. A
 * later stage that lets lines carry different revenue would need a true
 * weighted allocator instead of this one.
 */
export function splitEvenlyPence(totalPence: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.trunc(totalPence / count);
  const remainder = totalPence - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Splits `totalPence` across `weights` proportionally (largest-remainder
 * method): each position's exact share is `total * weight / sum(weights)`;
 * the integer floor of that is the base allocation, and the leftover pence
 * (total minus the sum of every base) is handed one at a time to the
 * positions with the LARGEST fractional remainder — ties broken by
 * ascending index, never insertion order or magnitude of the weight itself.
 * The returned pence values always sum to exactly `totalPence`.
 *
 * Falls back to an equal split (splitEvenlyPence) when every weight is zero
 * (or the array is empty) — proportional-by-nothing is undefined, and an
 * equal split is the deterministic, safe default; callers needing a
 * cost-proportion fallback instead (Stage 4's "zero-revenue order" rule —
 * see allocateFeesOrPostagePence below) pass cost weights in that case
 * rather than relying on this function's own equal-split fallback.
 *
 * This exact algorithm is mirrored in supabase-sales-v2.sql's
 * allocate_proportional_pence() SQL function, which the atomic
 * create_completed_sale RPC actually uses for the authoritative write in
 * itemised-mode orders — this TypeScript version exists for live UI
 * previews and is directly unit-tested; keep the two in sync (see
 * tests/sales-itemised-allocation-sync.test.ts).
 */
export function allocateProportionalPence(totalPence: number, weights: number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
  if (sumWeights <= 0) return splitEvenlyPence(totalPence, count);

  const bases = weights.map(weight => Math.floor((totalPence * weight) / sumWeights));
  const baseSum = bases.reduce((sum, base) => sum + base, 0);
  const remainder = totalPence - baseSum;

  // Largest fractional part first; exact ties broken by ascending index —
  // never Set/Map insertion order, never the weight's own magnitude.
  const order = weights
    .map((weight, index) => ({ index, frac: (totalPence * weight) / sumWeights - bases[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  const shares = [...bases];
  for (let i = 0; i < remainder; i++) shares[order[i].index] += 1;
  return shares;
}

/**
 * The Stage 4 "allocate order-level fees/postage across mixed-revenue
 * basket lines" rule: proportional to each line's own allocated revenue,
 * falling back to proportional-by-purchase-cost when every line's revenue
 * is zero (a legitimately free/giveaway order), and finally to an equal
 * split (inside allocateProportionalPence itself) if costs are ALSO all
 * zero. Never fails, never divides by zero.
 */
export function allocateFeesOrPostagePence(totalPence: number, lineRevenuesPence: number[], lineCostsPence: number[]): number[] {
  const sumRevenue = lineRevenuesPence.reduce((sum, revenue) => sum + revenue, 0);
  const weights = sumRevenue > 0 ? lineRevenuesPence : lineCostsPence;
  return allocateProportionalPence(totalPence, weights);
}

export type BasketUnit = { purchaseId: string; costPence: number };

export type UnitAllocation = {
  purchaseId: string;
  costPence: number;
  revenuePence: number;
  feePence: number;
  postagePence: number;
  profitPence: number;
};

/**
 * Computes the EXACT per-unit revenue/fee/postage/profit for a whole
 * basket, using the identical deterministic rules the atomic RPC uses
 * (supabase-sales-v2.sql's create_completed_sale) — so a live preview and
 * the saved sale agree to the penny. Never derives a per-unit figure by
 * dividing the order total by the unit count: two visually-identical units
 * can carry different purchase costs, and penny remainders can land on
 * different units depending on revenue mode, so each unit's own share is
 * computed individually and its own cost is subtracted individually.
 *
 * - total/average: revenue is split evenly across every unit — the RPC's
 *   original, unchanged equal-split rule — and so are fees/postage.
 * - itemised: revenue is exactly the per-unit amount already resolved in
 *   `itemisedRevenuePence` (e.g. via buildItemisedLineRevenuesPence's
 *   per-group split — see lib/sales/basket.ts); fees/postage are then
 *   allocated proportionally to each unit's own revenue share (falling
 *   back to cost-proportion when every unit's revenue is zero, then to an
 *   equal split) — see allocateFeesOrPostagePence.
 *
 * Every case sorts units by purchase UUID first, exactly matching the
 * RPC's own v_sorted_ids ordering, so remainder pennies land on the same
 * units the database will actually pick.
 */
export function computeBasketAllocation(
  units: BasketUnit[],
  mode: "total" | "average" | "itemised",
  totalRevenuePence: number,
  feesPence: number,
  postagePence: number,
  itemisedRevenuePence?: Record<string, number>,
): UnitAllocation[] {
  if (units.length === 0) return [];
  const sorted = [...units].sort((a, b) => a.purchaseId.localeCompare(b.purchaseId));
  const costs = sorted.map(unit => unit.costPence);

  const revenueShares = mode === "itemised"
    ? sorted.map(unit => itemisedRevenuePence?.[unit.purchaseId] ?? 0)
    : splitEvenlyPence(totalRevenuePence, sorted.length);

  const feeShares = mode === "itemised" ? allocateFeesOrPostagePence(feesPence, revenueShares, costs) : splitEvenlyPence(feesPence, sorted.length);
  const postageShares = mode === "itemised" ? allocateFeesOrPostagePence(postagePence, revenueShares, costs) : splitEvenlyPence(postagePence, sorted.length);

  return sorted.map((unit, index) => {
    const revenuePence = revenueShares[index];
    const feePence = feeShares[index];
    const unitPostagePence = postageShares[index];
    return {
      purchaseId: unit.purchaseId,
      costPence: unit.costPence,
      revenuePence,
      feePence,
      postagePence: unitPostagePence,
      profitPence: revenuePence - unit.costPence - feePence - unitPostagePence,
    };
  });
}
