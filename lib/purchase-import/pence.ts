/**
 * Whether `value` (pounds) is an exact whole-penny amount — no more than
 * two decimal places, e.g. 33.33 but not 33.333. Rejects fractional-penny
 * prices before they ever reach a total comparison or an insert: summing
 * several fractional-penny values and only rounding the COMBINED total
 * afterwards can silently disagree with rounding each row individually,
 * so every individual row must already be whole-penny on its own.
 *
 * The 1e-6 tolerance absorbs ordinary IEEE-754 representation noise for a
 * legitimate 2-decimal value (e.g. 33.33 * 100 landing a few
 * ten-trillionths off 3333) without accepting a genuinely-present third
 * decimal digit, which differs by at least 0.1 in pence-scale terms — far
 * larger than any float noise this comparison could produce.
 */
export function isWholePennyAmount(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const pence = Math.round(value * 100);
  return Math.abs(value * 100 - pence) < 1e-6;
}
