import { describe, expect, it } from "vitest";
import { rankedFilters } from "@/lib/email-index/ranked-filters";

describe("ranked index RPC filter mapping", () => {
  it("converts a date range to UTC start/end-exclusive timestamps, matching the existing queryIndex convention", () => {
    expect(rankedFilters({ ownerId: "owner-1", startDate: "2026-07-01", endDate: "2026-07-31" })).toEqual({
      p_owner_id: "owner-1", p_query: null, p_type: null, p_start_at: "2026-07-01T00:00:00Z", p_end_at: "2026-08-01T00:00:00Z",
    });
  });

  it("passes through a free-text query and type filter", () => {
    expect(rankedFilters({ ownerId: "owner-1", query: "asos order", type: "confirmation" })).toMatchObject({ p_query: "asos order", p_type: "confirmation" });
  });

  it("omits unset filters as null rather than undefined, so the RPC receives explicit defaults", () => {
    const filters = rankedFilters({ ownerId: "owner-1" });
    expect(filters).toEqual({ p_owner_id: "owner-1", p_query: null, p_type: null, p_start_at: null, p_end_at: null });
  });
});
