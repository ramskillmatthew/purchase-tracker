import { describe, expect, it } from "vitest";
import type { PublicOrder } from "@/lib/orders/public";
import { selectRelevantOrders } from "@/lib/orders/select";

const order = (overrides: Partial<PublicOrder> & { orderId: string }): PublicOrder => ({
  merchant: "meaco", purchaseDate: null, status: "ordered", isPreorder: false,
  items: [], trackingNumbers: [], purchaseAmount: null, refundAmount: null, currency: "GBP",
  paymentCards: [], recipientName: null, notes: [], timeline: [], ...overrides,
});

describe("selectRelevantOrders", () => {
  const orders = [
    order({ orderId: "MC-1001", purchaseAmount: 199.99 }),
    order({ orderId: "MC-2002", purchaseAmount: 539.99, refundAmount: 539.99, paymentCards: ["0428"] }),
    order({ orderId: "MC-3003", purchaseAmount: 629.99, paymentCards: ["1234"] }),
  ];

  it("REGRESSION: narrows to the single order matching an exact price named in the query", () => {
    expect(selectRelevantOrders("Which Meaco order cost £539.99?", orders)).toEqual([orders[1]]);
  });

  it("narrows to the single order matching a refund amount named in the query", () => {
    expect(selectRelevantOrders("Which order was refunded £539.99?", orders)).toEqual([orders[1]]);
  });

  it("narrows to the single order matching an order reference named in the query", () => {
    expect(selectRelevantOrders("What is the status of order MC-3003?", orders)).toEqual([orders[2]]);
  });

  it("narrows to the single order matching a card ending named in the query", () => {
    expect(selectRelevantOrders("Which Meaco order was refunded to card ending 0428?", orders)).toEqual([orders[1]]);
  });

  it("leaves every order unfiltered when a comparison query is asked, even if a price also happens to match", () => {
    expect(selectRelevantOrders("Compare my Meaco orders, the one that cost £539.99 and the others", orders)).toEqual(orders);
  });

  it("leaves every order unfiltered for 'what happened' broad-history wording", () => {
    expect(selectRelevantOrders("What happened with my Meaco orders?", orders)).toEqual(orders);
  });

  it("leaves every order unfiltered when the named price matches more than one order", () => {
    const ambiguous = [order({ orderId: "A", purchaseAmount: 100 }), order({ orderId: "B", purchaseAmount: 100 })];
    expect(selectRelevantOrders("Which order cost £100.00?", ambiguous)).toEqual(ambiguous);
  });

  it("leaves every order unfiltered when no identifier in the query matches any order", () => {
    expect(selectRelevantOrders("Which Meaco order cost £9999.99?", orders)).toEqual(orders);
  });

  it("leaves a list of zero or one order unchanged", () => {
    expect(selectRelevantOrders("Which Meaco order cost £539.99?", [])).toEqual([]);
    expect(selectRelevantOrders("Which Meaco order cost £539.99?", [orders[0]])).toEqual([orders[0]]);
  });

  it("leaves every order unfiltered when the query names no specific identifier at all", () => {
    expect(selectRelevantOrders("What did I order from Meaco?", orders)).toEqual(orders);
  });

  describe("recency wording narrows to the single most-recently-purchased order (REGRESSION — the ASOS 'most recent' bug moved to the correct layer)", () => {
    const dated = [
      order({ orderId: "OLD-1", purchaseDate: "2026-01-01T10:00:00Z", purchaseAmount: 10 }),
      order({ orderId: "NEW-1", purchaseDate: "2026-07-01T10:00:00Z", purchaseAmount: 20 }),
      order({ orderId: "MID-1", purchaseDate: "2026-04-01T10:00:00Z", purchaseAmount: 30 }),
    ];

    it("REGRESSION: 'tell me about my most recent asos purchase' narrows to the single most-recently-purchased order", () => {
      expect(selectRelevantOrders("tell me about my most recent asos purchase", dated)).toEqual([dated[1]]);
    });

    it("recognizes 'latest' and 'newest' the same way", () => {
      expect(selectRelevantOrders("what was my latest asos order", dated)).toEqual([dated[1]]);
      expect(selectRelevantOrders("show me my newest asos order", dated)).toEqual([dated[1]]);
    });

    it("a more specific identifier (price) still takes priority over recency wording when both are present", () => {
      expect(selectRelevantOrders("what was my most recent order that cost £10.00", dated)).toEqual([dated[0]]);
    });

    it("broad/comparison wording still wins over recency wording", () => {
      expect(selectRelevantOrders("compare my last three asos orders", dated)).toEqual(dated);
    });

    it("leaves every order unfiltered when none has a known purchase date to be 'most recent' by", () => {
      const undated = [order({ orderId: "A" }), order({ orderId: "B" })];
      expect(selectRelevantOrders("what was my most recent order", undated)).toEqual(undated);
    });
  });

  describe("generic over any order-shaped object (sidebar relevance): works over the internal reconstruction model too, not just PublicOrder", () => {
    // A minimal stand-in for ReconstructedOrder — carries extra fields
    // (sourceEmails, confidence) that PublicOrder deliberately never has.
    // selectRelevantOrders must preserve them untouched, since
    // lib/anthropic/assistant.ts's selectForDisplay selects on the
    // internal model first (to recover sourceEmails for the sidebar's
    // "used to reconstruct order" marking) and only converts to the public
    // DTO afterward.
    const internalOrder = (overrides: Partial<{ orderId: string | null; purchaseAmount: number | null; refundAmount: number | null; paymentCards: string[]; purchaseDate: string | null; sourceEmails: string[]; confidence: number }> & { orderId: string }) => ({
      purchaseAmount: null, refundAmount: null, paymentCards: [], purchaseDate: null,
      sourceEmails: ["email-1"], confidence: 0.95, ...overrides,
    });

    it("selects the right order and preserves extra internal-model fields (sourceEmails, confidence) untouched", () => {
      const internal = [
        internalOrder({ orderId: "MC-1001", purchaseAmount: 199.99, sourceEmails: ["a", "b"] }),
        internalOrder({ orderId: "MC-2002", purchaseAmount: 539.99, sourceEmails: ["c"] }),
      ];
      const selected = selectRelevantOrders("Which Meaco order cost £539.99?", internal);
      expect(selected).toEqual([internal[1]]);
      expect(selected[0].sourceEmails).toEqual(["c"]);
      expect(selected[0].confidence).toBe(0.95);
    });
  });
});
