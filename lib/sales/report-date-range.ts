import { parseUkDate } from "@/lib/validation/uk-date";

/**
 * Date-range resolution for the Sales Reporting dashboard — the single
 * source of truth for every preset/custom-range calculation the reports
 * page and its API route both need, so the two can never compute two
 * slightly different answers for "what does 'Last Month' mean right now."
 *
 * Every "what is today" calculation goes through Europe/London explicitly
 * (via Intl.DateTimeFormat, never a bare `new Date().getDate()`-style local
 * read) — a server process's host timezone is not guaranteed to be UK time
 * (production Node servers commonly run in UTC), so reading local calendar
 * fields directly would silently shift "today" to the wrong day for part of
 * every day the UK is on BST (British Summer Time, UTC+1). Once a plain
 * YYYY-MM-DD string exists, all further arithmetic (month/year boundaries)
 * is done via `Date.UTC` — a well-known safe trick for pure calendar
 * arithmetic that never depends on host-local time either.
 */

export type DateRangePreset = "today" | "this-month" | "last-month" | "last-3-months" | "this-year" | "last-year" | "all-time" | "custom";

export const dateRangePresets: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "this-month", label: "This Month" },
  { value: "last-month", label: "Last Month" },
  { value: "last-3-months", label: "Last 3 Months" },
  { value: "this-year", label: "This Year" },
  { value: "last-year", label: "Last Year" },
  { value: "all-time", label: "All Time" },
  { value: "custom", label: "Custom Range" },
];

export function parseDateRangePreset(value: string | null | undefined): DateRangePreset {
  return dateRangePresets.some(option => option.value === value) ? (value as DateRangePreset) : "this-month";
}

/** Inclusive date range as canonical YYYY-MM-DD strings. `start`/`end` are both null only for "All Time" (no restriction at all). */
export type ResolvedDateRange = { start: string | null; end: string | null };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The number of days in a given (1-indexed) month/year — leap-year-correct, via the day-0-of-next-month UTC trick (no host-timezone dependency). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Today's calendar date in Europe/London, as YYYY-MM-DD — correct
 * regardless of the server process's own host timezone. Accepts an
 * optional reference instant (for deterministic testing); defaults to the
 * real current instant.
 */
export function londonToday(referenceDate: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function ymdParts(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** Adds (or subtracts, for a negative count) whole calendar months to a YYYY-MM-DD string, clamping the day if the target month is shorter (e.g. 31 Jan - 1 month lands on the last day of Feb, never rolling into March). Only ever used here on the 1st of a month, where clamping never actually applies — kept general and correct regardless. */
function addMonths(iso: string, count: number): { year: number; month: number } {
  const { year, month } = ymdParts(iso);
  const zeroBased = month - 1 + count;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: targetYear, month: targetMonth };
}

/**
 * Resolves a preset to a concrete inclusive date range, relative to
 * `referenceDate` (Europe/London "today"). Never called for "custom" —
 * see resolveCustomRange for that.
 */
export function resolvePresetRange(preset: Exclude<DateRangePreset, "custom">, referenceDate: Date = new Date()): ResolvedDateRange {
  const today = londonToday(referenceDate);
  const { year, month } = ymdParts(today);

  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "this-month":
      return { start: ymd(year, month, 1), end: today };
    case "last-month": {
      const target = addMonths(today, -1);
      return { start: ymd(target.year, target.month, 1), end: ymd(target.year, target.month, daysInMonth(target.year, target.month)) };
    }
    case "last-3-months": {
      // "the first day of the month two months before the current month
      // through today" — e.g. if today is in August, the range starts on
      // 1 June (August, minus 2 months), covering June/July/August.
      const target = addMonths(today, -2);
      return { start: ymd(target.year, target.month, 1), end: today };
    }
    case "this-year":
      return { start: ymd(year, 1, 1), end: today };
    case "last-year":
      return { start: ymd(year - 1, 1, 1), end: ymd(year - 1, 12, 31) };
    case "all-time":
      return { start: null, end: null };
  }
}

export type CustomRangeResult = { ok: true; range: ResolvedDateRange } | { ok: false; error: string };

/** Validates and resolves a custom date range: both dates must be real calendar dates, and start must not be after end. Accepts either ISO (YYYY-MM-DD, what an HTML date input sends) or UK D/M/YYYY text, reusing the same strict, leap-year-correct parser as Bulk Input. */
export function resolveCustomRange(rawStart: string | null | undefined, rawEnd: string | null | undefined): CustomRangeResult {
  if (!rawStart?.trim() || !rawEnd?.trim()) return { ok: false, error: "Enter both a start and an end date." };
  const start = parseUkDate(rawStart);
  if (!start.ok) return { ok: false, error: `Start date: ${start.error}` };
  const end = parseUkDate(rawEnd);
  if (!end.ok) return { ok: false, error: `End date: ${end.error}` };
  if (start.iso > end.iso) return { ok: false, error: "Start date cannot be after end date." };
  return { ok: true, range: { start: start.iso, end: end.iso } };
}

export type DateFilterInput = { preset: DateRangePreset; customStart?: string | null; customEnd?: string | null };
export type DateFilterResult = { ok: true; range: ResolvedDateRange } | { ok: false; error: string };

/** The single entry point both the API route and the reports page use to turn "which filter is selected" into a concrete range. */
export function resolveDateFilter(filter: DateFilterInput, referenceDate: Date = new Date()): DateFilterResult {
  if (filter.preset === "custom") {
    const result = resolveCustomRange(filter.customStart, filter.customEnd);
    return result.ok ? { ok: true, range: result.range } : result;
  }
  return { ok: true, range: resolvePresetRange(filter.preset, referenceDate) };
}

/** A short, human-readable description of the resolved range, for the "active filter" display — e.g. "1 Aug 2026 – 18 Aug 2026", or "All time" when unbounded. */
export function describeDateRange(range: ResolvedDateRange): string {
  if (range.start === null || range.end === null) return "All time";
  if (range.start === range.end) return formatReportDate(range.start);
  return `${formatReportDate(range.start)} – ${formatReportDate(range.end)}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** British "18 Aug 2026" format — unambiguous (unlike MM/DD vs DD/MM) and compact enough for chart axis labels and range summaries alike. */
export function formatReportDate(iso: string): string {
  const { year, month, day } = ymdParts(iso);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** "Aug 2026" — the monthly chart's own axis label. */
export function formatReportMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Every calendar day from `start` to `end` inclusive, as YYYY-MM-DD strings — the daily chart's zero-fill backbone. */
export function enumerateDays(start: string, end: string): string[] {
  const { year: sy, month: sm, day: sd } = ymdParts(start);
  const { year: ey, month: em, day: ed } = ymdParts(end);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  const days: string[] = [];
  for (let t = startUtc; t <= endUtc; t += 86_400_000) {
    const d = new Date(t);
    days.push(ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }
  return days;
}

/** Every calendar month (as YYYY-MM) spanned by `start` to `end` inclusive — the monthly chart's zero-fill backbone. */
export function enumerateMonths(start: string, end: string): string[] {
  const { year: sy, month: sm } = ymdParts(start);
  const { year: ey, month: em } = ymdParts(end);
  const months: string[] = [];
  let year = sy;
  let month = sm;
  while (year < ey || (year === ey && month <= em)) {
    months.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

/** Inclusive day-count of a resolved range — used to decide whether daily grouping is "sensible" (see lib/sales/reporting.ts). Undefined for an unbounded ("All Time") range — callers must resolve a concrete range first (e.g. from the earliest sale date) before asking this. */
export function daySpan(start: string, end: string): number {
  const { year: sy, month: sm, day: sd } = ymdParts(start);
  const { year: ey, month: em, day: ed } = ymdParts(end);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  return Math.round((endUtc - startUtc) / 86_400_000) + 1;
}
