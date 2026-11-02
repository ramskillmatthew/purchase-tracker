import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest: vi.fn(), supabaseRequestAll: vi.fn() }));

import { supabaseRequestAll } from "@/lib/supabase";
import { findInventoryLinkCandidates, scoreInventoryCandidate } from "@/lib/listing-studio/inventory-link";

const requestAllMock = vi.mocked(supabaseRequestAll);

describe("imported eBay stock matching", () => {
  it("strongly matches the same product while rejecting unrelated stock", () => {
    const same = scoreInventoryCandidate("New Balance 530 White Silver Navy UK 5.5", "New Balance 530 white silver navy size 5.5");
    const unrelated = scoreInventoryCandidate("New Balance 530 White Silver Navy UK 5.5", "Pokemon Scarlet Violet booster box");
    expect(same).toBeGreaterThan(0.8);
    expect(unrelated).toBe(0);
  });

  it("only searches the signed-in owner's in-stock purchases", async () => {
    requestAllMock.mockResolvedValue([]);
    await findInventoryLinkCandidates("owner-123", "New Balance 530", 20);
    expect(requestAllMock).toHaveBeenCalledWith(expect.stringContaining("owner_id=eq.owner-123&stock_status=eq.in_stock"));
  });
});
