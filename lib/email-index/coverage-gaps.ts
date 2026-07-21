export type CompletedRange = { range_start: string; range_end: string };

function nextDay(date: string) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }

/**
 * Given completed coverage ranges (any order, possibly overlapping), returns
 * the first day within [requestStart, requestEnd] not covered by any of
 * them, or null if the whole span is already covered.
 */
export function firstUncoveredDate(ranges: CompletedRange[], requestStart: string, requestEnd: string): string | null {
  const relevant = ranges
    .filter(row => row.range_end >= requestStart && row.range_start <= requestEnd)
    .sort((a, b) => (a.range_start < b.range_start ? -1 : a.range_start > b.range_start ? 1 : 0));
  let coveredThrough: string | null = null;
  for (const row of relevant) {
    if (!coveredThrough) {
      if (row.range_start > requestStart) return requestStart;
      coveredThrough = row.range_end;
    } else {
      const allowedStart = nextDay(coveredThrough);
      if (row.range_start > allowedStart) return allowedStart;
      if (row.range_end > coveredThrough) coveredThrough = row.range_end;
    }
    if (coveredThrough >= requestEnd) return null;
  }
  return coveredThrough ? nextDay(coveredThrough) : requestStart;
}

export function hasFullCoverage(ranges: CompletedRange[], requestStart: string, requestEnd: string): boolean {
  return firstUncoveredDate(ranges, requestStart, requestEnd) === null;
}
