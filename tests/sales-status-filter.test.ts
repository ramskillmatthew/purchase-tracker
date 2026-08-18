import { describe, expect, it } from "vitest";
import { isSelectableForCancellation, matchesSalesStatusFilter, parseSalesStatusFilter, salesStatusFilters } from "@/lib/sales/status-filter";

describe("salesStatusFilters — shape and default", () => {
  it("REQUIREMENT: Completed, Cancelled, All — in that order", () => {
    expect(salesStatusFilters.map(option => option.value)).toEqual(["completed", "cancelled", "all"]);
    expect(salesStatusFilters.map(option => option.label)).toEqual(["Completed", "Cancelled", "All"]);
  });

  it("REQUIREMENT: parseSalesStatusFilter defaults to 'completed' for anything unrecognised, missing, or null", () => {
    expect(parseSalesStatusFilter(null)).toBe("completed");
    expect(parseSalesStatusFilter(undefined)).toBe("completed");
    expect(parseSalesStatusFilter("")).toBe("completed");
    expect(parseSalesStatusFilter("bogus")).toBe("completed");
  });

  it("parseSalesStatusFilter recognises cancelled and all", () => {
    expect(parseSalesStatusFilter("cancelled")).toBe("cancelled");
    expect(parseSalesStatusFilter("all")).toBe("all");
  });
});

describe("matchesSalesStatusFilter", () => {
  it("REQUIREMENT: Completed shows only completed sales", () => {
    expect(matchesSalesStatusFilter({ status: "completed" }, "completed")).toBe(true);
    expect(matchesSalesStatusFilter({ status: "cancelled" }, "completed")).toBe(false);
    expect(matchesSalesStatusFilter({ status: "refunded" }, "completed")).toBe(false);
  });

  it("REQUIREMENT: Cancelled shows only cancelled sales", () => {
    expect(matchesSalesStatusFilter({ status: "cancelled" }, "cancelled")).toBe(true);
    expect(matchesSalesStatusFilter({ status: "completed" }, "cancelled")).toBe(false);
    expect(matchesSalesStatusFilter({ status: "refunded" }, "cancelled")).toBe(false);
  });

  it("REQUIREMENT: All shows every status", () => {
    expect(matchesSalesStatusFilter({ status: "completed" }, "all")).toBe(true);
    expect(matchesSalesStatusFilter({ status: "cancelled" }, "all")).toBe(true);
    expect(matchesSalesStatusFilter({ status: "refunded" }, "all")).toBe(true);
  });
});

describe("isSelectableForCancellation", () => {
  it("REQUIREMENT: a completed sale is selectable", () => {
    expect(isSelectableForCancellation({ status: "completed" })).toBe(true);
  });

  it("REGRESSION: a cancelled sale is never selectable again", () => {
    expect(isSelectableForCancellation({ status: "cancelled" })).toBe(false);
  });

  it("a refunded sale is not selectable for THIS (cancellation) action either", () => {
    expect(isSelectableForCancellation({ status: "refunded" })).toBe(false);
  });
});
