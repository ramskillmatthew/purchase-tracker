import { describe, expect, it } from "vitest";
import { deriveConditionGroup } from "@/lib/condition-group";
import { conditions } from "@/lib/validation/purchase";

describe("deriveConditionGroup — canonical mapping", () => {
  it.each([
    ["Brand new", "new"],
    ["Brand new without tags", "new"],
    ["Labelled as very good condition", "used"],
    ["Good condition from photos", "used"],
    ["Decent condition from photos", "used"],
  ] as const)("%s -> %s", (condition, expected) => {
    expect(deriveConditionGroup(condition)).toBe(expected);
  });

  it("REQUIREMENT: covers every canonical condition — none fall through to unknown", () => {
    for (const condition of conditions) expect(deriveConditionGroup(condition)).not.toBe("unknown");
  });
});

describe("deriveConditionGroup — safe fallback for null/blank/historical text", () => {
  it("null returns unknown", () => {
    expect(deriveConditionGroup(null)).toBe("unknown");
  });

  it("undefined returns unknown", () => {
    expect(deriveConditionGroup(undefined)).toBe("unknown");
  });

  it("an empty string returns unknown", () => {
    expect(deriveConditionGroup("")).toBe("unknown");
  });

  it("a whitespace-only string returns unknown (never matched literally, never crashes)", () => {
    expect(deriveConditionGroup("   ")).toBe("unknown");
  });

  it("historical spreadsheet-import free text (e.g. 'Holes in heel') returns unknown, never guessed into new/used", () => {
    expect(deriveConditionGroup("Holes in heel")).toBe("unknown");
    expect(deriveConditionGroup("Scuffs on toe box")).toBe("unknown");
  });

  it("REGRESSION: is case-sensitive and exact — a near-miss never coincidentally matches", () => {
    expect(deriveConditionGroup("brand new")).toBe("unknown");
    expect(deriveConditionGroup("Brand New")).toBe("unknown");
    expect(deriveConditionGroup("Good condition")).toBe("unknown");
  });
});

describe("deriveConditionGroup — purity", () => {
  it("never throws for any string input", () => {
    expect(() => deriveConditionGroup("anything at all")).not.toThrow();
  });

  it("is deterministic — repeated calls with the same input return the same result", () => {
    expect(deriveConditionGroup("Brand new")).toBe(deriveConditionGroup("Brand new"));
  });

  it("does not mutate the shared `conditions` array", () => {
    const before = [...conditions];
    deriveConditionGroup("Brand new");
    expect(conditions).toEqual(before);
  });
});
