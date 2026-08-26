import { Decimal, roundGbp } from "./decimal";

/**
 * British money/date formatting for this feature — extends the existing
 * `formatMoney` convention in lib/orders/render.ts (same
 * `toLocaleString("en-GB", {minimumFractionDigits:2, maximumFractionDigits:2})`
 * shape) to accept a Decimal directly, since every investments calculation
 * produces one rather than a raw number.
 */

export function formatGbp(value: Decimal | number, options?: { signed?: boolean }): string {
  const rounded = typeof value === "number" ? Math.round(value * 100) / 100 : roundGbp(value).toNumber();
  const abs = Math.abs(rounded);
  const formatted = abs.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = rounded < 0 ? "-" : options?.signed && rounded > 0 ? "+" : "";
  return `${sign}£${formatted}`;
}

/** Compact axis-tick form for the portfolio chart's Y axis — "0", "250", "12.5K" — no currency symbol (matches the reference chart's plain right-axis labels; the card already establishes GBP via the headline value) and never the full-precision pence form, which is too wide for a repeated tick. */
export function formatGbpCompact(value: number): string {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? "-" : "";
  if (abs >= 1000) {
    const thousands = abs / 1000;
    const formatted = Number.isInteger(thousands) ? thousands.toString() : thousands.toFixed(1);
    return `${sign}${formatted}K`;
  }
  return `${sign}${abs.toLocaleString("en-GB")}`;
}

/**
 * REGRESSION: a tight-range axis (e.g. a 1D chart spanning only a few
 * hundred pounds) can produce adjacent ticks whose "K" form is
 * indistinguishable — confirmed live: ticks 16,450/16,500/16,550/16,600
 * rendered as "16.5K"/"16.5K"/"16.6K"/"16.6K" (1 decimal place of "K" only
 * resolves £100 increments; a real £50 step falls inside that, and
 * floating-point toFixed rounding can even collapse two DIFFERENT £50-apart
 * values to the same string). Below a £100 tick spacing, whole pounds are
 * shown instead of switching to "K" at all — every tick stays genuinely
 * distinct, and a sub-£100 range never benefited from "K" compaction
 * anyway (there's nothing left to compact).
 */
export function formatGbpCompactTick(value: number, tickStepGbp: number): string {
  if (Math.abs(tickStepGbp) < 100) {
    const rounded = Math.round(value);
    return `${rounded < 0 ? "-" : ""}${Math.abs(rounded).toLocaleString("en-GB")}`;
  }
  return formatGbpCompact(value);
}

export function formatUsd(value: Decimal | number): string {
  const rounded = typeof value === "number" ? value : roundGbp(value).toNumber();
  return `$${Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: Decimal | number, options?: { signed?: boolean }): string {
  const num = typeof value === "number" ? value : value.toNumber();
  const rounded = Math.round(num * 10) / 10;
  const sign = rounded < 0 ? "-" : options?.signed !== false && rounded > 0 ? "+" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}

export function formatQuantityDisplay(value: Decimal | number | string): string {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  return decimal.toDecimalPlaces(4).toString();
}

/** e.g. "12 Aug 2026" — the same day/month/year shape TaskRow.tsx already uses for short dates, extended with a year since this feature's dates span years. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** e.g. "Fri 14 Aug" — deliberately built from fixed arrays rather than toLocaleDateString: en-GB's weekday+day+month form inserts a comma ("Fri, 14 Aug") that doesn't match this feature's own "Latest market close · Fri 14 Aug" wording. UTC components — priceAt is an instant, but the calendar DATE a market closed on must never shift with the viewer's own timezone. */
export function formatShortMarketDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${WEEKDAY_SHORT[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
}

export function formatRelativeSync(iso: string | null): string {
  if (!iso) return "Never synced";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "Just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
