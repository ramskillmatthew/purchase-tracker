/** profit = allocated revenue - purchase cost - allocated platform fee - allocated postage. Every argument and the result are integer pence. Can be negative (a loss). */
export function calculateLineProfitPence(allocatedRevenuePence: number, costPence: number, allocatedFeePence: number, allocatedPostagePence: number): number {
  return allocatedRevenuePence - costPence - allocatedFeePence - allocatedPostagePence;
}

export function calculateTotalProfitPence(lineProfitsPence: number[]): number {
  return lineProfitsPence.reduce((total, profit) => total + profit, 0);
}

/**
 * Percentage margin (profit / revenue * 100), rounded to 2dp.
 *
 * DOCUMENTED SAFE VALUE: returns `null` — never `NaN`/`Infinity` — when
 * revenuePence is 0, since margin-as-a-percentage-of-nothing isn't a
 * meaningful number. Callers must treat `null` as "not applicable" (e.g.
 * display "—"), never coerce it to 0.
 */
export function calculateMarginPercent(profitPence: number, revenuePence: number): number | null {
  if (revenuePence === 0) return null;
  return Number(((profitPence / revenuePence) * 100).toFixed(2));
}

export type ProfitTone = "red" | "amber" | "green";

/**
 * Sales-history profit-pill colour tier — exact integer-pence thresholds:
 * under £10.00 (1000p) is red, £10.00 up to (not including) £20.00 is
 * amber, £20.00 (2000p) and above is green. Any negative profit falls out
 * of the first branch naturally (it's below 1000p) but is called out here
 * because a loss must never read as anything but red.
 */
export function profitBadgeTone(profitPence: number): ProfitTone {
  if (profitPence < 1000) return "red";
  if (profitPence < 2000) return "amber";
  return "green";
}

export type DashboardProfitTone = "red" | "green";

/**
 * The Sales Reporting dashboard's own profit colour rule — deliberately
 * NOT profitBadgeTone. profitBadgeTone's £10/£20 bands answer "was this ONE
 * sale worth it?", which only makes sense at single-sale scale (its amber
 * band, £10.00–£19.99, is a narrow slice a genuine per-sale profit can
 * meaningfully land in). A dashboard total (a month's revenue, a whole
 * period's profit) is routinely in the tens or hundreds of pounds — every
 * such figure would trivially clear the £20 "green" band, making the
 * colour carry no real signal and visually equating a modest month with an
 * exceptional one. Aggregate figures — total profit, average profit per
 * unit is the one exception (see below), chart bars, and every
 * category/condition/platform breakdown row — use this simpler, scale-
 * independent rule instead: red for any loss, green for break-even or
 * better. "Average profit per unit" is the one aggregate figure still
 * shown with profitBadgeTone, not this function, because it's already
 * expressed at single-unit scale (the same scale profitBadgeTone was
 * designed for), not a period total.
 */
export function dashboardProfitTone(profitPence: number): DashboardProfitTone {
  return profitPence < 0 ? "red" : "green";
}
