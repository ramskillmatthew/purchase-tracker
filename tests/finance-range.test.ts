import { describe, expect, it } from "vitest";
import { resolveFinanceRange } from "@/lib/finance/range";

describe("Finance Hub forecast ranges", () => {
  it.each([["7","2026-09-09"],["30","2026-10-02"],["90","2026-12-01"]])("resolves %s days inclusively", (preset, end) => {
    expect(resolveFinanceRange({ preset }, "2026-09-03")).toEqual({ ok: true, range: { preset, start: "2026-09-03", end } });
  });
  it("defaults to 30 days", () => expect(resolveFinanceRange({}, "2026-09-03")).toEqual({ ok: true, range: { preset: "30", start: "2026-09-03", end: "2026-10-02" } }));
  it("validates custom ranges", () => {
    expect(resolveFinanceRange({ preset: "custom", start: "2026-09-10", end: "2026-09-01" }, "2026-09-03")).toEqual({ ok: false, error: "Choose a valid custom date range." });
  });
});
