import { describe, expect, it } from "vitest";
import { readContentGenerationState, buildGeneratedRecord, buildFallbackRecord, serialiseContentGenerationRecord } from "@/lib/listing-studio/ebay-content-generation-state";

describe("readContentGenerationState — Phase 16: legacy row backward compatibility", () => {
  it("REQUIREMENT: an imported exact-copy eBay row is treated as GENERATED — it never went through this AI pipeline at all", () => {
    const state = readContentGenerationState(null, { sourceType: "imported_ebay", contentMode: "exact_copy", hasTitle: true, hasDescription: true });
    expect(state.state).toBe("generated");
  });

  it("REQUIREMENT: a legacy row with real title/description but no explicit marker is inferred as GENERATED once, cautiously", () => {
    const state = readContentGenerationState(null, { sourceType: "generated", contentMode: "seo_optimised", hasTitle: true, hasDescription: true });
    expect(state.state).toBe("generated");
  });

  it("REGRESSION: never marks a row GENERATED merely because a title exists with no description (partial legacy data)", () => {
    const state = readContentGenerationState(null, { sourceType: "generated", contentMode: "seo_optimised", hasTitle: true, hasDescription: false });
    expect(state.state).toBe("not_started");
  });

  it("a row with neither title nor description is not_started", () => {
    const state = readContentGenerationState(null, { sourceType: "generated", contentMode: "seo_optimised", hasTitle: false, hasDescription: false });
    expect(state.state).toBe("not_started");
  });

  it("REQUIREMENT: an explicit marker always wins over legacy inference — a real FALLBACK marker is never silently promoted to generated just because title/description exist", () => {
    const dynamicData = { __contentGeneration: serialiseContentGenerationRecord(buildFallbackRecord({ code: "EBAY_AI_TIMEOUT", message: "timed out", previousAttemptCount: 0, now: "2026-01-01T00:00:00.000Z" })) };
    const state = readContentGenerationState(dynamicData, { sourceType: "generated", contentMode: "seo_optimised", hasTitle: true, hasDescription: true });
    expect(state.state).toBe("fallback");
    expect(state.code).toBe("EBAY_AI_TIMEOUT");
  });

  it("round-trips a real GENERATED marker exactly", () => {
    const record = buildGeneratedRecord({ model: "claude-sonnet-4-6", warnings: ["a warning"], previousAttemptCount: 2, now: "2026-01-01T00:00:00.000Z" });
    const dynamicData = { __contentGeneration: serialiseContentGenerationRecord(record) };
    const state = readContentGenerationState(dynamicData, { sourceType: "generated", contentMode: "seo_optimised", hasTitle: true, hasDescription: true });
    expect(state.state).toBe("generated");
    expect(state.attemptCount).toBe(3);
    expect(state.model).toBe("claude-sonnet-4-6");
    expect(state.warnings).toEqual(["a warning"]);
  });

  it("REGRESSION: malformed/corrupted dynamicData never throws — falls back to safe legacy inference", () => {
    const dynamicData = { __contentGeneration: { notAValidRecord: true } } as never;
    expect(() => readContentGenerationState(dynamicData, { sourceType: "generated", contentMode: "seo_optimised", hasTitle: true, hasDescription: true })).not.toThrow();
  });
});
