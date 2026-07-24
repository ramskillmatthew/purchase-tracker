import { describe, expect, it } from "vitest";
import { reconstructOrders } from "@/lib/orders/reconstruct";
import type { OrderSourceEmail } from "@/lib/orders/model";

const email = (id: string, sender: string, subject: string, date: string, text = ""): OrderSourceEmail => ({ id, sender, subject, date, text, html: "" });
const meaco = (id: string, subject: string, date: string, text = "") => email(id, "Meaco <orders@meaco.com>", subject, date, text);
const dimplex = (id: string, subject: string, date: string, text = "") => email(id, "Dimplex <orders@dimplex.co.uk>", subject, date, text);
const asos = (id: string, subject: string, date: string, text = "") => email(id, "ASOS <no-reply@asos.com>", subject, date, text);
const streetwear = (id: string, subject: string, date: string, text = "") => email(id, "Streetwear Direct <orders@streetweardirect.example>", subject, date, text);
const nimbus = (id: string, subject: string, date: string, text = "") => email(id, "Nimbus Electronics <orders@nimbuselectronics.example>", subject, date, text);

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

  describe("item quantity: evidence-priority selection, never summed across emails (REGRESSION)", () => {
    it("REGRESSION: the same '1 x Product A' repeated in confirmation, cancellation, and refund reconstructs as quantity 1, not 3", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-5005 confirmed", "2026-07-01T10:00:00Z", "Total paid £20.00\n1 x Product A"),
        meaco("2", "Your Meaco order MC-5005 has been cancelled", "2026-07-03T10:00:00Z", "1 x Product A"),
        meaco("3", "Refund confirmed for order MC-5005", "2026-07-05T10:00:00Z", "1 x Product A. £20.00 has been refunded"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].items).toEqual([{ name: "Product A", quantity: 1 }]);
    });

    it("falls back to the next lifecycle type in priority order when confirmation has no usable items", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-6006 confirmed", "2026-07-01T10:00:00Z", "Order details. Total paid £20.00"),
        meaco("2", "Your Meaco order MC-6006 has been dispatched", "2026-07-02T10:00:00Z", "2 x Product B"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].items).toEqual([{ name: "Product B", quantity: 2 }]);
    });

    it("takes the max, not the sum, when the same item appears across two confirmation-typed signals sharing an order reference", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-7007 confirmed", "2026-07-01T10:00:00Z", "1 x Product C"),
        meaco("2", "Your Meaco order MC-7007 confirmed", "2026-07-01T10:05:00Z", "1 x Product C"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].items).toEqual([{ name: "Product C", quantity: 1 }]);
    });

    it("sums same-named quantities found on separate lines within one single authoritative email", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-7008 confirmed", "2026-07-01T10:00:00Z", "1 x Product D\n2 x Product D")]);
      expect(orders).toHaveLength(1);
      expect(orders[0].items).toEqual([{ name: "Product D", quantity: 3 }]);
    });
  });

  describe("notes: deterministic, rule-based caveats", () => {
    it("notes a timing-based (non-reference) grouping when confidence is below 0.95", () => {
      const orders = reconstructOrders([
        dimplex("1", "Dimplex Order Confirmation", "2026-07-01T10:00:00Z", "Thank you for your order."),
        dimplex("2", "Your Dimplex order has been dispatched", "2026-07-03T10:00:00Z"),
      ]);
      expect(orders[0].notes).toContain("Grouped by timing, not a shared order reference — this pairing is inferred, not certain.");
    });

    it("does not add the timing-grouping note for a reference-anchored order", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-8001 confirmed", "2026-07-01T10:00:00Z")]);
      expect(orders[0].notes).not.toContain("Grouped by timing, not a shared order reference — this pairing is inferred, not certain.");
    });

    it("notes missing confirmation evidence for an orphaned reversal", () => {
      const orders = reconstructOrders([dimplex("1", "Your Dimplex order has been cancelled", "2026-07-03T10:00:00Z")]);
      expect(orders[0].notes).toContain("No order confirmation was found for this order — evidence is partial.");
    });

    it("notes an undetermined purchase price when only a refund is known", () => {
      const orders = reconstructOrders([meaco("1", "Refund confirmed for order MC-8002", "2026-07-05T10:00:00Z", "£45.00 has been refunded.")]);
      expect(orders[0].notes).toContain("Purchase price could not be determined.");
    });

    it("adds no notes at all for a complete, reference-anchored, fully-priced order", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-8003 confirmed", "2026-07-01T10:00:00Z", "Total paid £20.00")]);
      expect(orders[0].notes).toEqual([]);
    });
  });

  describe("isPreorder: phrase-based, confirmation evidence only", () => {
    it("detects a pre-order from confirmation content", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-9001 confirmed", "2026-07-01T10:00:00Z", "Your order is a pre-order and will ship when available.")]);
      expect(orders[0].isPreorder).toBe(true);
    });

    it("does not detect a pre-order from a non-confirmation email, even with matching phrasing", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-9002 confirmed", "2026-07-01T10:00:00Z", "Order details. Total paid £10.00"),
        meaco("2", "Your Meaco order MC-9002 has been dispatched", "2026-07-02T10:00:00Z", "Your order is a pre-order and will ship when available."),
      ]);
      expect(orders[0].isPreorder).toBe(false);
    });

    it("does not detect a pre-order from a bare 'preorder' mention in the confirmation", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-9003 confirmed", "2026-07-01T10:00:00Z", "Preorder now for our new collection!")]);
      expect(orders[0].isPreorder).toBe(false);
    });
  });

  describe("paymentCards: union across the order's emails, never collapsed to one", () => {
    it("collects every distinct card mentioned across different source emails", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-9101 confirmed", "2026-07-01T10:00:00Z", "Paid with card ending 0428."),
        meaco("2", "Refund confirmed for order MC-9101", "2026-07-05T10:00:00Z", "Refunded to card ending 1234."),
      ]);
      expect(orders[0].paymentCards).toEqual(["0428", "1234"]);
    });

    it("is an empty array when no card is ever mentioned", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-9102 confirmed", "2026-07-01T10:00:00Z")]);
      expect(orders[0].paymentCards).toEqual([]);
    });
  });

  describe("a referenced confirmation merges with a reference-less lifecycle email from the same merchant (REGRESSION — the exact reported ASOS bug)", () => {
    it("REGRESSION: merges a referenced order confirmation with a reference-less shipment notice into one order, keeping the confirmation's item/price detail alongside the shipment's dispatched status", () => {
      const orders = reconstructOrders([
        asos("1", "Your ASOS order AC-563216 confirmed", "2026-07-01T10:00:00Z", "Total paid £89.99\n1 x Nike Air Max Trainers"),
        asos("2", "Your order has been dispatched", "2026-07-03T10:00:00Z", "Track your parcel here."),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe("AC-563216");
      expect(orders[0].items).toEqual([{ name: "Nike Air Max Trainers", quantity: 1 }]);
      expect(orders[0].purchaseAmount).toBe(89.99);
      expect(orders[0].status).toBe("dispatched");
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "dispatched"]);
      expect(orders[0].sourceEmails).toEqual(["1", "2"]);
    });

    it("generalizes to a second, unrelated merchant: confirmation + reference-less delivery + reference-less refund all merge into one order", () => {
      const orders = reconstructOrders([
        streetwear("1", "Your Streetwear Direct order SD-9001 confirmed", "2026-07-01T10:00:00Z", "Total paid £64.00\n1 x Retro Hoodie"),
        streetwear("2", "Your parcel has been delivered", "2026-07-04T10:00:00Z", ""),
        streetwear("3", "Your refund has been processed", "2026-07-10T10:00:00Z", "£64.00 has been refunded."),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe("SD-9001");
      expect(orders[0].items).toEqual([{ name: "Retro Hoodie", quantity: 1 }]);
      expect(orders[0].purchaseAmount).toBe(64);
      expect(orders[0].refundAmount).toBe(64);
      expect(orders[0].status).toBe("refund_processed");
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "delivered", "refund_processed"]);
    });

    it("generalizes to a third, unrelated merchant: confirmation + reference-less cancellation + reference-less refund all merge into one order", () => {
      const orders = reconstructOrders([
        nimbus("1", "Your Nimbus Electronics order NE-4471 confirmed", "2026-07-01T10:00:00Z", "Total paid £45.00\n1 x Wireless Charger"),
        nimbus("2", "Your order has been cancelled", "2026-07-03T10:00:00Z", ""),
        nimbus("3", "Your refund has been processed", "2026-07-05T10:00:00Z", "£45.00 has been refunded."),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe("NE-4471");
      expect(orders[0].purchaseAmount).toBe(45);
      expect(orders[0].refundAmount).toBe(45);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "cancelled", "refund_processed"]);
    });

    it("does not merge a reference-less shipment into a referenced order that has already been reversed (cancelled)", () => {
      const orders = reconstructOrders([
        asos("1", "Your ASOS order AC-777 confirmed", "2026-06-01T10:00:00Z", "1 x Product X"),
        asos("2", "Your ASOS order AC-777 has been cancelled", "2026-06-02T10:00:00Z"),
        asos("3", "Your order has been dispatched", "2026-06-03T10:00:00Z", ""),
      ]);
      const byId = new Map(orders.map(order => [order.orderId, order]));
      expect(byId.get("AC-777")?.timeline.map(event => event.type)).toEqual(["ordered", "cancelled"]);
      // The reference-less dispatch notice (arriving after the referenced
      // order was already cancelled) cannot continue it — canContinue
      // forbids any forward stage after a reversal — so it becomes its own
      // separate, partial-evidence order instead of being silently dropped
      // or wrongly attached.
      expect(orders).toHaveLength(2);
    });

    it("still keeps two distinct referenced orders from the same merchant separate, even when a reference-less shipment could plausibly match either by timing", () => {
      const orders = reconstructOrders([
        asos("1", "Your ASOS order AC-100 confirmed", "2026-07-01T10:00:00Z"),
        asos("2", "Your ASOS order AC-200 confirmed", "2026-07-02T10:00:00Z"),
        asos("3", "Your order has been dispatched", "2026-07-03T10:00:00Z", ""),
      ]);
      const byId = new Map(orders.map(order => [order.orderId, order]));
      expect(orders).toHaveLength(2);
      // The reference-less dispatch attaches to the most recently active
      // open slot — AC-200, opened last — leaving AC-100 with just its
      // confirmation, rather than guessing wrong or duplicating the event
      // onto both.
      expect(byId.get("AC-200")?.timeline.map(event => event.type)).toEqual(["ordered", "dispatched"]);
      expect(byId.get("AC-100")?.timeline.map(event => event.type)).toEqual(["ordered"]);
    });
  });

  describe("timeline audit: only real, evidence-backed events ever appear — never a synthesized/invented stage (REGRESSION guard)", () => {
    it("shows exactly Ordered and Cancelled when that's the entire evidence — never a fabricated Dispatched/Delivered/Refunded in between", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-6001 confirmed", "2026-07-01T10:00:00Z"),
        meaco("2", "Your Meaco order MC-6001 has been cancelled", "2026-07-03T10:00:00Z"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "cancelled"]);
    });

    it("shows exactly Ordered alone when no other lifecycle email was ever retrieved — never a guessed Dispatched or Delivered", () => {
      const orders = reconstructOrders([meaco("1", "Your Meaco order MC-6002 confirmed", "2026-07-01T10:00:00Z")]);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered"]);
    });

    it("every timeline event traces back to one of the order's own source emails — the timeline is never longer than the evidence that produced it", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-6003 confirmed", "2026-07-01T10:00:00Z"),
        meaco("2", "Your Meaco order MC-6003 has been dispatched", "2026-07-02T10:00:00Z"),
        meaco("3", "Your Meaco order MC-6003 has been delivered", "2026-07-04T10:00:00Z"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].timeline.length).toBeLessThanOrEqual(orders[0].sourceEmails.length);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "dispatched", "delivered"]);
    });

    it("a delivered-then-cancelled order shows both real events and ends on the reversal — never silently dropping the earlier delivery or inventing a refund that was never evidenced", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-6004 confirmed", "2026-07-01T10:00:00Z"),
        meaco("2", "Your Meaco order MC-6004 has been delivered", "2026-07-03T10:00:00Z"),
        meaco("3", "Your Meaco order MC-6004 has been cancelled", "2026-07-05T10:00:00Z"),
      ]);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "delivered", "cancelled"]);
      expect(orders[0].status).toBe("cancelled");
    });
  });

  describe("refund lifecycle consistency: a reversal carrying its own distinct case/RMA reference still merges into the order it belongs to (REGRESSION)", () => {
    it("REGRESSION: a refund email mentioning only its own 'Refund reference RF-9001' (not the order's own MC-2002) still merges into the cancelled order instead of splitting into a disconnected orphan", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-2002 confirmed", "2026-07-01T10:00:00Z", "Total paid £45.00\n1 x Product A"),
        meaco("2", "Your Meaco order MC-2002 has been cancelled", "2026-07-03T10:00:00Z", ""),
        meaco("3", "Your refund has been processed", "2026-07-05T10:00:00Z", "Refund reference RF-9001. £45.00 has been refunded to your card."),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe("MC-2002");
      expect(orders[0].purchaseAmount).toBe(45);
      expect(orders[0].refundAmount).toBe(45);
      expect(orders[0].status).toBe("refund_processed");
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "cancelled", "refund_processed"]);
    });

    it("still opens a genuinely new order for an unmatched reference when no compatible open order exists at all", () => {
      const orders = reconstructOrders([meaco("1", "Your refund has been processed", "2026-07-05T10:00:00Z", "Refund reference RF-9001. £45.00 has been refunded to your card.")]);
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe("RF-9001");
      expect(orders[0].timeline.map(event => event.type)).toEqual(["refund_processed"]);
    });

    it("does not let an unmatched-reference reversal attach across a merchant boundary or to an already-terminal, incompatible order", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-3001 confirmed", "2026-06-01T10:00:00Z"),
        meaco("2", "Your Meaco order MC-3001 has been delivered", "2026-06-03T10:00:00Z"),
        meaco("3", "Your Meaco order MC-3001 has been cancelled", "2026-06-05T10:00:00Z"),
        // A dispatch notice (forward stage, not a reversal) with an
        // unmatched reference must NOT use the reversal fallback — it opens
        // its own order rather than incorrectly attaching to the already-
        // cancelled MC-3001.
        meaco("4", "Your order has shipped", "2026-06-10T10:00:00Z", "Shipment ref SHIP-777"),
      ]);
      const byId = new Map(orders.map(order => [order.orderId, order]));
      expect(orders).toHaveLength(2);
      expect(byId.get("MC-3001")?.timeline.map(event => event.type)).toEqual(["ordered", "delivered", "cancelled"]);
      expect(byId.get("SHIP-777")?.timeline.map(event => event.type)).toEqual(["dispatched"]);
    });

    it("a genuine second order's own referenced confirmation is never absorbed by the fallback (confirmations are never reversal-type)", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-4001 confirmed", "2026-07-01T10:00:00Z"),
        meaco("2", "Your Meaco order MC-4001 has been cancelled", "2026-07-02T10:00:00Z"),
        meaco("3", "Your Meaco order MC-4002 confirmed", "2026-07-03T10:00:00Z"),
      ]);
      expect(orders).toHaveLength(2);
      const byId = new Map(orders.map(order => [order.orderId, order]));
      expect(byId.get("MC-4001")?.timeline.map(event => event.type)).toEqual(["ordered", "cancelled"]);
      expect(byId.get("MC-4002")?.timeline.map(event => event.type)).toEqual(["ordered"]);
    });
  });

  describe("'return' lifecycle events reconstruct correctly (REGRESSION — 'returned' was previously unreachable, since no email ever classified as a return)", () => {
    it("REGRESSION: a genuine return email produces a 'returned' timeline event and merges with its order via a shared reference", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-8001 confirmed", "2026-07-01T10:00:00Z", "Total paid £30.00\n1 x Product Z"),
        meaco("2", "Your Meaco order MC-8001 has been delivered", "2026-07-03T10:00:00Z"),
        meaco("3", "We've received your return for order MC-8001", "2026-07-10T10:00:00Z"),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "delivered", "returned"]);
      expect(orders[0].status).toBe("returned");
    });

    it("a return followed by a refund shows both real reversal events in order", () => {
      const orders = reconstructOrders([
        meaco("1", "Your Meaco order MC-8002 confirmed", "2026-07-01T10:00:00Z", "Total paid £30.00"),
        meaco("2", "We've received your return for order MC-8002", "2026-07-10T10:00:00Z"),
        meaco("3", "Your refund has been processed for order MC-8002", "2026-07-12T10:00:00Z", "£30.00 has been refunded."),
      ]);
      expect(orders).toHaveLength(1);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["ordered", "returned", "refund_processed"]);
    });

    it("a standalone return email with no confirmation ever retrieved still becomes a partial-evidence order, not silently dropped", () => {
      const orders = reconstructOrders([meaco("1", "Your return has been received", "2026-07-10T10:00:00Z", "")]);
      expect(orders).toHaveLength(1);
      expect(orders[0].timeline.map(event => event.type)).toEqual(["returned"]);
    });
  });
});
