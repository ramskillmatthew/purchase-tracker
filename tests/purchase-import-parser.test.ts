import { describe, expect, it } from "vitest";
import { parseGeneralPurchaseEmail } from "@/lib/purchase-import/parser";

const base = { messageId: "mail-1", sender: "Pokémon Center <orders@example.com>", subject: "Thank you for placing an order with Pokémon Center!", date: "2026-07-15T20:48:00.000Z" };

describe("general purchase email parser", () => {
  it("extracts retailer, item, size, total and purchase date", () => {
    const result = parseGeneralPurchaseEmail({ ...base, text: "Order number: PC-12345\nItem: Pikachu Plush\nSize: Large\nOrder total: £24.99" });
    expect(result).toMatchObject({ purchasedFrom: "Pokémon Center", totalPaidPence: 2499, purchaseDate: "2026-07-15", candidateType: "general" });
    expect(result?.items).toEqual([{ description: "Pikachu Plush", size: "Large", condition: "Brand new", quantity: 1, linePricePence: null }]);
  });

  it("uses N/A for a missing size and reports uncertainty", () => {
    const result = parseGeneralPurchaseEmail({ ...base, text: "Order PC-12345 confirmed\nItem: Pikachu Plush\nTotal paid: £24.99" });
    expect(result?.items[0].size).toBe("N/A");
    expect(result?.uncertaintyReasons).toContain("No size was found; N/A will be used.");
  });

  it("REGRESSION: non-Vinted items always default to 'Brand new' condition", () => {
    const result = parseGeneralPurchaseEmail({ ...base, text: "Order number: PC-12345\nItem: Pikachu Plush\nSize: Large\nOrder total: £24.99" });
    expect(result?.items[0].condition).toBe("Brand new");
  });

  it("extracts an item from a conventional invoice table", () => {
    const result = parseGeneralPurchaseEmail({ ...base, sender: "Apple <no_reply@apple.com>", subject: "Your invoice from Apple.", text: "Invoice details\nDescription\niCloud+ with 2 TB\nQuantity\n1\nTotal £16.66" });
    expect(result).toMatchObject({ purchasedFrom: "Apple", totalPaidPence: 1666 });
    expect(result?.items[0].description).toBe("iCloud+ with 2 TB");
  });

  it.each(["Your order has been cancelled", "Your order is on its way", "Your refund has been processed"])("rejects lifecycle mail: %s", subject => {
    expect(parseGeneralPurchaseEmail({ ...base, subject, text: "Order PC-12345 total £24.99" })).toBeNull();
  });

  it("rejects newsletters with purchase words only in boilerplate", () => {
    expect(parseGeneralPurchaseEmail({ ...base, subject: "Nach der Haarentfernung: die wichtigsten Basics", text: "Manage your order. Download a receipt from your account. Total paid £20.00" })).toBeNull();
  });

  describe("multi-item structured extraction (REGRESSION — every qualifying line is captured, not just the first)", () => {
    it("REGRESSION: a structured order-summary section with more than one item line produces one entry per item, with individual prices when present", () => {
      const result = parseGeneralPurchaseEmail({
        ...base,
        sender: "Apple <no_reply@apple.com>", subject: "Your invoice from Apple.",
        text: "Order summary\nAppleCare+ for iPad £79.00\nUSB-C Charge Cable £19.00\nTotal £98.00",
      });
      expect(result?.items).toHaveLength(2);
      expect(result?.items.map(item => item.description)).toEqual(["AppleCare+ for iPad", "USB-C Charge Cable"]);
      expect(result?.items.map(item => item.linePricePence)).toEqual([7900, 1900]);
      expect(result?.totalPaidPence).toBe(9800);
    });

    it("flags uncertainty when multiple items are found but not every individual price could be confirmed", () => {
      const result = parseGeneralPurchaseEmail({
        ...base,
        sender: "Apple <no_reply@apple.com>", subject: "Your invoice from Apple.",
        text: "Order summary\nAppleCare+ for iPad\nUSB-C Charge Cable £19.00\nTotal £98.00",
      });
      expect(result?.items.length).toBeGreaterThan(1);
      expect(result?.uncertaintyReasons).toContain("Multiple items were found but not every individual price could be confirmed.");
    });
  });

  describe("discounts and delivery already reflected in the total (no separate line-item breakdown required)", () => {
    it("uses the stated order total even when it's lower than the sum of visible item lines (a discount was applied)", () => {
      const result = parseGeneralPurchaseEmail({ ...base, text: "Order number: PC-500\nItem: Pikachu Plush\nOrder total: £19.99" });
      expect(result?.totalPaidPence).toBe(1999);
    });
  });
});
