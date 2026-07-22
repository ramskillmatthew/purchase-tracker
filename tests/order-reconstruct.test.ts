import { describe, expect, it } from "vitest";
import { reconstructOrders } from "@/lib/orders/reconstruct";
import type { OrderSourceEmail } from "@/lib/orders/model";

const email = (id: string, sender: string, subject: string, date: string, text = ""): OrderSourceEmail => ({ id, sender, subject, date, text, html: "" });
const meaco = (id: string, subject: string, date: string, text = "") => email(id, "Meaco <orders@meaco.com>", subject, date, text);
const dimplex = (id: string, subject: string, date: string, text = "") => email(id, "Dimplex <orders@dimplex.co.uk>", subject, date, text);

describe("reconstructOrders", () => {
  it("groups multiple emails sharing an order reference into one order with a full timeline", () => {
    const orders = reconstructOrders([
      meaco("1", "Your Meaco order MC-1001 confirmed", "2026-07-01T10:00:00Z"),
      meaco("2", "Your Meaco order MC-1001 has been dispatched", "2026-07-02T10:00:00Z"),
      meaco("3", "Your Meaco order MC-1001 has been delivered", "2026-07-04T10:00:00Z"),
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe("MC-1001");
    expect(orders[0].merchant).toBe("meaco");
    expect(orders[0].status).toBe("delivered");
    expect(orders[0].purchaseDate).toBe("2026-07-01T10:00:00Z");
    expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "dispatched", "delivered"]);
    expect(orders[0].sourceEmails).toEqual(["1", "2", "3"]);
  });

  it("keeps multiple orders from the same merchant separate when they have distinct order references", () => {
    const orders = reconstructOrders([
      meaco("1", "Your Meaco order MC-1001 confirmed", "2026-07-01T10:00:00Z"),
      meaco("2", "Your Meaco order MC-2002 confirmed", "2026-07-02T10:00:00Z"),
      meaco("3", "Your Meaco order MC-1001 has been dispatched", "2026-07-03T10:00:00Z"),
    ]);
    expect(orders).toHaveLength(2);
    const byId = new Map(orders.map(order => [order.orderId, order]));
    expect(byId.get("MC-1001")?.timeline.map(event => event.type)).toEqual(["ordered", "dispatched"]);
    expect(byId.get("MC-2002")?.timeline.map(event => event.type)).toEqual(["ordered"]);
  });

  it("builds a partial timeline from a single lifecycle email with no confirmation ever retrieved", () => {
    const orders = reconstructOrders([meaco("1", "Your Meaco order MC-3003 has been dispatched", "2026-07-02T10:00:00Z")]);
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe("MC-3003");
    expect(orders[0].timeline.map(event => event.type)).toEqual(["dispatched"]);
    expect(orders[0].status).toBe("dispatched");
    // No "ordered" event was ever seen — purchaseDate falls back to the one
    // event we do have, not a fabricated earlier date.
    expect(orders[0].purchaseDate).toBe("2026-07-02T10:00:00Z");
  });

  it("groups reference-less emails from the same merchant by the merchant+date heuristic when a confirmation opened the order", () => {
    const orders = reconstructOrders([
      dimplex("1", "Dimplex Order Confirmation", "2026-07-01T10:00:00Z", "Thank you for your order."),
      dimplex("2", "Your Dimplex order has been dispatched", "2026-07-03T10:00:00Z"),
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBeNull();
    expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "dispatched"]);
  });

  it("never merges two reference-less confirmations from the same merchant — each confirmation always starts a new order", () => {
    const orders = reconstructOrders([
      dimplex("1", "Dimplex Order Confirmation", "2026-06-01T10:00:00Z", "Thank you for your order."),
      dimplex("2", "Dimplex Order Confirmation", "2026-07-10T10:00:00Z", "Thank you for your order."),
    ]);
    expect(orders).toHaveLength(2);
    for (const order of orders) expect(order.timeline.map(event => event.type)).toEqual(["ordered"]);
  });

  it("does not create duplicate timeline entries or duplicate source emails when the same email is present more than once", () => {
    const confirmation = meaco("dup", "Your Meaco order MC-5005 confirmed", "2026-07-01T10:00:00Z");
    const dispatch = meaco("dup2", "Your Meaco order MC-5005 has been dispatched", "2026-07-02T10:00:00Z");
    const orders = reconstructOrders([confirmation, confirmation, dispatch]);
    expect(orders).toHaveLength(1);
    expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "dispatched"]);
    expect(orders[0].sourceEmails).toEqual(["dup", "dup2"]);
  });

  it("reconstructs a cancel+refund order with the refund amount, and does not let cancellation-rights boilerplate on the confirmation trigger a false cancellation", () => {
    const orders = reconstructOrders([
      email("1", "Pokemon Center <orders@pokemoncenter.com>", "Your Pokémon Center order PC-9 confirmed", "2026-07-01T10:00:00Z", "Order details. You have the right to cancel within 14 days under the Consumer Contracts Regulations."),
      email("2", "Pokemon Center <orders@pokemoncenter.com>", "Your Pokémon Center order PC-9 has been cancelled", "2026-07-03T10:00:00Z"),
      email("3", "Pokemon Center <orders@pokemoncenter.com>", "Refund confirmed for order PC-9", "2026-07-05T10:00:00Z", "£45.00 has been refunded to your card."),
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "cancelled", "refund_processed"]);
    expect(orders[0].status).toBe("refund_processed");
    expect(orders[0].refundAmount).toBe(45);
    expect(orders[0].currency).toBe("GBP");
  });

  it("reconstructs a dispatch+delivery order with a delivered final status", () => {
    const orders = reconstructOrders([
      meaco("1", "Your Meaco order MC-7007 confirmed", "2026-07-01T10:00:00Z"),
      meaco("2", "Your Meaco order MC-7007 has been dispatched", "2026-07-02T10:00:00Z"),
      meaco("3", "Your Meaco order MC-7007 has been delivered", "2026-07-04T10:00:00Z"),
    ]);
    expect(orders[0].status).toBe("delivered");
    expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "dispatched", "delivered"]);
  });

  it("never merges orders from different merchants, even with matching order references", () => {
    const orders = reconstructOrders([
      meaco("1", "Your Meaco order AB-1234 confirmed", "2026-07-01T10:00:00Z"),
      dimplex("2", "Your Dimplex order AB-1234 confirmed", "2026-07-01T10:00:00Z"),
    ]);
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map(order => order.merchant))).toEqual(new Set(["meaco", "dimplex"]));
    for (const order of orders) expect(order.sourceEmails).toHaveLength(1);
  });

  it("REGRESSION: two separate reference-less orders from the same merchant (cancel+refund vs. dispatch+delivery) are never merged", () => {
    const orders = reconstructOrders([
      meaco("a1", "Meaco Order Confirmation", "2026-06-01T10:00:00Z", "Thank you for your order."),
      meaco("a2", "Your Meaco order has been cancelled", "2026-06-03T10:00:00Z"),
      meaco("a3", "Refund confirmed", "2026-06-05T10:00:00Z", "£30.00 has been refunded."),
      meaco("b1", "Meaco Order Confirmation", "2026-07-01T10:00:00Z", "Thank you for your order."),
      meaco("b2", "Your Meaco order has been dispatched", "2026-07-03T10:00:00Z"),
      meaco("b3", "Your Meaco order has been delivered", "2026-07-05T10:00:00Z"),
    ]);

    expect(orders).toHaveLength(2);
    const cancelledOrder = orders.find(order => order.status === "refund_processed");
    const deliveredOrder = orders.find(order => order.status === "delivered");
    expect(cancelledOrder).toBeDefined();
    expect(deliveredOrder).toBeDefined();

    // Each timeline contains only its own events — no cross-contamination.
    expect(cancelledOrder!.timeline.map(event => event.type)).toEqual(["ordered", "cancelled", "refund_processed"]);
    expect(deliveredOrder!.timeline.map(event => event.type)).toEqual(["ordered", "dispatched", "delivered"]);
    expect(cancelledOrder!.sourceEmails).toEqual(["a1", "a2", "a3"]);
    expect(deliveredOrder!.sourceEmails).toEqual(["b1", "b2", "b3"]);

    // No refund/delivery event bled into the other order.
    expect(deliveredOrder!.timeline.some(event => event.type === "cancelled" || event.type === "refund_processed")).toBe(false);
    expect(cancelledOrder!.timeline.some(event => event.type === "dispatched" || event.type === "delivered")).toBe(false);
    expect(cancelledOrder!.refundAmount).toBe(30);
    expect(deliveredOrder!.refundAmount).toBeNull();
  });

  it("returns an empty array for no input and never throws on emails with no lifecycle signal at all", () => {
    expect(reconstructOrders([])).toEqual([]);
    expect(reconstructOrders([email("1", "Newsletter <news@example.com>", "This week's deals", "2026-07-01T10:00:00Z")])).toEqual([]);
  });

  it("produces zero reconstructed orders for a mailbox containing only unrelated merchant emails (account setup, marketing) — never fabricates a purchase", () => {
    const orders = reconstructOrders([
      email("1", "ASOS <noreply@asos.com>", "Your ASOS account is set up", "2026-05-06T10:00:00Z", "Welcome! Track your orders, manage your wishlist and more."),
      email("2", "ASOS <noreply@asos.com>", "20% off everything this weekend", "2026-05-08T10:00:00Z", "Shop the sale now."),
      email("3", "ASOS <noreply@asos.com>", "New in: this week's arrivals", "2026-05-10T10:00:00Z", "Check out what's new."),
    ]);
    expect(orders).toEqual([]);
  });

  it("only recognizes genuine order-lifecycle evidence when a newer account-creation email and an older genuine order both exist — the account email never becomes a reconstructed order even though it's present in the input", () => {
    const orders = reconstructOrders([
      email("older", "ASOS Sample Sale <orders@asos.com>", "Your ASOS order AC-563216", "2026-05-03T10:00:00Z", "Order details. Total paid £24.00"),
      email("newer", "ASOS <noreply@asos.com>", "Your ASOS account is set up", "2026-05-06T10:00:00Z", "Welcome! Track your orders, manage your wishlist and more."),
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].sourceEmails).toEqual(["older"]);
    expect(orders[0].orderId).toBe("AC-563216");
  });

  it("treats a Vinted sold-item email as its own standalone pseudo-order, not a purchase order", () => {
    const orders = reconstructOrders([email("1", "Team Vinted <no-reply@vinted.com>", "You've sold an item on Vinted", "2026-07-01T10:00:00Z")]);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("sold");
    expect(orders[0].orderId).toBeNull();
  });

  describe("purchaseAmount is tracked separately from refundAmount", () => {
    it("captures both the purchase price (from the confirmation) and the refund amount (from the refund) as distinct fields", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-1001 confirmed", "2026-07-01T10:00:00Z", "Order details. Total paid £629.99"),
        meaco("2", "Your Meaco order MC-1001 has been cancelled", "2026-07-03T10:00:00Z"),
        meaco("3", "Refund confirmed for order MC-1001", "2026-07-05T10:00:00Z", "£629.99 has been refunded"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].purchaseAmount).toBe(629.99);
      expect(orders[0].refundAmount).toBe(629.99);
      expect(orders[0].currency).toBe("GBP");
    });

    it("leaves purchaseAmount null when only a refund email was ever retrieved — the exact reported bug scenario — instead of fabricating or conflating it with the refund amount", () => {
      const orders = reconstructOrders([meaco("1", "Refund confirmed for order MC-2002", "2026-07-05T10:00:00Z", "£539.99 has been refunded to your card.")]);
      expect(orders).toHaveLength(1);
      expect(orders[0].purchaseAmount).toBeNull();
      expect(orders[0].refundAmount).toBe(539.99);
    });

    it("leaves refundAmount null when only a confirmation was ever retrieved", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-3003 confirmed", "2026-07-01T10:00:00Z", "Order details. Total paid £45.00")]);
      expect(orders).toHaveLength(1);
      expect(orders[0].purchaseAmount).toBe(45);
      expect(orders[0].refundAmount).toBeNull();
    });

    it("leaves both null when no email in the group mentions an amount", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-4004 has been dispatched", "2026-07-02T10:00:00Z")]);
      expect(orders).toHaveLength(1);
      expect(orders[0].purchaseAmount).toBeNull();
      expect(orders[0].refundAmount).toBeNull();
    });
  });
});
