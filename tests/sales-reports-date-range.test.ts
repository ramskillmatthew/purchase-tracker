import { describe, expect, it } from "vitest";
import {
  daySpan,
  daysInMonth,
  describeDateRange,
  enumerateDays,
  enumerateMonths,
  formatReportDate,
  formatReportMonth,
  londonToday,
  parseDateRangePreset,
  resolveCustomRange,
  resolveDateFilter,
  resolvePresetRange,
} from "@/lib/sales/report-date-range";

function utc(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe("parseDateRangePreset", () => {
  it("accepts every canonical preset value", () => {
    for (const value of ["today", "this-month", "last-month", "last-3-months", "this-year", "last-year", "all-time", "custom"]) {
      expect(parseDateRangePreset(value)).toBe(value);
    }
  });

  it("REQUIREMENT: falls back to a sensible default ('this-month') for missing/unrecognized values, never throwing on a malformed URL", () => {
    expect(parseDateRangePreset(null)).toBe("this-month");
    expect(parseDateRangePreset(undefined)).toBe("this-month");
    expect(parseDateRangePreset("bogus")).toBe("this-month");
    expect(parseDateRangePreset("")).toBe("this-month");
  });
});

describe("londonToday — Europe/London correctness independent of host timezone", () => {
  it("reads the UK calendar date directly from Intl, not host-local Date methods", () => {
    // 2026-08-18 23:30 UTC is already 2026-08-19 00:30 in London during BST (UTC+1).
    expect(londonToday(utc(2026, 8, 18, 23, 30))).toBe("2026-08-19");
  });

  it("does not roll over early: 2026-08-18 20:00 UTC is still 2026-08-18 21:00 BST", () => {
    expect(londonToday(utc(2026, 8, 18, 20, 0))).toBe("2026-08-18");
  });

  it("outside BST (winter), London matches UTC exactly", () => {
    expect(londonToday(utc(2026, 1, 15, 23, 30))).toBe("2026-01-15");
  });
});

describe("resolvePresetRange — Today", () => {
  it("resolves to a single-day range: today through today", () => {
    const range = resolvePresetRange("today", utc(2026, 8, 18, 12));
    expect(range).toEqual({ start: "2026-08-18", end: "2026-08-18" });
  });
});

describe("resolvePresetRange — This Month", () => {
  it("resolves from the 1st of the current month through today", () => {
    expect(resolvePresetRange("this-month", utc(2026, 8, 18, 12))).toEqual({ start: "2026-08-01", end: "2026-08-18" });
  });

  it("handles the first day of the month correctly (start === end)", () => {
    expect(resolvePresetRange("this-month", utc(2026, 8, 1, 12))).toEqual({ start: "2026-08-01", end: "2026-08-01" });
  });
});

describe("resolvePresetRange — Last Month", () => {
  it("resolves to the complete previous calendar month", () => {
    expect(resolvePresetRange("last-month", utc(2026, 8, 18, 12))).toEqual({ start: "2026-07-01", end: "2026-07-31" });
  });

  it("REQUIREMENT: crosses a year boundary correctly (January -> previous December)", () => {
    expect(resolvePresetRange("last-month", utc(2026, 1, 15, 12))).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });

  it("REQUIREMENT: leap-year February is 29 days", () => {
    expect(resolvePresetRange("last-month", utc(2024, 3, 10, 12))).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });

  it("REQUIREMENT: non-leap-year February is 28 days", () => {
    expect(resolvePresetRange("last-month", utc(2025, 3, 10, 12))).toEqual({ start: "2025-02-01", end: "2025-02-28" });
  });

  it("2000 was a leap year (divisible by 400)", () => {
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it("1900 was NOT a leap year (divisible by 100 but not 400)", () => {
    expect(daysInMonth(1900, 2)).toBe(28);
  });
});

describe("resolvePresetRange — Last 3 Months", () => {
  it("starts on the 1st of the month two months before the current month, through today", () => {
    expect(resolvePresetRange("last-3-months", utc(2026, 8, 18, 12))).toEqual({ start: "2026-06-01", end: "2026-08-18" });
  });

  it("REQUIREMENT: crosses a year boundary when the current month is January or February", () => {
    expect(resolvePresetRange("last-3-months", utc(2026, 2, 10, 12))).toEqual({ start: "2025-12-01", end: "2026-02-10" });
  });
});

describe("resolvePresetRange — This Year / Last Year", () => {
  it("This Year: 1 January through today", () => {
    expect(resolvePresetRange("this-year", utc(2026, 8, 18, 12))).toEqual({ start: "2026-01-01", end: "2026-08-18" });
  });

  it("Last Year: the complete previous calendar year", () => {
    expect(resolvePresetRange("last-year", utc(2026, 8, 18, 12))).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });
});

describe("resolvePresetRange — All Time", () => {
  it("resolves to an unbounded range (both null)", () => {
    expect(resolvePresetRange("all-time", utc(2026, 8, 18, 12))).toEqual({ start: null, end: null });
  });
});

describe("resolveCustomRange", () => {
  it("accepts an inclusive UK-format range and returns ISO dates", () => {
    expect(resolveCustomRange("01/06/2026", "30/06/2026")).toEqual({ ok: true, range: { start: "2026-06-01", end: "2026-06-30" } });
  });

  it("accepts ISO input too (reuses parseUkDate, which accepts both)", () => {
    expect(resolveCustomRange("2026-06-01", "2026-06-30")).toEqual({ ok: true, range: { start: "2026-06-01", end: "2026-06-30" } });
  });

  it("a single-day custom range (start === end) is valid", () => {
    expect(resolveCustomRange("18/08/2026", "18/08/2026")).toEqual({ ok: true, range: { start: "2026-08-18", end: "2026-08-18" } });
  });

  it("REQUIREMENT: rejects a start date after the end date", () => {
    const result = resolveCustomRange("30/06/2026", "01/06/2026");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Start date cannot be after end date");
  });

  it("rejects a missing start or end date", () => {
    expect(resolveCustomRange("", "30/06/2026").ok).toBe(false);
    expect(resolveCustomRange("01/06/2026", "").ok).toBe(false);
    expect(resolveCustomRange(null, "30/06/2026").ok).toBe(false);
    expect(resolveCustomRange("01/06/2026", undefined).ok).toBe(false);
  });

  it("rejects an invalid calendar date, identifying which field failed", () => {
    const start = resolveCustomRange("31/02/2026", "30/06/2026");
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.error).toContain("Start date:");

    const end = resolveCustomRange("01/06/2026", "31/02/2026");
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.error).toContain("End date:");
  });
});

describe("resolveDateFilter", () => {
  it("dispatches to resolveCustomRange for the 'custom' preset", () => {
    expect(resolveDateFilter({ preset: "custom", customStart: "01/06/2026", customEnd: "30/06/2026" })).toEqual({ ok: true, range: { start: "2026-06-01", end: "2026-06-30" } });
  });

  it("propagates a custom-range validation error", () => {
    const result = resolveDateFilter({ preset: "custom", customStart: "30/06/2026", customEnd: "01/06/2026" });
    expect(result.ok).toBe(false);
  });

  it("dispatches to resolvePresetRange for every non-custom preset", () => {
    expect(resolveDateFilter({ preset: "today" }, utc(2026, 8, 18, 12))).toEqual({ ok: true, range: { start: "2026-08-18", end: "2026-08-18" } });
  });
});

describe("describeDateRange", () => {
  it("formats a multi-day range as 'D Mon YYYY – D Mon YYYY'", () => {
    expect(describeDateRange({ start: "2026-08-01", end: "2026-08-18" })).toBe("1 Aug 2026 – 18 Aug 2026");
  });

  it("collapses a single-day range to one date", () => {
    expect(describeDateRange({ start: "2026-08-18", end: "2026-08-18" })).toBe("18 Aug 2026");
  });

  it("describes an unbounded (All Time) range explicitly", () => {
    expect(describeDateRange({ start: null, end: null })).toBe("All time");
  });
});

describe("enumerateDays / enumerateMonths — zero-fill inputs for the chart", () => {
  it("enumerates every calendar day inclusive of both ends", () => {
    expect(enumerateDays("2026-08-01", "2026-08-05")).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
  });

  it("a single-day range enumerates exactly one day", () => {
    expect(enumerateDays("2026-08-18", "2026-08-18")).toEqual(["2026-08-18"]);
  });

  it("REQUIREMENT: correctly spans a leap-day (29 Feb 2024)", () => {
    expect(enumerateDays("2024-02-27", "2024-03-01")).toEqual(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]);
  });

  it("enumerates every calendar month inclusive of both ends", () => {
    expect(enumerateMonths("2026-06-01", "2026-08-18")).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("REQUIREMENT: enumerateMonths crosses a year boundary", () => {
    expect(enumerateMonths("2025-11-01", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("a single-month range enumerates exactly one month", () => {
    expect(enumerateMonths("2026-08-01", "2026-08-18")).toEqual(["2026-08"]);
  });
});

describe("daySpan", () => {
  it("a single day spans 1", () => {
    expect(daySpan("2026-08-18", "2026-08-18")).toBe(1);
  });

  it("REQUIREMENT: inclusive span, not exclusive (31 days in a 1..31 August range)", () => {
    expect(daySpan("2026-08-01", "2026-08-31")).toBe(31);
  });

  it("spans correctly across a leap day", () => {
    expect(daySpan("2024-02-01", "2024-03-01")).toBe(30);
  });
});

describe("formatReportDate / formatReportMonth", () => {
  it("formats an ISO date as 'D Mon YYYY'", () => {
    expect(formatReportDate("2026-08-01")).toBe("1 Aug 2026");
    expect(formatReportDate("2026-08-18")).toBe("18 Aug 2026");
  });

  it("formats a YYYY-MM month key as 'Mon YYYY'", () => {
    expect(formatReportMonth("2026-08")).toBe("Aug 2026");
    expect(formatReportMonth("2025-12")).toBe("Dec 2025");
  });
});
