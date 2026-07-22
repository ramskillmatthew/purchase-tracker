import { describe, expect, it } from "vitest";
import { extractAmount, extractItems, extractMerchant, extractOrderReference, extractTrackingNumbers, parseSenderDisplay } from "@/lib/orders/extract";

describe("extractOrderReference", () => {
  it("extracts a reference following 'order'/'ref' from the subject", () => {
    expect(extractOrderReference("Your order MC-1001 has been dispatched", "")).toBe("MC-1001");
    expect(extractOrderReference("Ref: AC-563216", "")).toBe("AC-563216");
  });

  it("falls back to the body when the subject has no reference", () => {
    expect(extractOrderReference("Order update", "Your order PC-9 has shipped")).toBe("PC-9");
  });

  it("does not prefix-match into an unrelated longer word (e.g. 'refunded')", () => {
    expect(extractOrderReference("Your refund", "£45.00 has been refunded to your card.")).toBeNull();
  });

  it("does not capture an ordinary English word like 'Confirmation' as a reference — a real reference must contain a digit", () => {
    expect(extractOrderReference("Order Confirmation", "Thank you for your order.")).toBeNull();
  });

  it("finds a digit-bearing reference elsewhere in the text when a different order/ref-labelled candidate lacked one", () => {
    // "Order Confirmation" alone is not a usable reference (no digit); a
    // second, separately labelled candidate elsewhere is used instead.
    expect(extractOrderReference("Order Confirmation. Ref: MC-1001.", "")).toBe("MC-1001");
  });

  it("returns null rather than a false positive when the only order/ref-labelled text is an ordinary word with no second candidate", () => {
    expect(extractOrderReference("Order Confirmation - MC-1001", "")).toBeNull();
  });

  it("returns null when there is no order/ref-labelled text anywhere", () => {
    expect(extractOrderReference("Weekly newsletter", "Check out this week's deals")).toBeNull();
  });
});

describe("extractAmount", () => {
  it("extracts a £ amount", () => { expect(extractAmount("Total paid £45.00")).toEqual({ amount: 45, currency: "GBP" }); });
  it("extracts a GBP-prefixed amount", () => { expect(extractAmount("GBP 12.50 refunded")).toEqual({ amount: 12.5, currency: "GBP" }); });
  it("returns nulls when there is no amount", () => { expect(extractAmount("No money mentioned here")).toEqual({ amount: null, currency: null }); });
});

describe("extractTrackingNumbers", () => {
  it("extracts a tracking number when labelled", () => { expect(extractTrackingNumbers("Your tracking number: ABC123XYZ9")).toEqual(["ABC123XYZ9"]); });
  it("does not treat an order reference or unrelated code as a tracking number without the word 'tracking' nearby", () => { expect(extractTrackingNumbers("Order MC-1001 confirmed. Reference ABC123XYZ9.")).toEqual([]); });
});

describe("extractItems", () => {
  it("extracts an 'Item:' labelled line", () => { expect(extractItems("Order details\nItem: Poké Ball Plus\nQuantity: 1")).toContain("Poké Ball Plus"); });
  it("extracts 'N x <item>' patterns", () => { expect(extractItems("1 x Dimplex Heater\n2 x Remote Control")).toEqual(expect.arrayContaining(["Dimplex Heater", "Remote Control"])); });
  it("returns an empty array when nothing matches", () => { expect(extractItems("Thank you for your order.")).toEqual([]); });
});

describe("parseSenderDisplay", () => {
  it("splits a display-form sender into name and address", () => { expect(parseSenderDisplay("Meaco <orders@meaco.com>")).toEqual({ name: "Meaco", email: "orders@meaco.com" }); });
  it("treats a bare email address as email-only", () => { expect(parseSenderDisplay("orders@meaco.com")).toEqual({ name: null, email: "orders@meaco.com" }); });
  it("treats a bare name with no angle brackets as name-only", () => { expect(parseSenderDisplay("Meaco")).toEqual({ name: "Meaco", email: null }); });
});

describe("extractMerchant", () => {
  it("normalizes a display-form sender to the same entity as classify.ts's entityFromSender would", () => {
    expect(extractMerchant("Pokémon Center <orders@example.com>")).toBe("pokemon center");
    expect(extractMerchant("Pokemon Centre <orders@example.com>")).toBe("pokemon center");
  });
  it("falls back to the email domain when there is no display name", () => {
    expect(extractMerchant("orders@meaco.com")).toBe("meaco");
  });
});
