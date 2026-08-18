import { describe, expect, it } from "vitest";
import { collapseToLatestPerObservation, isLaterRevision } from "@/lib/investments/price-revisions";

function rev(overrides: Partial<{ provider: string; priceAt: string; createdAt: string; id: string }> = {}) {
  return { provider: "pokepulse", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T07:57:00.000Z", id: "a", ...overrides };
}

describe("isLaterRevision", () => {
  it("a later created_at wins", () => {
    expect(isLaterRevision(rev({ createdAt: "2026-08-17T13:00:00.000Z", id: "b" }), rev({ createdAt: "2026-08-17T07:00:00.000Z", id: "a" }))).toBe(true);
    expect(isLaterRevision(rev({ createdAt: "2026-08-17T07:00:00.000Z", id: "a" }), rev({ createdAt: "2026-08-17T13:00:00.000Z", id: "b" }))).toBe(false);
  });

  it("identical created_at falls back to id as a stable tiebreak", () => {
    expect(isLaterRevision(rev({ createdAt: "2026-08-17T07:00:00.000Z", id: "z" }), rev({ createdAt: "2026-08-17T07:00:00.000Z", id: "a" }))).toBe(true);
    expect(isLaterRevision(rev({ createdAt: "2026-08-17T07:00:00.000Z", id: "a" }), rev({ createdAt: "2026-08-17T07:00:00.000Z", id: "z" }))).toBe(false);
  });
});

describe("collapseToLatestPerObservation", () => {
  it("REGRESSION: three same-day PokePulse revisions collapse to exactly one point — the latest by created_at (Chaos Rising Elite Trainer Box: £69.64 -> £70.31 -> £67.52, all same aggregation date)", () => {
    const rows = [
      { provider: "pokepulse", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T07:57:00.000Z", id: "s1", price: 69.64 },
      { provider: "pokepulse", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T12:57:00.000Z", id: "s2", price: 70.31 },
      { provider: "pokepulse", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T13:39:00.000Z", id: "s3", price: 67.52 },
    ];
    const collapsed = collapseToLatestPerObservation(rows);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe("s3");
    expect((collapsed[0] as typeof rows[number]).price).toBe(67.52);
  });

  it("distinct observation dates are never merged — a genuine multi-day series stays intact", () => {
    const rows = [
      { provider: "eodhd", priceAt: "2026-08-12T00:00:00.000Z", createdAt: "2026-08-12T12:00:00.000Z", id: "s1" },
      { provider: "eodhd", priceAt: "2026-08-13T00:00:00.000Z", createdAt: "2026-08-13T12:00:00.000Z", id: "s2" },
      { provider: "eodhd", priceAt: "2026-08-14T00:00:00.000Z", createdAt: "2026-08-14T12:00:00.000Z", id: "s3" },
    ];
    expect(collapseToLatestPerObservation(rows)).toHaveLength(3);
  });

  it("different providers sharing the same price_at are never merged into one point", () => {
    const rows = [
      { provider: "twelve_data", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T09:00:00.000Z", id: "s1" },
      { provider: "eodhd", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T09:00:00.000Z", id: "s2" },
    ];
    expect(collapseToLatestPerObservation(rows)).toHaveLength(2);
  });

  it("output is sorted by price_at ascending, matching every existing consumer's expectation", () => {
    const rows = [
      { provider: "eodhd", priceAt: "2026-08-14T00:00:00.000Z", createdAt: "2026-08-14T12:00:00.000Z", id: "s3" },
      { provider: "eodhd", priceAt: "2026-08-12T00:00:00.000Z", createdAt: "2026-08-12T12:00:00.000Z", id: "s1" },
      { provider: "eodhd", priceAt: "2026-08-13T00:00:00.000Z", createdAt: "2026-08-13T12:00:00.000Z", id: "s2" },
    ];
    expect(collapseToLatestPerObservation(rows).map(r => r.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("an identical-created_at tie is resolved by id, never left non-deterministic", () => {
    const rows = [
      { provider: "pokepulse", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T07:57:00.000Z", id: "aaa" },
      { provider: "pokepulse", priceAt: "2026-08-17T00:00:00.000Z", createdAt: "2026-08-17T07:57:00.000Z", id: "zzz" },
    ];
    expect(collapseToLatestPerObservation(rows)[0].id).toBe("zzz");
    // Order of input never matters — same result reversed.
    expect(collapseToLatestPerObservation([...rows].reverse())[0].id).toBe("zzz");
  });

  it("empty input returns empty output", () => {
    expect(collapseToLatestPerObservation([])).toEqual([]);
  });
});
