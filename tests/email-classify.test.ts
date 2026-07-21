import { describe, expect, it } from "vitest";
import {
  classifySubject, classifyQueryIntent, extractMetadata, entityFromSender,
  isPurchaseConfirmationSubject, isPurchaseCandidateSubject, isPurchaseLifecycleSubject, shouldInspectPurchaseHeader,
} from "@/lib/email/classify";

describe("shared email subject classification", () => {
  it.each([
    ["Order AC-563216 confirmed", "confirmation"],
    ["Thank you for placing an order with Pokémon Center!", "confirmation"],
    ["Your receipt for On Running Cloud Trainer", "confirmation"],
    ["Your Pokémon Center order is on its way!", "shipping"],
    ["Your order has been cancelled", "cancellation"],
    ["You’ve sold an item on Vinted", "sold"],
    ["Your refund has been processed", "refund"],
  ])("classifies %s", (subject, expected) => expect(classifySubject(subject)).toBe(expected));

  it("prefers delivery over shipping when a subject mentions both", () => {
    expect(classifySubject("Your order was dispatched and is now out for delivery")).toBe("delivery");
  });

  it("extracts non-sensitive order fields from a subject", () => {
    expect(extractMetadata("Order AC-563216 confirmed - £163.95")).toEqual({ order_reference: "AC-563216", amount: 163.95, currency: "GBP" });
  });

  it("normalizes accents and UK spelling for reliable entity matching", () => {
    expect(entityFromSender("Pokémon Centre", "orders@example.com")).toBe("pokemon center");
  });

  it("falls back to \"other\", not \"general\", for unrecognized subjects", () => {
    expect(classifySubject("Welcome to your new account")).toBe("other");
    expect(classifyQueryIntent(["welcome to your new account"])).toBe("other");
  });

  it("recognizes bare \"arrive\"/\"arrives\" as delivery, not only \"arrived\"/\"arriving\"", () => {
    expect(classifySubject("Your Dimplex order will arrive today")).toBe("delivery");
    expect(classifySubject("Your parcel arrives tomorrow")).toBe("delivery");
    expect(classifyQueryIntent(["when did my dimplex order arrive"])).toBe("delivery");
    expect(classifyQueryIntent(["when do my dimplex orders arrive"])).toBe("delivery");
  });
});

describe("free-text query intent classification", () => {
  it.each([
    ["Vinted solds emails", "sold"],
    ["order confirmations", "confirmation"],
    ["parcel tracking", "shipping"],
    ["delivered emails", "delivery"],
    ["cancelled orders", "cancellation"],
    ["refund emails", "refund"],
    ["did my order arrive", "delivery"],
    ["when will my order arrive", "delivery"],
    ["has my order arrived", "delivery"],
    ["my order is arriving", "delivery"],
  ])("classifies %s", (query, expected) => expect(classifyQueryIntent([query])).toBe(expected));
});

describe("retailer-independent purchase discovery", () => {
  it.each([
    "Order AC-563216 confirmed",
    "Thank you for placing an order with Pokémon Center!",
    "Thank you for your purchase",
    "Your order has been received",
    "Your order is confirmed",
    "Your purchase receipt",
    "Your receipt for New Balance trainers",
    "Order summary",
    "Order details",
    "Invoice 49210",
    "Thank you for your preorder",
    "Preorder confirmation",
    "Payment receipt",
  ])("accepts purchase confirmation: %s", subject => expect(isPurchaseConfirmationSubject(subject)).toBe(true));

  it.each([
    "Your order has been cancelled",
    "Your refund has been processed",
    "Your order is on its way",
    "A shipment from order 123 is on the way",
    "Your parcel was delivered",
    "Order update for Nike trainers",
    "This order is completed",
    "Your payment is being sent to your bank",
    "You've sold an item on Vinted",
    "Nach der Haarentfernung: die wichtigsten Basics",
    "Summer sale newsletter",
    "Welcome to your new account",
  ])("rejects non-purchase mail: %s", subject => expect(isPurchaseConfirmationSubject(subject)).toBe(false));

  it("recognizes lifecycle subjects independently of the confirmation gate", () => {
    expect(isPurchaseLifecycleSubject("Your order has been cancelled")).toBe(true);
    expect(isPurchaseLifecycleSubject("Your parcel was delivered")).toBe(true);
    expect(isPurchaseLifecycleSubject("Order AC-563216 confirmed")).toBe(false);
  });

  it("shortlists unfamiliar transactional wording for body validation", () => {
    expect(isPurchaseCandidateSubject("Important information about order 12345")).toBe(true);
    expect(isPurchaseCandidateSubject("Order update for trainers")).toBe(false);
    expect(isPurchaseCandidateSubject("Summer newsletter")).toBe(false);
  });

  it("inspects unfamiliar subjects for a named retailer without weakening broad mailbox scans", () => {
    expect(shouldInspectPurchaseHeader("We've got your request", true)).toBe(true);
    expect(shouldInspectPurchaseHeader("We've got your request", false)).toBe(false);
  });
});
