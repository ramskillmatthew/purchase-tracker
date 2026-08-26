import { describe, expect, it } from "vitest";
import { draftFor, type DraftSourceCandidate } from "@/lib/purchase-import/draft";

function candidate(overrides: Partial<DraftSourceCandidate> = {}): DraftSourceCandidate {
  return {
    purchased_from: "Vinted", candidate_type: "vinted", item_title: "Some jumper", seller_name: "seller123",
    item_size: "M", item_condition_hint: "Good condition from photos", price_paid: 12.5,
    purchase_date: "2026-01-02", email_date: "2026-01-02T10:00:00Z", draft: null,
    ...overrides,
  };
}

describe("draftFor", () => {
  it("REGRESSION: prefers a persisted draft over the parser's own fields when no in-memory edit exists yet (survives a page reload)", () => {
    const x = candidate({
      item_title: "Parser description", price_paid: 12.5,
      draft: { purchased_from: "Vinted", sku: "USER-SKU", item_description: "User-edited description", seller_name: "seller123", item_size: "L", item_condition: "Brand new", price_purchased: "19.99", order_date: "2026-01-05", arrived: "true" },
    });
    const result = draftFor(x);
    expect(result.item_description).toBe("User-edited description");
    expect(result.sku).toBe("USER-SKU");
    expect(result.item_size).toBe("L");
    expect(result.price_purchased).toBe("19.99");
    expect(result.order_date).toBe("2026-01-05");
    expect(result.arrived).toBe("true");
  });

  it("falls back to parser-derived defaults when there is no persisted draft", () => {
    const result = draftFor(candidate({ draft: null }));
    expect(result.item_description).toBe("Some jumper");
    expect(result.arrived).toBe("false");
    expect(result.sku).toBe("");
  });

  it("REGRESSION: never overrides an edit already live in the caller's in-memory state, even if a draft exists", () => {
    const old: ReturnType<typeof draftFor> = { selected: true, purchased_from: "Vinted", sku: "", item_description: "Currently being typed", seller_name: "", item_size: "M", item_condition: "Brand new", price_purchased: "10.00", order_date: "2026-01-02", arrived: "false" };
    const x = candidate({ draft: { purchased_from: "Vinted", sku: "SAVED", item_description: "Saved draft value", seller_name: "", item_size: "M", item_condition: "Brand new", price_purchased: "10.00", order_date: "2026-01-02", arrived: "false" } });
    expect(draftFor(x, old)).toBe(old);
  });

  it("non-Vinted candidates still default condition to Brand new and size to N/A when no draft or parser value is present", () => {
    const result = draftFor(candidate({ candidate_type: "general", item_size: null, item_condition_hint: null, draft: null }));
    expect(result.item_condition).toBe("Brand new");
    expect(result.item_size).toBe("N/A");
  });
});
