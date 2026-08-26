import { describe, expect, it } from "vitest";
import { sourceItemKey } from "@/lib/purchase-import/identity";

describe("sourceItemKey", () => {
  it("REGRESSION: is stable across repeated calls with the same inputs (the same email scanned again)", () => {
    expect(sourceItemKey("gmail:abc123", 0, 0)).toBe(sourceItemKey("gmail:abc123", 0, 0));
  });

  it("distinguishes item index from unit index", () => {
    expect(sourceItemKey("msg-1", 0, 1)).not.toBe(sourceItemKey("msg-1", 1, 0));
  });

  it("distinguishes different physical units of the same item", () => {
    const keys = [sourceItemKey("msg-1", 0, 0), sourceItemKey("msg-1", 0, 1), sourceItemKey("msg-1", 0, 2)];
    expect(new Set(keys).size).toBe(3);
  });

  it("REGRESSION: two distinct items from the same order (same message id) get different keys despite sharing an order reference elsewhere", () => {
    // The order reference itself is never part of this key — only the
    // message id and the item/unit position are.
    const itemA = sourceItemKey("msg-order-9001", 0, 0);
    const itemB = sourceItemKey("msg-order-9001", 1, 0);
    expect(itemA).not.toBe(itemB);
  });

  it("differs across different source emails even with identical item/unit positions", () => {
    expect(sourceItemKey("msg-1", 0, 0)).not.toBe(sourceItemKey("msg-2", 0, 0));
  });
});
