import { describe, expect, it } from "vitest";
import { classifySubject } from "@/lib/email/classify";
import { matchesLifecycleEvidence } from "@/lib/email/lifecycle-evidence";

// A single fixture of Pokémon Center mail reused across the count/hybrid
// regression tests: a clean cancellation, an unrelated confirmation, an
// unrelated marketing email, and — the exact shape of the reported bug — a
// cancellation whose subject is too generic to classify on its own and only
// states the cancellation in the body.
const fixture = {
  explicitCancellation: { subject: "Your Pokémon Center order has been cancelled", body: "" },
  confirmation: { subject: "Thank you for your Pokémon Center order", body: "Order details. Total paid £45.00" },
  marketing: { subject: "New Pokémon Center arrivals this week", body: "Shop the latest collection" },
  genericSubjectBodyCancelled: { subject: "Update on your Pokémon Center order PC-4471", body: "Unfortunately one item in your order has been cancelled and will not be shipped." },
  // The exact shape of the "20 matching emails" regression: an ordinary
  // confirmation whose standard UK consumer-rights footer happens to mention
  // "cancellation" without any order actually being cancelled.
  confirmationWithCancellationBoilerplate: {
    subject: "Thank you for your Pokémon Center order",
    body: "Order details. Total paid £45.00. You have the right to cancel this order within 14 days under the Consumer Contracts Regulations. For more information see our cancellation policy and instructions on how to cancel.",
  },
  shippingWithRefundBoilerplate: {
    subject: "Your Pokémon Center order has been dispatched",
    body: "Track your parcel here. If the item is faulty you may be eligible for a refund — see our refund policy for how to request a refund; refunds may take 5-10 business days.",
  },
};
const content = (email: { subject: string; body: string }) => `${email.subject} ${email.body}`;

describe("matchesLifecycleEvidence", () => {
  it("detects an explicit cancellation subject", () => {
    expect(matchesLifecycleEvidence("cancellation", content(fixture.explicitCancellation))).toBe(true);
  });

  it("detects a cancellation stated only in the body, behind a generic subject line", () => {
    expect(matchesLifecycleEvidence("cancellation", content(fixture.genericSubjectBodyCancelled))).toBe(true);
    // classifySubject (subject-only) is exactly what missed this before — it
    // has no way to see the body, so it cannot classify this as a
    // cancellation from the subject alone. This is the parity gap fixed.
    expect(classifySubject(fixture.genericSubjectBodyCancelled.subject)).not.toBe("cancellation");
  });

  it("does not count an unrelated confirmation or marketing email as a cancellation", () => {
    expect(matchesLifecycleEvidence("cancellation", content(fixture.confirmation))).toBe(false);
    expect(matchesLifecycleEvidence("cancellation", content(fixture.marketing))).toBe(false);
  });

  it("still matches refund, sold, and forward-lifecycle evidence from body content", () => {
    expect(matchesLifecycleEvidence("refund", "Order update: your refund has been processed")).toBe(true);
    expect(matchesLifecycleEvidence("sold", "Team Vinted: you've sold an item")).toBe(true);
    expect(matchesLifecycleEvidence("delivery", "Order note: your parcel is expected today")).toBe(true);
  });

  it("applies no restriction for an unmapped/other type", () => {
    expect(matchesLifecycleEvidence("other", "anything at all")).toBe(true);
  });

  describe("cancellation: distinguishes a genuine event from policy/rights boilerplate", () => {
    it("does not count standard cancellation-rights/policy boilerplate on an ordinary confirmation", () => {
      expect(matchesLifecycleEvidence("cancellation", content(fixture.confirmationWithCancellationBoilerplate))).toBe(false);
    });
    it.each([
      ["cancellation-policy boilerplate alone", "For details see our cancellation policy."],
      ["right-to-cancel wording alone", "You have the right to cancel this order within 14 days."],
      ["cooling-off period wording", "This is covered by a 14-day cooling-off period."],
      ["Consumer Contracts Regulations wording", "Under the Consumer Contracts Regulations you may cancel your order."],
      ["instructions on how to cancel", "See below for instructions on how to cancel your order."],
    ])("returns false for %s", (_label, text) => {
      expect(matchesLifecycleEvidence("cancellation", text)).toBe(false);
    });

    it.each([
      ["has been cancelled", "Your order has been cancelled."],
      ["was cancelled", "Order PC-4471 was cancelled at your request."],
      ["we've cancelled your order", "We've cancelled your order as the item is out of stock."],
      ["we have cancelled", "We have cancelled this order and no payment was taken."],
      ["cancellation confirmed", "Cancellation confirmed for order PC-4471."],
      ["will be cancelled (operational)", "The following item could not be processed and will be cancelled."],
      ["is being cancelled", "Your order is being cancelled."],
      ["partial cancellation", "Part of your order has been cancelled; the remaining items will still be delivered."],
      ["items will not be fulfilled", "These items will not be fulfilled: Poké Ball Plus."],
    ])("returns true for a genuine event: %s", (_label, text) => {
      expect(matchesLifecycleEvidence("cancellation", text)).toBe(true);
    });

    it("a genuine cancellation is still detected even when the same email also includes unrelated policy boilerplate elsewhere", () => {
      const mixed = "Your order has been cancelled. " + fixture.confirmationWithCancellationBoilerplate.body;
      expect(matchesLifecycleEvidence("cancellation", mixed)).toBe(true);
    });
  });

  describe("refund: distinguishes a genuine event from policy/eligibility boilerplate", () => {
    it("does not count refund-policy/eligibility boilerplate on a shipping notice", () => {
      expect(matchesLifecycleEvidence("refund", content(fixture.shippingWithRefundBoilerplate))).toBe(false);
    });
    it.each([
      ["refund policy", "See our refund policy for full details."],
      ["right to a refund", "You have the right to a refund if the item is faulty."],
      ["refund eligibility wording", "You may be eligible for a refund within 30 days."],
      ["how to request a refund", "See below for how to request a refund."],
      ["refunds may take", "Refunds may take 5-10 business days to appear."],
    ])("returns false for %s", (_label, text) => {
      expect(matchesLifecycleEvidence("refund", text)).toBe(false);
    });

    it.each([
      ["has been refunded", "Your payment has been refunded."],
      ["was refunded", "Order PC-4471 was refunded in full."],
      ["we have issued a refund", "We have issued a refund to your original payment method."],
      ["refund processed", "Your refund has been processed."],
      ["refund confirmed", "Refund confirmed for order PC-4471."],
      ["explicit refunded amount", "£45.00 has been refunded to your card."],
      ["refunded amount, reverse order", "We have refunded £45.00 to your original payment method."],
    ])("returns true for a genuine event: %s", (_label, text) => {
      expect(matchesLifecycleEvidence("refund", text)).toBe(true);
    });
  });

  describe("return: distinguishes genuine return logistics from policy boilerplate and unrelated delivery/cancellation mail (REGRESSION)", () => {
    it("does not count standard returns-policy boilerplate on an ordinary confirmation or shipping email", () => {
      expect(matchesLifecycleEvidence("return", "Order details. Total paid £45.00. Free returns within 30 days — see our returns policy for details.")).toBe(false);
      expect(matchesLifecycleEvidence("return", "Your order has been dispatched. Not the right fit? You can return this item within 30 days.")).toBe(false);
    });

    it.each([
      ["returns policy alone", "See our returns policy for details."],
      ["returns period wording", "You are within the returns period for this item."],
      ["free returns wording", "Enjoy free returns on all orders."],
      ["eligible for a return", "This item is eligible for a return within 14 days."],
      ["day-returns wording", "This item qualifies for 30-day returns."],
    ])("returns false for %s", (_label, text) => {
      expect(matchesLifecycleEvidence("return", text)).toBe(false);
    });

    it.each([
      ["has been returned", "Your item has been returned to us."],
      ["return received", "We've received your return."],
      ["return label sent", "Your return label has been sent — attach it to your parcel."],
      ["return confirmed", "Return confirmed for order PC-4471."],
      ["started a return", "You started a return for this order."],
      ["RMA reference", "Your RMA reference is RMA-8821."],
    ])("returns true for a genuine event: %s", (_label, text) => {
      expect(matchesLifecycleEvidence("return", text)).toBe(true);
    });

    it("REGRESSION: a genuine parcel-collection (delivery) notification is not counted as return evidence, since it never mentions a return at all", () => {
      expect(matchesLifecycleEvidence("return", "Your parcel is ready for collection from your local store.")).toBe(false);
    });

    it("REGRESSION: a plain order cancellation is not counted as return evidence, since it never mentions a return at all", () => {
      expect(matchesLifecycleEvidence("return", "Your order has been cancelled.")).toBe(false);
    });

    it("a collection notification that genuinely is about return logistics (the courier collecting a returned item) is still counted", () => {
      expect(matchesLifecycleEvidence("return", "Your return has been collected by the courier and is on its way back to us.")).toBe(true);
    });
  });

  describe("Pokémon Center fixture: only genuine cancellations are counted among a mixed mailbox", () => {
    const mailbox = [
      fixture.confirmation,
      fixture.confirmationWithCancellationBoilerplate,
      fixture.marketing,
      fixture.shippingWithRefundBoilerplate,
      fixture.explicitCancellation,
      fixture.genericSubjectBodyCancelled,
    ];
    it("counts exactly the two genuine cancellations, not the ordinary confirmations/marketing/shipping mail", () => {
      const matches = mailbox.filter(email => matchesLifecycleEvidence("cancellation", content(email)));
      expect(matches).toHaveLength(2);
      expect(matches).toContain(fixture.explicitCancellation);
      expect(matches).toContain(fixture.genericSubjectBodyCancelled);
    });
  });
});
