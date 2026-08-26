/**
 * Penny-exact cost allocation for splitting an order's complete charged
 * amount across multiple candidate purchase rows. Deliberately integer
 * pence throughout, never JS floating-point division/multiplication of
 * money values — repeated float arithmetic across many rows can lose or
 * invent a penny (e.g. 1000/3 as floats doesn't sum back to 1000 after
 * rounding each share to 2dp). Every function here guarantees the
 * allocated values sum back to exactly the input total.
 */

export function poundsToPence(amount: number): number {
  return Math.round(amount * 100);
}

export function penceToPounds(pence: number): number {
  return Math.round(pence) / 100;
}

/**
 * Splits `totalPence` evenly across `count` rows. When it doesn't divide
 * evenly, the leftover pennies go to the first rows, in order — e.g. 1000
 * pence across 3 rows -> [334, 333, 333]. The example from the brief
 * (£300 / 3 -> £100 each) and the uneven case (£10 / 3) both fall out of
 * this same rule; the sum of the result always equals `totalPence` exactly.
 */
export function allocateEqually(totalPence: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(totalPence / count);
  const remainder = totalPence - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Splits `totalPence` (the complete charged amount — item lines plus
 * shared delivery/fees, any discount already applied) proportionally to
 * each row's own `weightsPence` (typically its own line price before
 * shared costs are folded in), so a higher-value item absorbs a
 * proportionally larger share of shared delivery/fees. Falls back to an
 * even split when every weight is zero (nothing to proportion against).
 * Remainder pennies (lost to flooring each share) go to the first rows in
 * weight order, so the result always sums to exactly `totalPence`.
 *
 * CONTRACT (see expandOrderToRows below, and ParsedOrderItem.linePricePence
 * in lib/purchase-import/types.ts): each weight passed in here must already
 * be that item's TOTAL line price — quantity already folded in — never a
 * per-unit price, since this function weights between ITEMS, not units;
 * expandOrderToRows separately splits each item's own allocated share
 * evenly across its own units afterwards.
 */
export function allocateProportionally(totalPence: number, weightsPence: number[]): number[] {
  const count = weightsPence.length;
  if (count === 0) return [];
  const totalWeight = weightsPence.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return allocateEqually(totalPence, count);
  const shares = weightsPence.map(weight => Math.floor((totalPence * weight) / totalWeight));
  const allocated = shares.reduce((sum, share) => sum + share, 0);
  const remainder = totalPence - allocated;
  const result = [...shares];
  for (let index = 0; index < remainder; index += 1) result[index] += 1;
  return result;
}

export type OrderItemInput = { description: string; size: string | null; condition: string | null; quantity: number; linePricePence: number | null };
export type AllocatedRow = { description: string; size: string | null; condition: string | null; itemIndex: number; unitIndex: number; pricePence: number | null };
export type ExpandResult = { rows: AllocatedRow[]; allocationOk: boolean; reason: string | null };

/**
 * Expands an order's distinct line items into one row per physical unit
 * (quantity > 1 becomes that many rows) and allocates the complete charged
 * total across them:
 *
 * - A single line item with N units: the whole total is split evenly
 *   across the N units (the £300/3 -> £100 each example).
 * - Multiple distinct items, all with known individual line prices: each
 *   item's share of the total is proportional to its own line price
 *   (folding in shared delivery/fees/discounts), then split evenly across
 *   that item's own units.
 * - Multiple distinct items without reliable individual line prices: the
 *   total is split evenly across every physical unit as a last resort, and
 *   the result is flagged (`allocationOk: false`) for the reviewer to
 *   correct rather than silently trusting a guessed split.
 * - No known order total at all: every row's price is left `null` (never
 *   guessed) and the result is flagged for review.
 */
export function expandOrderToRows(items: OrderItemInput[], totalPaidPence: number | null): ExpandResult {
  if (!items.length) return { rows: [], allocationOk: true, reason: null };
  const unitsOf = (item: OrderItemInput) => Math.max(1, item.quantity);
  const unitCount = items.reduce((sum, item) => sum + unitsOf(item), 0);

  if (totalPaidPence === null) {
    const rows: AllocatedRow[] = [];
    items.forEach((item, itemIndex) => {
      for (let unitIndex = 0; unitIndex < unitsOf(item); unitIndex += 1) {
        rows.push({ description: item.description, size: item.size, condition: item.condition, itemIndex, unitIndex, pricePence: null });
      }
    });
    return { rows, allocationOk: false, reason: "The complete order total could not be determined, so prices could not be allocated automatically." };
  }

  if (items.length === 1) {
    const rows = allocateEqually(totalPaidPence, unitsOf(items[0])).map((pricePence, unitIndex): AllocatedRow => ({ description: items[0].description, size: items[0].size, condition: items[0].condition, itemIndex: 0, unitIndex, pricePence }));
    return { rows, allocationOk: true, reason: null };
  }

  const knownWeights = items.every(item => item.linePricePence !== null);
  if (knownWeights) {
    const itemShares = allocateProportionally(totalPaidPence, items.map(item => item.linePricePence!));
    const rows: AllocatedRow[] = [];
    items.forEach((item, itemIndex) => {
      allocateEqually(itemShares[itemIndex], unitsOf(item)).forEach((pricePence, unitIndex) => rows.push({ description: item.description, size: item.size, condition: item.condition, itemIndex, unitIndex, pricePence }));
    });
    return { rows, allocationOk: true, reason: null };
  }

  const perUnit = allocateEqually(totalPaidPence, unitCount);
  const rows: AllocatedRow[] = [];
  let cursor = 0;
  items.forEach((item, itemIndex) => {
    for (let unitIndex = 0; unitIndex < unitsOf(item); unitIndex += 1) {
      rows.push({ description: item.description, size: item.size, condition: item.condition, itemIndex, unitIndex, pricePence: perUnit[cursor] });
      cursor += 1;
    }
  });
  return { rows, allocationOk: false, reason: "Multiple items were found without individual prices, so the total was split evenly rather than by actual item value. Please check the allocation." };
}
