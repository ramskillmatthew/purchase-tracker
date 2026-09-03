/**
 * Returns, Losses & Write-offs — month-only vs exact date handling.
 *
 * A recognition/event date is either:
 *   { precision: "exact", date: "2026-09-03" }   — a real calendar day
 *   { precision: "month", month: "2026-09" }      — only the month is known
 *
 * For a month-only value the app deliberately does NOT invent a day. The
 * paired `date` column in the database stores the FIRST of the month purely
 * as a sortable anchor (`anchorDate`), and the UI shows "September 2026"
 * (`formatPrecisionDate`), never "01/09/2026".
 *
 * `canonicalMonth` is the YYYY-MM key every period filter and the Home
 * dashboard net-profit adjustment use — it is stored explicitly on the row
 * (return_records.recognition_month / loss_records.event_month) so filtering
 * never has to re-derive it.
 *
 * All comparisons are plain string comparisons on ISO YYYY-MM-DD / YYYY-MM,
 * which sort lexicographically the same as chronologically — no Date objects,
 * no timezone conversion (matching lib/home-report.ts's own convention).
 */

export type DatePrecision = "exact" | "month";

export type PrecisionDate =
  | { precision: "exact"; date: string }
  | { precision: "month"; month: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}
export function isIsoMonth(value: string): boolean {
  return ISO_MONTH.test(value);
}

/** The YYYY-MM the value belongs to — the canonical period-filter key. */
export function canonicalMonth(value: PrecisionDate): string {
  return value.precision === "month" ? value.month : value.date.slice(0, 7);
}

/** The YYYY-MM-DD to store in the paired date column. For month-only that is
 * the 1st of the month — a sortable anchor, never displayed as a day. */
export function anchorDate(value: PrecisionDate): string {
  return value.precision === "month" ? `${value.month}-01` : value.date;
}

/** Build a PrecisionDate from a stored (date, precision) pair. */
export function readPrecisionDate(date: string | null | undefined, precision: string | null | undefined): PrecisionDate | null {
  if (!date) return null;
  if (precision === "month") return { precision: "month", month: date.slice(0, 7) };
  return { precision: "exact", date: date.slice(0, 10) };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** British display: "3 September 2026" for exact, "September 2026" for month-only. */
export function formatPrecisionDate(value: PrecisionDate): string {
  if (value.precision === "month") {
    const [year, month] = value.month.split("-").map(Number);
    return `${MONTHS[month - 1]} ${year}`;
  }
  const [year, month, day] = value.date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * Whether a record with this recognition/event date falls inside a resolved
 * reporting range (inclusive YYYY-MM-DD start/end; null = unbounded on that
 * side, i.e. "All Time").
 *
 * - exact:  start <= date <= end (plain string comparison)
 * - month:  the record's month must overlap the range at all — i.e. the
 *           range's own month span must include it. A month-only record is
 *           NEVER placed on a fabricated day to force it in or out; if any
 *           part of its month is inside the range it counts for that month.
 */
export function precisionDateInRange(value: PrecisionDate, start: string | null, end: string | null): boolean {
  if (value.precision === "exact") {
    if (start && value.date < start) return false;
    if (end && value.date > end) return false;
    return true;
  }
  const month = value.month;
  if (start && month < start.slice(0, 7)) return false;
  if (end && month > end.slice(0, 7)) return false;
  return true;
}
