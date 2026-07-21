import { describe, expect, it } from "vitest";
import { firstUncoveredDate, hasFullCoverage } from "@/lib/email-index/coverage-gaps";

describe("coverage gap detection", () => {
  it("reports the whole range uncovered when no completed rows exist", () => {
    expect(firstUncoveredDate([], "2026-07-01", "2026-07-10")).toBe("2026-07-01");
    expect(hasFullCoverage([], "2026-07-01", "2026-07-10")).toBe(false);
  });

  it("reports full coverage when one row spans the whole request", () => {
    const ranges = [{ range_start: "2026-07-01", range_end: "2026-07-10" }];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBeNull();
    expect(hasFullCoverage(ranges, "2026-07-01", "2026-07-10")).toBe(true);
  });

  it("finds the gap after a partial prefix is covered", () => {
    const ranges = [{ range_start: "2026-07-01", range_end: "2026-07-05" }];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBe("2026-07-06");
  });

  it("merges adjacent and overlapping completed rows", () => {
    const ranges = [
      { range_start: "2026-07-01", range_end: "2026-07-05" },
      { range_start: "2026-07-04", range_end: "2026-07-08" },
      { range_start: "2026-07-09", range_end: "2026-07-10" },
    ];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBeNull();
  });

  it("finds a gap in the middle even with rows before and after it", () => {
    const ranges = [
      { range_start: "2026-07-01", range_end: "2026-07-03" },
      { range_start: "2026-07-08", range_end: "2026-07-10" },
    ];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBe("2026-07-04");
  });

  it("ignores completed rows entirely outside the requested range", () => {
    const ranges = [{ range_start: "2025-01-01", range_end: "2025-01-31" }];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBe("2026-07-01");
  });
});

// range_start and range_end are both INCLUSIVE UTC calendar days everywhere
// in this system: scanYahooMetadata(WithCursor) builds since=start 00:00Z
// (inclusive) and before=end+1 day 00:00Z (making end itself fully
// included), and lib/email-index/query.ts's filters use the same
// gte-start / lt-nextDay(end) pattern. These tests pin that convention down
// so adjacent completed ranges can never silently skip or double-count the
// boundary day between them.
describe("inclusive boundary semantics", () => {
  it("treats back-to-back ranges with no gap day between them as fully covered", () => {
    // range_end of the first row (07-05) and range_start of the second (07-06)
    // are adjacent calendar days with nothing missing between them.
    const ranges = [
      { range_start: "2026-07-01", range_end: "2026-07-05" },
      { range_start: "2026-07-06", range_end: "2026-07-10" },
    ];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBeNull();
  });

  it("detects a single missing day between two otherwise-adjacent ranges", () => {
    // 07-06 is missing: the first row ends 07-05, the second starts 07-07.
    const ranges = [
      { range_start: "2026-07-01", range_end: "2026-07-05" },
      { range_start: "2026-07-07", range_end: "2026-07-10" },
    ];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBe("2026-07-06");
  });

  it("treats a row touching the request's exact end day as covering that day", () => {
    const ranges = [{ range_start: "2026-07-01", range_end: "2026-07-10" }];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBeNull();
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-09")).toBeNull();
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-11")).toBe("2026-07-11");
  });

  it("does not double-count or error when two rows overlap exactly on one shared day", () => {
    const ranges = [
      { range_start: "2026-07-01", range_end: "2026-07-05" },
      { range_start: "2026-07-05", range_end: "2026-07-10" },
    ];
    expect(firstUncoveredDate(ranges, "2026-07-01", "2026-07-10")).toBeNull();
  });
});
