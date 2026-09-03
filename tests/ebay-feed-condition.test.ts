import { describe, expect, it } from "vitest";
import { toFeedTemplateConditionId } from "@/lib/listing-studio/ebay-feed/feed-condition";
import { SAMPLE_ROW } from "@/lib/listing-studio/ebay-feed/template-contract";

/**
 * REQUIREMENT (Phase 4) — the Condition ID discrepancy resolution: the
 * real template's sample row uses the string "NEW", not a numeric ID.
 */
describe("toFeedTemplateConditionId — Condition ID discrepancy resolved against the real template", () => {
  it("REQUIREMENT: the real template's own sample Condition ID value ('NEW') is a string this translator round-trips correctly, proving it targets the right vocabulary", () => {
    const result = toFeedTemplateConditionId(SAMPLE_ROW[8]); // "NEW"
    expect(result).toEqual({ ok: true, enumValue: "NEW" });
  });

  it("REQUIREMENT: SKU 1644's real explicit condition maps to the exact template-supported representation", () => {
    expect(toFeedTemplateConditionId("Used – Very Good")).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
  });

  it("REQUIREMENT: ambiguous conditions fail closed here too — the safety fix is inherited, never bypassed", () => {
    for (const label of ["Used", "Pre-owned", "Good", "Fair"]) {
      const result = toFeedTemplateConditionId(label);
      expect(result.ok, label).toBe(false);
    }
  });

  it("REQUIREMENT: unknown conditions fail closed", () => {
    expect(toFeedTemplateConditionId("some made up condition").ok).toBe(false);
    expect(toFeedTemplateConditionId(null).ok).toBe(false);
  });

  it("delegates to the exact same translator as the Inventory API path — never a second, divergent mapping table", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-condition.ts", "utf8") as string;
    expect(source).toContain('import { toEbayInventoryCondition');
    expect(source).not.toMatch(/const LABEL_TO_ENUM|new Map\(\[/); // no duplicated mapping table
  });
});
