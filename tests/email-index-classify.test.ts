import { describe, expect, it } from "vitest";
import { classifyIndexedEmail, entityFromSender, extractMetadata } from "@/lib/email-index/classify";

describe("email metadata classification", () => {
  it.each([
    ["Order AC-563216 confirmed", "confirmation"],
    ["Thank you for placing an order with Pokémon Center!", "confirmation"],
    ["Your receipt for On Running Cloud Trainer", "confirmation"],
    ["Your Pokémon Center order is on its way!", "shipping"],
    ["Your order has been cancelled", "cancellation"],
    ["You’ve sold an item on Vinted", "sold"],
    ["Your refund has been processed", "refund"],
  ])("classifies %s", (subject, expected) => expect(classifyIndexedEmail(subject)).toBe(expected));

  it("extracts non-sensitive order fields from a subject", () => {
    expect(extractMetadata("Order AC-563216 confirmed - £163.95")).toEqual({ order_reference: "AC-563216", amount: 163.95, currency: "GBP" });
  });

  it("normalizes accents and UK spelling for reliable entity matching", () => {
    expect(entityFromSender("Pokémon Centre", "orders@example.com")).toBe("pokemon center");
  });
});
