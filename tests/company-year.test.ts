import { describe, expect, it } from "vitest";
import { companyYearDates, companyYearLabel, parseCompanyYearStart } from "@/lib/company-year";

describe("company year", () => {
  it("uses 15 April as the safe default", () => {
    expect(parseCompanyYearStart(null)).toEqual({ month: 4, day: 15 });
    expect(companyYearLabel({ month: 4, day: 15 })).toBe("15 April to 14 April");
  });

  it("returns the current company year to date after the anniversary", () => {
    expect(companyYearDates(new Date(2026, 9, 27), { month: 4, day: 15 })).toEqual({ start: "2026-04-15", today: "2026-10-27", end: "2027-04-14" });
  });

  it("uses the previous anniversary before the start date", () => {
    expect(companyYearDates(new Date(2027, 2, 1), { month: 4, day: 15 })).toEqual({ start: "2026-04-15", today: "2027-03-01", end: "2027-04-14" });
  });
});
