import { describe, expect, it } from "vitest";
import { isPurchaseAvailableForSale } from "@/lib/purchase-availability";

describe("isPurchaseAvailableForSale", () => {
  it("REQUIREMENT: an in_stock purchase with no active sale link is available", () => {
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock" })).toBe(true);
  });

  it("REQUIREMENT: a no_longer_in_stock purchase is never available", () => {
    expect(isPurchaseAvailableForSale({ stock_status: "no_longer_in_stock" })).toBe(false);
  });

  it("REQUIREMENT: an in_stock purchase already linked to an active sale is not available", () => {
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock" }, { hasActiveSaleLink: true })).toBe(false);
  });

  it("an in_stock purchase explicitly marked as not linked is available", () => {
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock" }, { hasActiveSaleLink: false })).toBe(true);
  });

  it("REGRESSION: a no_longer_in_stock purchase stays unavailable even if hasActiveSaleLink is explicitly false — stock status alone is decisive there", () => {
    expect(isPurchaseAvailableForSale({ stock_status: "no_longer_in_stock" }, { hasActiveSaleLink: false })).toBe(false);
  });

  it("omitting the options argument defaults to 'no active link', matching the plain-arrival-agnostic explicit call", () => {
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock" })).toBe(isPurchaseAvailableForSale({ stock_status: "in_stock" }, { hasActiveSaleLink: false }));
  });
});

describe("DECISION: arrival never affects sale availability — an unarrived in-stock item is still sellable", () => {
  it("availability only reads stock_status — never `arrived` — so this compiles and behaves the same regardless of arrival state", () => {
    // isPurchaseAvailableForSale's parameter type is Pick<Purchase, "stock_status">
    // — it structurally cannot read `arrived` even if a caller passes a full
    // Purchase object carrying one. This is the documented guard against a
    // silently-added arrival restriction (see the function's own comment).
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock", arrived: null } as { stock_status: "in_stock" })).toBe(true);
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock", arrived: false } as { stock_status: "in_stock" })).toBe(true);
    expect(isPurchaseAvailableForSale({ stock_status: "in_stock", arrived: true } as { stock_status: "in_stock" })).toBe(true);
  });
});
