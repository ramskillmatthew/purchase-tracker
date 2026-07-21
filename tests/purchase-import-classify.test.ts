import { describe, expect, it } from "vitest";
import { isPurchaseCandidateSubject, isPurchaseConfirmationSubject, shouldInspectPurchaseHeader } from "@/lib/purchase-import/classify";

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
