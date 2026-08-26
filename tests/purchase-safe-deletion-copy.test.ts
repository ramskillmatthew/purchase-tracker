import { describe, expect, it } from "vitest";
import { deletionConfirmLabel, deletionDialogMessage, deletionDialogTitle } from "@/lib/purchases-delete-copy";

describe("deletionDialogTitle — matches the three required examples", () => {
  it('REQUIREMENT: all deletable — "Delete 8 purchases?"', () => {
    expect(deletionDialogTitle({ deletableCount: 8, protectedCount: 0 })).toBe("Delete 8 purchases?");
  });

  it("singular all-deletable phrasing", () => {
    expect(deletionDialogTitle({ deletableCount: 1, protectedCount: 0 })).toBe("Delete 1 purchase?");
  });

  it('REQUIREMENT: mixed selection — "7 purchases can be deleted. 1 purchase belongs to a completed sale and is protected."', () => {
    expect(deletionDialogTitle({ deletableCount: 7, protectedCount: 1 })).toBe(
      "7 purchases can be deleted. 1 purchase belongs to a completed sale and is protected.",
    );
  });

  it("mixed selection with plural protected count", () => {
    expect(deletionDialogTitle({ deletableCount: 1, protectedCount: 2 })).toBe(
      "1 purchase can be deleted. 2 purchases belong to a completed sale and are protected.",
    );
  });

  it('REQUIREMENT: all protected — "These purchases cannot be deleted because they belong to completed sales. Cancel the related sales first."', () => {
    expect(deletionDialogTitle({ deletableCount: 0, protectedCount: 3 })).toBe(
      "These purchases cannot be deleted because they belong to completed sales. Cancel the related sales first.",
    );
  });
});

describe("deletionConfirmLabel", () => {
  it('REQUIREMENT: all deletable — "Delete 8 purchases"', () => {
    expect(deletionConfirmLabel({ deletableCount: 8, protectedCount: 0 })).toBe("Delete 8 purchases");
  });

  it('REQUIREMENT: mixed — explicit "Delete N available purchases", never the raw selected count', () => {
    expect(deletionConfirmLabel({ deletableCount: 7, protectedCount: 1 })).toBe("Delete 7 available purchases");
  });

  it("singular available phrasing", () => {
    expect(deletionConfirmLabel({ deletableCount: 1, protectedCount: 1 })).toBe("Delete 1 available purchase");
  });
});

describe("deletionDialogMessage", () => {
  it("all-deletable message explains permanence", () => {
    expect(deletionDialogMessage({ deletableCount: 8, protectedCount: 0 })).toMatch(/permanently removed/i);
  });

  it("mixed message explains protected purchases are kept exactly as they are", () => {
    expect(deletionDialogMessage({ deletableCount: 7, protectedCount: 1 })).toMatch(/kept exactly as they are/i);
  });

  it("all-protected message directs the user to cancel the related sales first", () => {
    expect(deletionDialogMessage({ deletableCount: 0, protectedCount: 3 })).toMatch(/cancel the related sales first/i);
  });
});
