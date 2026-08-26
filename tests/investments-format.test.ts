import { describe, expect, it } from "vitest";
import { formatGbpCompact, formatGbpCompactTick } from "@/lib/investments/format";

describe("formatGbpCompactTick — REGRESSION: adjacent axis ticks must never render as the same string", () => {
  it("CONFIRMED LIVE: a real 1D range (16,450/16,500/16,550/16,600, £50 step) previously produced duplicate '16.5K'/'16.6K' labels — now every tick is distinct", () => {
    const ticks = [16400, 16450, 16500, 16550, 16600];
    const labels = ticks.map(t => formatGbpCompactTick(t, 50));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["16,400", "16,450", "16,500", "16,550", "16,600"]);
  });

  it("proves the OLD formatGbpCompact alone genuinely collapses this exact case (confirms the regression is real, not hypothetical)", () => {
    const labels = [16450, 16500, 16550, 16600].map(formatGbpCompact);
    expect(new Set(labels).size).toBeLessThan(labels.length);
  });

  it("a normal, wider-range step (e.g. £1,000) still uses the compact K form — never falls back unnecessarily", () => {
    expect(formatGbpCompactTick(12000, 1000)).toBe("12K");
    expect(formatGbpCompactTick(16200, 1000)).toBe("16.2K");
  });

  it("a step of exactly £100 still compacts (£100 = 0.1K is the smallest distinguishable increment at 1 decimal place)", () => {
    const labels = [16400, 16500, 16600].map(t => formatGbpCompactTick(t, 100));
    expect(labels).toEqual(["16.4K", "16.5K", "16.6K"]);
    expect(new Set(labels).size).toBe(3);
  });

  it("a single-tick or flat series (step 0) falls back to whole pounds rather than risking ambiguity", () => {
    expect(formatGbpCompactTick(500, 0)).toBe("500");
  });

  it("negative values are formatted correctly in the whole-pounds fallback", () => {
    expect(formatGbpCompactTick(-250, 50)).toBe("-250");
  });

  it("a large whole-pounds fallback value still gets thousands separators for readability", () => {
    expect(formatGbpCompactTick(16400, 50)).toBe("16,400");
  });
});
