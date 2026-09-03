import { describe, expect, it } from "vitest";
import { runningActivityValueCandidates, RUNNING_ACTIVITY_VALUE_CANDIDATES } from "@/lib/listing-studio/ebay-performance-activity-rule";

describe("runningActivityValueCandidates — deterministic running-footwear Performance/Activity mapping", () => {
  it("6. explicit running-trainer facts produce the ordered allowed-value candidate list", () => {
    const candidates = runningActivityValueCandidates({ itemFamily: "footwear", productType: "Running Trainers" }, "On Running Cloud 5 Running Trainers Women's UK 4");
    expect(candidates).toEqual([...RUNNING_ACTIVITY_VALUE_CANDIDATES]);
    expect(candidates[0]).toBe("Running & Jogging"); // the eBay-canonical value tried first
  });

  it("6. the title alone stating 'running trainers' is explicit enough, even when productType is vague", () => {
    expect(runningActivityValueCandidates({ itemFamily: "footwear", productType: "Trainers" }, "Nike Pegasus 40 Running Trainers")).toEqual([...RUNNING_ACTIVITY_VALUE_CANDIDATES]);
  });

  it("6. 'jogging' counts as running evidence too", () => {
    expect(runningActivityValueCandidates({ itemFamily: "footwear", productType: "Jogging Shoes" }, null)).toEqual([...RUNNING_ACTIVITY_VALUE_CANDIDATES]);
  });

  it("10. non-running footwear (gym trainers) produces NO deterministic candidate — the aspect keeps its ordinary review path", () => {
    expect(runningActivityValueCandidates({ itemFamily: "footwear", productType: "Gym Trainers" }, "Reebok Nano Cross Training Shoes")).toEqual([]);
  });

  it("10. an explicit clothing item never gets a running Performance/Activity candidate", () => {
    expect(runningActivityValueCandidates({ itemFamily: "clothing", productType: "Running Jacket" }, "Running Jacket")).toEqual([]);
  });

  it("does not fire without a running/jogging word — plain 'trainers' text never triggers it", () => {
    expect(runningActivityValueCandidates({ itemFamily: "footwear", productType: "Trainers" }, "brandnew unworn")).toEqual([]);
  });

  it("null/undefined facts are handled safely — the title still counts as evidence", () => {
    expect(runningActivityValueCandidates(null, "Running Trainers")).toEqual([...RUNNING_ACTIVITY_VALUE_CANDIDATES]);
    expect(runningActivityValueCandidates(undefined, null)).toEqual([]);
  });
});
