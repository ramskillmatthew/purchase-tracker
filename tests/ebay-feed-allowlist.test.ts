import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  assertAllowedFeedOperation,
  assertAllowedFeedAction,
  ONLY_ALLOWED_FEED_ACTION,
} from "@/lib/ebay-account/feed-allowlist";

describe("assertAllowedFeedOperation — Feed API HTTP operation allowlist", () => {
  it("permits exactly the operations this feature needs", () => {
    for (const op of ["createFeedTask", "uploadFeedFile", "getFeedTask", "getFeedTasks", "getFeedResultFile"]) {
      expect(() => assertAllowedFeedOperation(op)).not.toThrow();
    }
  });

  it("rejects an operation that isn't on the allowlist", () => {
    expect(() => assertAllowedFeedOperation("deleteFeedTask")).toThrow(/not on the explicit allowlist/);
  });

  it("rejects known out-of-scope Feed API resources explicitly, not just by omission", () => {
    for (const op of ["createOrderTask", "getOrderTask", "createInventoryTask", "createSchedule", "updateSchedule", "deleteSchedule"]) {
      expect(() => assertAllowedFeedOperation(op)).toThrow(/permanently forbidden/);
    }
  });
});

describe("assertAllowedFeedAction — CSV row Action denylist (Phase 5 requirement)", () => {
  it("permits only 'Draft'", () => {
    expect(ONLY_ALLOWED_FEED_ACTION).toBe("Draft");
    expect(() => assertAllowedFeedAction("Draft")).not.toThrow();
  });

  it("rejects Add / Revise / Relist / End — each would create or modify a live listing", () => {
    for (const action of ["Add", "Revise", "Relist", "End"]) {
      expect(() => assertAllowedFeedAction(action), action).toThrow(/would create or modify a live eBay listing/);
    }
  });

  it("rejects the LMS-family publish-equivalent action strings outright", () => {
    for (const action of ["LMS_ADD_FIXED_PRICE_ITEM", "LMS_ADD_ITEM", "LMS_REVISE_FIXED_PRICE_ITEM", "LMS_END_ITEM"]) {
      expect(() => assertAllowedFeedAction(action), action).toThrow(/permanently forbidden/);
    }
  });

  it("rejects an unknown/garbage action rather than defaulting to allow", () => {
    expect(() => assertAllowedFeedAction("SomethingNew")).toThrow(/not the only permitted Feed draft action/);
    expect(() => assertAllowedFeedAction("")).toThrow();
    expect(() => assertAllowedFeedAction("draft")).toThrow(); // case-sensitive — never loosely matched
  });

  it("the forbidden-action check wins even against its own allowed constant, defence in depth", () => {
    // If ONLY_ALLOWED_FEED_ACTION were ever mistakenly widened to include a
    // dangerous value, the denylist must still win. We can't mutate the
    // exported const (readonly), so this asserts the denylist check runs
    // unconditionally first by confirming a forbidden action's error message
    // never mentions "not the only permitted" (i.e. it never falls through
    // to the second, weaker check).
    try {
      assertAllowedFeedAction("Add");
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).not.toMatch(/not the only permitted/);
      expect(String(err)).toMatch(/permanently forbidden/);
    }
  });
});
