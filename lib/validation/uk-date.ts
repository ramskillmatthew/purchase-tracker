/**
 * Strict UK (day-first) date parsing shared by the Bulk Input page and its
 * API route. Pure and side-effect free: never constructs a `Date` object,
 * so a stored value can never shift through timezone/UTC conversion.
 *
 * Accepted input:
 *   - `D/M/YY`, `D/M/YYYY` (1 or 2 digit day/month, day-first, never US month-first)
 *   - `YYYY-MM-DD` (already-canonical ISO, validated the same way)
 *
 * Two-digit years expand deterministically to `20YY` (00-99 -> 2000-2099),
 * never via a shifting pivot around the current date.
 */

export type UkDateResult = { ok: true; iso: string } | { ok: false; error: string };

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UK_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function expandTwoDigitYear(twoDigit: number): number {
  return 2000 + twoDigit;
}

/** Parses a UK day-first date (with optional two-digit year) or an ISO `YYYY-MM-DD` string into a canonical `YYYY-MM-DD` value. */
export function parseUkDate(raw: string): UkDateResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter a date." };

  const isoMatch = value.match(ISO_PATTERN);
  if (isoMatch) {
    const [, yearText, monthText, dayText] = isoMatch;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (!isValidCalendarDate(year, month, day)) return { ok: false, error: `"${raw}" is not a valid calendar date.` };
    return { ok: true, iso: `${yearText}-${monthText}-${dayText}` };
  }

  const ukMatch = value.match(UK_PATTERN);
  if (!ukMatch) return { ok: false, error: `"${raw}" is not a recognised date format.` };
  const [, dayText, monthText, yearText] = ukMatch;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = yearText.length === 2 ? expandTwoDigitYear(Number(yearText)) : Number(yearText);
  if (!isValidCalendarDate(year, month, day)) return { ok: false, error: `"${raw}" is not a valid calendar date.` };
  return { ok: true, iso: `${year}-${pad2(month)}-${pad2(day)}` };
}

/** Formats a canonical `YYYY-MM-DD` value as `DD/MM/YYYY`. Returns the input unchanged if it isn't a valid ISO date. */
export function formatUkDate(iso: string): string {
  const match = iso.match(ISO_PATTERN);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}
