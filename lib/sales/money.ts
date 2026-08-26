/**
 * Every sales money calculation (allocation, profit, margin) happens in
 * integer PENCE, never native JS floating point — see lib/sales/allocation.ts
 * and lib/sales/profit.ts. These two functions are the only place a pounds
 * value ever crosses that boundary, so a stray float-math bug can't hide
 * anywhere else in the sales domain.
 */

export function poundsToPence(pounds: number): number {
  return Math.round(pounds * 100);
}

/** Rounded via toFixed (string-based) rather than a raw division, so an integer pence value can never come back as e.g. 12.339999999999999. */
export function penceToPounds(pence: number): number {
  return Number((pence / 100).toFixed(2));
}

/** `null`/non-finite formats as "—" (never a fabricated £0.00 or blank cell). */
export function formatPenceAsGBP(pence: number | null | undefined): string {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return "—";
  return `£${(pence / 100).toFixed(2)}`;
}

/** For a margin percentage (see lib/sales/profit.ts's calculateMarginPercent) — null formats as "—", never a fabricated 0%. */
export function formatMarginPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(2)}%`;
}
