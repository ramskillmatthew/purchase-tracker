import Decimal from "decimal.js";

/**
 * The ONE decimal configuration for this whole feature. 40 significant
 * digits is far beyond anything a real quantity/price/rate here needs, but
 * costs nothing and removes any risk of intermediate precision loss across
 * a chain of multiplications/divisions (e.g. weighted-average cost
 * recomputed across many buys/sells). ROUND_HALF_UP matches ordinary
 * "round half away from zero" money-rounding expectations — never a
 * banker's-rounding surprise on a displayed GBP total.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

/** Shorthand constructor — the only way a raw number/string/Decimal should ever enter this feature's calculations. */
export function d(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

/** Rounds to exactly 2dp (GBP) using this feature's one rounding rule — never call `.toFixed()`/`.toNumber()` directly on an un-rounded Decimal for display. */
export function roundGbp(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** The final JS number handed to JSON/UI — only ever produced from an already-rounded value, so a response body never carries more precision than it displays. */
export function toGbpNumber(value: Decimal): number {
  return roundGbp(value).toNumber();
}

/** Quantity display precision — up to 8dp (fractional shares), trimmed of trailing zeros. */
export function formatQuantity(value: Decimal): string {
  return value.toDecimalPlaces(8).toString();
}
