import { describe, expect, it } from "vitest";
import { estimateAnthropicCostUsd } from "@/lib/listing-studio/anthropic-pricing";

describe("estimateAnthropicCostUsd — best-effort, never fabricated", () => {
  it("returns null for an unrecognised model — never guesses a price", () => {
    expect(estimateAnthropicCostUsd("some-future-unknown-model", 1000, 100)).toBeNull();
    expect(estimateAnthropicCostUsd(null, 1000, 100)).toBeNull();
  });

  it("returns null when either token count is missing", () => {
    expect(estimateAnthropicCostUsd("claude-sonnet-5", null, 100)).toBeNull();
    expect(estimateAnthropicCostUsd("claude-sonnet-5", 100, null)).toBeNull();
  });

  it("computes a real per-million-token estimate for a recognised model", () => {
    const cost = estimateAnthropicCostUsd("claude-sonnet-5-20260101", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(2 + 10, 5); // $2/MTok in + $10/MTok out (introductory rate)
  });

  it("scales linearly with token count", () => {
    const cost = estimateAnthropicCostUsd("claude-haiku-4-5", 500_000, 100_000);
    expect(cost).toBeCloseTo(0.5 * 1 + 0.1 * 5, 5);
  });

  it("never returns a negative or NaN value for zero tokens", () => {
    expect(estimateAnthropicCostUsd("claude-sonnet-5", 0, 0)).toBe(0);
  });
});
