import { describe, expect, it } from "vitest";
import { explicitDateRange } from "@/lib/yahoo/query-dates";

describe("explicit email date ranges", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  it("parses repeated month names", () => expect(explicitDateRange("from the 10th July to 20th July", now)).toEqual({ startDate: "2026-07-10", endDate: "2026-07-20" }));
  it("parses a shared trailing month", () => expect(explicitDateRange("from 10th to 20th July", now)).toEqual({ startDate: "2026-07-10", endDate: "2026-07-20" }));
  it("parses month-first ranges and explicit years", () => expect(explicitDateRange("July 10 to July 20 2025", now)).toEqual({ startDate: "2025-07-10", endDate: "2025-07-20" }));
  it("parses between-and ranges", () => { expect(explicitDateRange("between July 10th and July 20th", now)).toEqual({ startDate: "2026-07-10", endDate: "2026-07-20" }); expect(explicitDateRange("between 10th July and 20th July", now)).toEqual({ startDate: "2026-07-10", endDate: "2026-07-20" }); });
  it("parses a single day using the current year", () => { expect(explicitDateRange("on the 15th July", now)).toEqual({ startDate: "2026-07-15", endDate: "2026-07-15" }); expect(explicitDateRange("July 15 2025", now)).toEqual({ startDate: "2025-07-15", endDate: "2025-07-15" }); });
  it("parses relative calendar periods without model inference", () => { expect(explicitDateRange("so far this month", now)).toEqual({ startDate: "2026-07-01", endDate: "2026-07-20" }); expect(explicitDateRange("last month", now)).toEqual({ startDate: "2026-06-01", endDate: "2026-06-30" }); expect(explicitDateRange("this week", now)).toEqual({ startDate: "2026-07-20", endDate: "2026-07-20" }); expect(explicitDateRange("last week", now)).toEqual({ startDate: "2026-07-13", endDate: "2026-07-19" }); });
  it.each(["last month", "from last month", "from the last month", "in the last month", "during the previous month", "over the past month"])("treats %s as the previous calendar month", phrase => {
    expect(explicitDateRange(`import all my purchases ${phrase}`, now)).toEqual({ startDate: "2026-06-01", endDate: "2026-06-30" });
  });
  it("uses an explicit day count for a rolling month", () => {
    expect(explicitDateRange("import all my purchases from the last 30 days", now)).toEqual({ startDate: "2026-06-21", endDate: "2026-07-20" });
  });
  it("parses numeric rolling periods", () => { expect(explicitDateRange("in the last 3 months", now)).toEqual({ startDate: "2026-04-20", endDate: "2026-07-20" }); expect(explicitDateRange("past 14 days", now)).toEqual({ startDate: "2026-07-07", endDate: "2026-07-20" }); expect(explicitDateRange("previous 2 weeks", now)).toEqual({ startDate: "2026-07-07", endDate: "2026-07-20" }); expect(explicitDateRange("last 2 years", now)).toEqual({ startDate: "2024-07-20", endDate: "2026-07-20" }); });
  it("parses rolling periods written as words", () => { expect(explicitDateRange("in the last three months", now)).toEqual({ startDate: "2026-04-20", endDate: "2026-07-20" }); expect(explicitDateRange("previous two weeks", now)).toEqual({ startDate: "2026-07-07", endDate: "2026-07-20" }); });
  it.each(["May 2026", "from May 2026", "in May 2026", "during May 2026"])("parses the complete named month in %s", phrase => {
    expect(explicitDateRange(`import purchases ${phrase}`, now)).toEqual({ startDate: "2026-05-01", endDate: "2026-05-31" });
  });
  it("parses complete month and quarter ranges", () => {
    expect(explicitDateRange("April to June 2026", now)).toEqual({ startDate: "2026-04-01", endDate: "2026-06-30" });
    expect(explicitDateRange("December to January 2026", now)).toEqual({ startDate: "2025-12-01", endDate: "2026-01-31" });
    expect(explicitDateRange("May 2025 to June 2026", now)).toEqual({ startDate: "2025-05-01", endDate: "2026-06-30" });
    expect(explicitDateRange("Q2 2026", now)).toEqual({ startDate: "2026-04-01", endDate: "2026-06-30" });
  });
  it("parses whole years and machine or UK date formats", () => {
    expect(explicitDateRange("purchases from 2025", now)).toEqual({ startDate: "2025-01-01", endDate: "2025-12-31" });
    expect(explicitDateRange("2026-05-01 to 2026-05-31", now)).toEqual({ startDate: "2026-05-01", endDate: "2026-05-31" });
    expect(explicitDateRange("01/05/2026 to 31/05/2026", now)).toEqual({ startDate: "2026-05-01", endDate: "2026-05-31" });
  });
  it("parses cross-year named-day ranges", () => {
    expect(explicitDateRange("20 December 2025 to 5 January 2026", now)).toEqual({ startDate: "2025-12-20", endDate: "2026-01-05" });
  });
  it("never treats digits from a year as a day", () => expect(explicitDateRange("May 2026", now)).not.toEqual({ startDate: "2026-05-20", endDate: "2026-05-20" }));
  it("rejects invalid and reversed dates", () => { expect(explicitDateRange("31 June to 2 July", now)).toBeNull(); expect(explicitDateRange("20 July to 10 July", now)).toBeNull(); });
});
