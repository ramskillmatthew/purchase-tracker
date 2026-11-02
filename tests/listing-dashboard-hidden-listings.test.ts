import { describe, expect, it } from "vitest";
import {
  LISTING_DASHBOARD_HIDDEN_IDS_KEY,
  savedHiddenListingIds,
} from "@/lib/listing-dashboard/hidden-listings";

describe("listing dashboard hidden listings", () => {
  it("keeps only unique valid listing ids", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";

    expect(savedHiddenListingIds({
      [LISTING_DASHBOARD_HIDDEN_IDS_KEY]: [first, "not-a-listing-id", first, second],
    })).toEqual([first, second]);
  });

  it("uses an empty list when the saved metadata is missing or malformed", () => {
    expect(savedHiddenListingIds(undefined)).toEqual([]);
    expect(savedHiddenListingIds({ [LISTING_DASHBOARD_HIDDEN_IDS_KEY]: "invalid" })).toEqual([]);
  });
});
