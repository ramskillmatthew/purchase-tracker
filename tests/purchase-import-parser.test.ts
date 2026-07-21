import { describe, expect, it } from "vitest";
import { parseGeneralPurchaseEmail } from "@/lib/purchase-import/parser";

const base = { messageId: "mail-1", sender: "Pokémon Center <orders@example.com>", subject: "Thank you for placing an order with Pokémon Center!", date: "2026-07-15T20:48:00.000Z" };

describe("general purchase email parser", () => {
  it("extracts retailer, item, size, total and purchase date", () => {
    const result = parseGeneralPurchaseEmail({ ...base, text: "Order number: PC-12345\nItem: Pikachu Plush\nSize: Large\nOrder total: £24.99" });
    expect(result).toMatchObject({ purchased_from: "Pokémon Center", item_title: "Pikachu Plush", item_size: "Large", price_paid: 24.99, purchase_date: "2026-07-15", candidate_type: "general" });
  });
  it("uses N/A for a missing size and reports uncertainty", () => {
    const result = parseGeneralPurchaseEmail({ ...base, text: "Order PC-12345 confirmed\nItem: Pikachu Plush\nTotal paid: £24.99" });
    expect(result?.item_size).toBe("N/A");
    expect(result?.uncertainty_reasons).toContain("No size was found; N/A will be used.");
  });
  it("extracts an item from a conventional invoice table", () => {
    const result = parseGeneralPurchaseEmail({ ...base, sender: "Apple <no_reply@apple.com>", subject: "Your invoice from Apple.", text: "Invoice details\nDescription\niCloud+ with 2 TB\nQuantity\n1\nTotal £16.66" });
    expect(result).toMatchObject({ purchased_from: "Apple", item_title: "iCloud+ with 2 TB", price_paid: 16.66 });
  });
  it.each(["Your order has been cancelled", "Your order is on its way", "Your refund has been processed"])("rejects lifecycle mail: %s", subject => {
    expect(parseGeneralPurchaseEmail({ ...base, subject, text: "Order PC-12345 total £24.99" })).toBeNull();
  });
  it("rejects newsletters with purchase words only in boilerplate", () => {
    expect(parseGeneralPurchaseEmail({ ...base, subject: "Nach der Haarentfernung: die wichtigsten Basics", text: "Manage your order. Download a receipt from your account. Total paid £20.00" })).toBeNull();
  });
});
