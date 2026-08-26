import { describe, expect, it } from "vitest";
import { groupItemDescriptions, itemGroupsSearchText, summariseItemGroups } from "@/lib/sales/order-summary";
import { profitBadgeTone } from "@/lib/sales/profit";

describe("groupItemDescriptions", () => {
  it("REQUIREMENT: one description repeated 3 times groups into a single entry with quantity 3", () => {
    const groups = groupItemDescriptions([
      "pokemon first partner series 3 box",
      "pokemon first partner series 3 box",
      "pokemon first partner series 3 box",
    ]);
    expect(groups).toEqual([{ description: "pokemon first partner series 3 box", quantity: 3 }]);
  });

  it("REQUIREMENT: mixed descriptions group separately, preserving first-seen order", () => {
    const groups = groupItemDescriptions(["box a", "box b", "box a", "box c", "box b"]);
    expect(groups).toEqual([
      { description: "box a", quantity: 2 },
      { description: "box b", quantity: 2 },
      { description: "box c", quantity: 1 },
    ]);
  });

  it("an empty list produces no groups", () => {
    expect(groupItemDescriptions([])).toEqual([]);
  });
});

describe("summariseItemGroups", () => {
  it("REQUIREMENT: a single group with quantity 1 renders as one plain line, no × suffix", () => {
    const summary = summariseItemGroups([{ description: "pokemon first partner series 3 box", quantity: 1 }]);
    expect(summary.lines).toEqual(["pokemon first partner series 3 box"]);
    expect(summary.overflowCount).toBe(0);
  });

  it("REQUIREMENT: a single group with quantity > 1 renders as 'description × N'", () => {
    const summary = summariseItemGroups([{ description: "pokemon first partner series 3 box", quantity: 3 }]);
    expect(summary.lines).toEqual(["pokemon first partner series 3 box × 3"]);
    expect(summary.overflowCount).toBe(0);
  });

  it("REQUIREMENT: a few mixed-product groups (<= maxStacked) all stack as separate lines", () => {
    const summary = summariseItemGroups([
      { description: "box a", quantity: 2 },
      { description: "box b", quantity: 1 },
      { description: "box c", quantity: 3 },
    ]);
    expect(summary.lines).toEqual(["box a × 2", "box b", "box c × 3"]);
    expect(summary.overflowCount).toBe(0);
  });

  it("REQUIREMENT: many groups (> maxStacked) collapse to the first line plus an overflow count", () => {
    const summary = summariseItemGroups([
      { description: "box a", quantity: 1 },
      { description: "box b", quantity: 1 },
      { description: "box c", quantity: 1 },
      { description: "box d", quantity: 1 },
      { description: "box e", quantity: 1 },
    ]);
    expect(summary.lines).toEqual(["box a"]);
    expect(summary.overflowCount).toBe(4);
  });

  it("an empty group list produces no lines and no overflow", () => {
    expect(summariseItemGroups([])).toEqual({ lines: [], overflowCount: 0 });
  });
});

describe("itemGroupsSearchText", () => {
  it("REQUIREMENT: joins every group's description, lowercased, for Sales history search", () => {
    expect(itemGroupsSearchText([{ description: "Pokemon Box", quantity: 1 }, { description: "Trainer Deck", quantity: 2 }]))
      .toBe("pokemon box trainer deck");
  });
});

describe("profitBadgeTone — exact integer-pence thresholds", () => {
  it("REQUIREMENT: £9.99 (999p) is red", () => {
    expect(profitBadgeTone(999)).toBe("red");
  });

  it("REQUIREMENT: exactly £10.00 (1000p) is amber", () => {
    expect(profitBadgeTone(1000)).toBe("amber");
  });

  it("REQUIREMENT: £19.99 (1999p) is amber", () => {
    expect(profitBadgeTone(1999)).toBe("amber");
  });

  it("REQUIREMENT: exactly £20.00 (2000p) is green", () => {
    expect(profitBadgeTone(2000)).toBe("green");
  });

  it("REQUIREMENT: any negative profit is red, however large the loss", () => {
    expect(profitBadgeTone(-1)).toBe("red");
    expect(profitBadgeTone(-50000)).toBe("red");
  });

  it("zero profit is red (below the 1000p threshold)", () => {
    expect(profitBadgeTone(0)).toBe("red");
  });
});
