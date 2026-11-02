import { describe, expect, it } from "vitest";
import { isDashboardSceneMode, resolveDashboardScene } from "@/lib/dashboard-scene";

describe("dashboard city scene", () => {
  it("uses day from 06:00 until 19:59 in auto mode", () => {
    expect(resolveDashboardScene("auto", new Date(2026, 9, 26, 6, 0))).toBe("day");
    expect(resolveDashboardScene("auto", new Date(2026, 9, 26, 19, 59))).toBe("day");
  });

  it("uses night from 20:00 until 05:59 in auto mode", () => {
    expect(resolveDashboardScene("auto", new Date(2026, 9, 26, 20, 0))).toBe("night");
    expect(resolveDashboardScene("auto", new Date(2026, 9, 26, 5, 59))).toBe("night");
  });

  it("always respects the manual day and night settings", () => {
    expect(resolveDashboardScene("day", new Date(2026, 9, 26, 23, 0))).toBe("day");
    expect(resolveDashboardScene("night", new Date(2026, 9, 26, 12, 0))).toBe("night");
  });

  it("only accepts supported saved values", () => {
    expect(isDashboardSceneMode("auto")).toBe(true);
    expect(isDashboardSceneMode("day")).toBe(true);
    expect(isDashboardSceneMode("night")).toBe(true);
    expect(isDashboardSceneMode("space")).toBe(false);
  });
});
