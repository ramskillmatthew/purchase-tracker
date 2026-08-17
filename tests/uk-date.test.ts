import { describe, expect, it } from "vitest";
import { parseUkDate, formatUkDate, expandTwoDigitYear } from "@/lib/validation/uk-date";

describe("parseUkDate — accepted UK day-first formats", () => {
  it("parses DD/MM/YY with a leading zero on the day", () => {
    expect(parseUkDate("12/08/26")).toEqual({ ok: true, iso: "2026-08-12" });
  });

  it("parses D/M/YY with a single-digit month", () => {
    expect(parseUkDate("12/8/26")).toEqual({ ok: true, iso: "2026-08-12" });
  });

  it("parses D/M/YY with a single-digit day and month", () => {
    expect(parseUkDate("1/8/26")).toEqual({ ok: true, iso: "2026-08-01" });
  });

  it("parses DD/MM/YYYY (existing four-digit-year format)", () => {
    expect(parseUkDate("12/08/2026")).toEqual({ ok: true, iso: "2026-08-12" });
  });

  it("parses D/M/YYYY", () => {
    expect(parseUkDate("1/8/2026")).toEqual({ ok: true, iso: "2026-08-01" });
  });

  it("passes through an already-canonical ISO date unchanged", () => {
    expect(parseUkDate("2026-08-12")).toEqual({ ok: true, iso: "2026-08-12" });
  });
});

describe("parseUkDate — two-digit year expansion (deterministic 20YY, no shifting pivot)", () => {
  it("00 -> 2000", () => {
    expect(parseUkDate("01/01/00")).toEqual({ ok: true, iso: "2000-01-01" });
  });

  it("99 -> 2099", () => {
    expect(parseUkDate("31/12/99")).toEqual({ ok: true, iso: "2099-12-31" });
  });

  it("expandTwoDigitYear is a pure, direct 2000+YY mapping", () => {
    for (let yy = 0; yy <= 99; yy++) expect(expandTwoDigitYear(yy)).toBe(2000 + yy);
  });
});

describe("parseUkDate — strict calendar validation", () => {
  it("accepts a valid leap-year date: 29/02/24 -> 2024-02-29", () => {
    expect(parseUkDate("29/02/24")).toEqual({ ok: true, iso: "2024-02-29" });
  });

  it("rejects 29/02/25 (2025 is not a leap year)", () => {
    expect(parseUkDate("29/02/25").ok).toBe(false);
  });

  it("rejects 31/04/26 (April has 30 days)", () => {
    expect(parseUkDate("31/04/26").ok).toBe(false);
  });

  it("rejects 31/02/26 (February never has 31 days)", () => {
    expect(parseUkDate("31/02/26").ok).toBe(false);
  });

  it("rejects 00/08/26 (day zero)", () => {
    expect(parseUkDate("00/08/26").ok).toBe(false);
  });

  it("rejects 12/00/26 (month zero)", () => {
    expect(parseUkDate("12/00/26").ok).toBe(false);
  });

  it("rejects 32/01/26 (day out of range)", () => {
    expect(parseUkDate("32/01/26").ok).toBe(false);
  });

  it("rejects 12/13/26 (month out of range) — never falls back to US month-first", () => {
    expect(parseUkDate("12/13/26").ok).toBe(false);
  });

  it("never reinterprets day-first as US month-first: 08/12/26 is 8 December, not 12 August", () => {
    expect(parseUkDate("08/12/26")).toEqual({ ok: true, iso: "2026-12-08" });
  });

  it("rejects incomplete dates", () => {
    expect(parseUkDate("12/08").ok).toBe(false);
    expect(parseUkDate("12/08/").ok).toBe(false);
    expect(parseUkDate("//").ok).toBe(false);
  });

  it("rejects malformed values with extra characters", () => {
    expect(parseUkDate("12/08/2026x").ok).toBe(false);
    expect(parseUkDate("12/08/20266").ok).toBe(false);
    expect(parseUkDate("today").ok).toBe(false);
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseUkDate("").ok).toBe(false);
    expect(parseUkDate("   ").ok).toBe(false);
  });

  it("rejects an invalid ISO calendar date the same way", () => {
    expect(parseUkDate("2026-02-30").ok).toBe(false);
  });

  it("returns a structured error message identifying the offending value", () => {
    const result = parseUkDate("31/02/26");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("31/02/26");
  });
});

describe("parseUkDate — no timezone/UTC rollover", () => {
  it("never constructs a JS Date object internally (source has no `new Date`)", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(process.cwd(), "lib/validation/uk-date.ts"), "utf8");
    expect(source).not.toMatch(/new Date/);
  });

  it("a date at either edge of the year is preserved exactly, regardless of host timezone", () => {
    expect(parseUkDate("31/12/26")).toEqual({ ok: true, iso: "2026-12-31" });
    expect(parseUkDate("01/01/26")).toEqual({ ok: true, iso: "2026-01-01" });
  });
});

describe("formatUkDate", () => {
  it("formats a canonical ISO date as DD/MM/YYYY", () => {
    expect(formatUkDate("2026-08-12")).toBe("12/08/2026");
  });

  it("formats a single-digit day/month with zero padding", () => {
    expect(formatUkDate("2026-08-01")).toBe("01/08/2026");
  });

  it("returns non-ISO input unchanged", () => {
    expect(formatUkDate("not-a-date")).toBe("not-a-date");
  });
});
