import { describe, expect, it } from "vitest";
import { isWholePennyAmount } from "@/lib/purchase-import/pence";

describe("isWholePennyAmount", () => {
  it("REGRESSION: accepts 100.00, 100, and 33.33", () => {
    expect(isWholePennyAmount(100.0)).toBe(true);
    expect(isWholePennyAmount(100)).toBe(true);
    expect(isWholePennyAmount(33.33)).toBe(true);
  });

  it("REGRESSION: rejects 33.333 (a third decimal place)", () => {
    expect(isWholePennyAmount(33.333)).toBe(false);
  });

  it("rejects other fractional-penny values", () => {
    expect(isWholePennyAmount(0.005)).toBe(false);
    expect(isWholePennyAmount(19.999)).toBe(false);
  });

  it("accepts zero", () => {
    expect(isWholePennyAmount(0)).toBe(true);
  });

  it("rejects non-finite values", () => {
    expect(isWholePennyAmount(NaN)).toBe(false);
    expect(isWholePennyAmount(Infinity)).toBe(false);
  });

  it("tolerates ordinary floating-point representation noise for genuine 2-decimal values", () => {
    // 0.1 + 0.2 famously isn't exactly 0.3 in IEEE-754 — still a valid
    // whole-penny amount and must not be rejected as a false positive.
    expect(isWholePennyAmount(0.1 + 0.2)).toBe(true);
  });
});
