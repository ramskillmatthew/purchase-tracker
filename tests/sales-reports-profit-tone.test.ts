import { describe, expect, it } from "vitest";
import { dashboardProfitTone, profitBadgeTone } from "@/lib/sales/profit";

describe("dashboardProfitTone — binary rule for aggregate/dashboard-scale profit figures", () => {
  it("REQUIREMENT: any loss (negative pence) is red", () => {
    expect(dashboardProfitTone(-1)).toBe("red");
    expect(dashboardProfitTone(-100000)).toBe("red");
  });

  it("REQUIREMENT: break-even (exactly zero) is green, not red", () => {
    expect(dashboardProfitTone(0)).toBe("green");
  });

  it("REQUIREMENT: any positive profit is green regardless of magnitude — a huge monthly total and a single pound both read green, deliberately not banded like profitBadgeTone", () => {
    expect(dashboardProfitTone(1)).toBe("green");
    expect(dashboardProfitTone(500)).toBe("green"); // £5 — would be RED under profitBadgeTone
    expect(dashboardProfitTone(150000)).toBe("green"); // £1,500 — a realistic monthly total
  });

  it("REQUIREMENT: diverges from profitBadgeTone at exactly the scale the dashboard rule exists to fix — a modest £5 profit is red per-sale but green in aggregate", () => {
    expect(profitBadgeTone(500)).toBe("red");
    expect(dashboardProfitTone(500)).toBe("green");
  });

  it("only ever returns 'red' or 'green' — no amber band exists at dashboard scale", () => {
    for (const pence of [-100, -1, 0, 1, 999, 1000, 1999, 2000, 999999]) {
      expect(["red", "green"]).toContain(dashboardProfitTone(pence));
    }
  });
});
