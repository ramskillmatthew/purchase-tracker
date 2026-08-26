import { describe, expect, it } from "vitest";
import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming";

describe("getNextAutomaticGroupName — the single source of truth for automatic Product-N naming", () => {
  it("starts at 'Product 1' for an empty workspace", () => {
    expect(getNextAutomaticGroupName([])).toBe("Product 1");
  });

  it("returns (highest existing Product number) + 1", () => {
    const groups = [{ title: "Product 1" }, { title: "Product 2" }, { title: "Product 3" }];
    expect(getNextAutomaticGroupName(groups)).toBe("Product 4");
  });

  it("never reuses a deleted group's number — a gap in the sequence doesn't lower the next number", () => {
    const groups = [{ title: "Product 1" }, { title: "Product 3" }]; // Product 2 was deleted
    expect(getNextAutomaticGroupName(groups)).toBe("Product 4");
  });

  it("ignores manually renamed groups entirely, even ones that start with the word 'Product'", () => {
    const groups = [{ title: "Product 1" }, { title: "Nike Air Max" }, { title: "Product 3" }];
    expect(getNextAutomaticGroupName(groups)).toBe("Product 4");
  });

  it("does not match a renamed group that merely starts with an exact 'Product N' prefix plus extra text", () => {
    const groups = [{ title: "Product 1" }, { title: "Product 3 (limited edition)" }];
    expect(getNextAutomaticGroupName(groups)).toBe("Product 2");
  });

  it("is unaffected by null titles", () => {
    const groups = [{ title: "Product 5" }, { title: null }];
    expect(getNextAutomaticGroupName(groups)).toBe("Product 6");
  });

  it("supports creating 20 groups in succession, deleting one from the middle, and still landing on 21 next", () => {
    let groups: { title: string | null }[] = [];
    for (let i = 0; i < 20; i++) {
      const name = getNextAutomaticGroupName(groups);
      groups = [...groups, { title: name }];
    }
    expect(groups.map(g => g.title)).toEqual(Array.from({ length: 20 }, (_, i) => `Product ${i + 1}`));

    groups = groups.filter(g => g.title !== "Product 5"); // delete Product 5
    expect(getNextAutomaticGroupName(groups)).toBe("Product 21");
  });
});
