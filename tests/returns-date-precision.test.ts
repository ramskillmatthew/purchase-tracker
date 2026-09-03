import { describe, expect, it } from "vitest";
import {
  canonicalMonth, anchorDate, formatPrecisionDate, precisionDateInRange, readPrecisionDate,
} from "@/lib/returns/date-precision";

describe("date precision — month-only never fabricates a day", () => {
  it("14. a month-only value keeps precision 'month' and displays as month + year only", () => {
    const pd = { precision: "month" as const, month: "2026-09" };
    expect(formatPrecisionDate(pd)).toBe("September 2026");
    expect(canonicalMonth(pd)).toBe("2026-09");
    expect(anchorDate(pd)).toBe("2026-09-01"); // stored anchor, never shown as a day
  });

  it("an exact value displays as a British day-month-year", () => {
    const pd = { precision: "exact" as const, date: "2026-09-03" };
    expect(formatPrecisionDate(pd)).toBe("3 September 2026");
    expect(canonicalMonth(pd)).toBe("2026-09");
    expect(anchorDate(pd)).toBe("2026-09-03");
  });

  it("readPrecisionDate reconstructs the right shape from stored (date, precision)", () => {
    expect(readPrecisionDate("2026-09-01", "month")).toEqual({ precision: "month", month: "2026-09" });
    expect(readPrecisionDate("2026-09-03", "exact")).toEqual({ precision: "exact", date: "2026-09-03" });
    expect(readPrecisionDate(null, "exact")).toBeNull();
  });
});

describe("precisionDateInRange", () => {
  const september = { start: "2026-09-01", end: "2026-09-30" };
  const august = { start: "2026-08-01", end: "2026-08-31" };

  it("13. exact dates filter by day, inclusive of both boundaries", () => {
    expect(precisionDateInRange({ precision: "exact", date: "2026-09-01" }, september.start, september.end)).toBe(true);
    expect(precisionDateInRange({ precision: "exact", date: "2026-09-30" }, september.start, september.end)).toBe(true);
    expect(precisionDateInRange({ precision: "exact", date: "2026-08-31" }, september.start, september.end)).toBe(false);
    expect(precisionDateInRange({ precision: "exact", date: "2026-10-01" }, september.start, september.end)).toBe(false);
  });

  it("14. month-only filters by month overlap — no fabricated day is used to force it in or out", () => {
    expect(precisionDateInRange({ precision: "month", month: "2026-09" }, september.start, september.end)).toBe(true);
    expect(precisionDateInRange({ precision: "month", month: "2026-09" }, august.start, august.end)).toBe(false);
    // a Sep month-only record is NOT in an August range even though 2026-09-01
    // (its anchor) is only one day after 2026-08-31.
    expect(precisionDateInRange({ precision: "month", month: "2026-08" }, august.start, august.end)).toBe(true);
  });

  it("All Time (null/null) includes everything", () => {
    expect(precisionDateInRange({ precision: "exact", date: "2019-01-01" }, null, null)).toBe(true);
    expect(precisionDateInRange({ precision: "month", month: "2031-12" }, null, null)).toBe(true);
  });

  it("year and custom ranges span multiple months for month-only records", () => {
    const thisYear = { start: "2026-01-01", end: "2026-12-31" };
    expect(precisionDateInRange({ precision: "month", month: "2026-03" }, thisYear.start, thisYear.end)).toBe(true);
    expect(precisionDateInRange({ precision: "month", month: "2025-12" }, thisYear.start, thisYear.end)).toBe(false);
    const custom = { start: "2026-07-15", end: "2026-09-10" }; // inclusive custom range
    expect(precisionDateInRange({ precision: "month", month: "2026-08" }, custom.start, custom.end)).toBe(true);
    expect(precisionDateInRange({ precision: "month", month: "2026-07" }, custom.start, custom.end)).toBe(true); // July overlaps
    expect(precisionDateInRange({ precision: "month", month: "2026-10" }, custom.start, custom.end)).toBe(false);
  });
});
