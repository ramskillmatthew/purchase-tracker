import { describe, expect, it } from "vitest";
import type { PublicOrder, PublicOrderEvent } from "@/lib/orders/public";
import { capItemList, eventDate, eventLabel, eventTone, formatDisplayDate, formatDisplayDateTime, formatDisplayTime, formatItemLabel, formatSummaryRange, sortOrdersChronologically, statusBadge, summarizeOrders, timelineEventLabels, titleCaseMerchant } from "@/lib/orders/view";

const publicOrder = (overrides: Partial<PublicOrder> = {}): PublicOrder => ({
  orderId: null, merchant: "meaco", purchaseDate: null, status: "ordered", isPreorder: false,
  items: [], trackingNumbers: [], purchaseAmount: null, refundAmount: null, currency: null,
  paymentCards: [], recipientName: null, notes: [], timeline: [], ...overrides,
});

describe("formatItemLabel", () => {
  it("shows the bare name for a single-quantity item", () => {
    expect(formatItemLabel({ name: "Nike Air Max 95", quantity: 1 })).toBe("Nike Air Max 95");
  });

  it("appends a ×N suffix for a quantity greater than 1, matching the exact reported example", () => {
    expect(formatItemLabel({ name: "Pokémon Elite Trainer Box", quantity: 2 })).toBe("Pokémon Elite Trainer Box ×2");
  });
});

describe("capItemList", () => {
  const items = [
    { name: "Item A", quantity: 1 }, { name: "Item B", quantity: 2 }, { name: "Item C", quantity: 1 },
    { name: "Item D", quantity: 1 }, { name: "Item E", quantity: 1 },
  ];

  it("shows the first N items and reports how many more exist", () => {
    expect(capItemList(items, 3)).toEqual({ shown: ["Item A", "Item B ×2", "Item C"], moreCount: 2 });
  });

  it("reports zero more when the list fits within the limit", () => {
    expect(capItemList(items.slice(0, 2), 3)).toEqual({ shown: ["Item A", "Item B ×2"], moreCount: 0 });
  });

  it("handles an empty item list", () => {
    expect(capItemList([], 3)).toEqual({ shown: [], moreCount: 0 });
  });
});

describe("eventDate", () => {
  it("returns the date of the first matching event type", () => {
    const timeline: PublicOrderEvent[] = [{ type: "ordered", date: "2026-07-01T10:00:00Z" }, { type: "dispatched", date: "2026-07-02T10:00:00Z" }];
    expect(eventDate(timeline, "dispatched")).toBe("2026-07-02T10:00:00Z");
  });

  it("returns null when the event type is not present", () => {
    const timeline: PublicOrderEvent[] = [{ type: "ordered", date: "2026-07-01T10:00:00Z" }];
    expect(eventDate(timeline, "delivered")).toBeNull();
  });

  it("returns null when the matching event's own date is null", () => {
    const timeline: PublicOrderEvent[] = [{ type: "cancelled", date: null }];
    expect(eventDate(timeline, "cancelled")).toBeNull();
  });
});

describe("sortOrdersChronologically", () => {
  it("sorts newest purchaseDate first", () => {
    const orders = [publicOrder({ orderId: "old", purchaseDate: "2026-07-01T10:00:00Z" }), publicOrder({ orderId: "new", purchaseDate: "2026-07-10T10:00:00Z" })];
    expect(sortOrdersChronologically(orders).map(order => order.orderId)).toEqual(["new", "old"]);
  });

  it("sorts orders with an unknown purchase date last", () => {
    const orders = [publicOrder({ orderId: "unknown", purchaseDate: null }), publicOrder({ orderId: "known", purchaseDate: "2026-07-01T10:00:00Z" })];
    expect(sortOrdersChronologically(orders).map(order => order.orderId)).toEqual(["known", "unknown"]);
  });

  it("does not mutate the original array", () => {
    const orders = [publicOrder({ orderId: "a", purchaseDate: "2026-07-01T10:00:00Z" }), publicOrder({ orderId: "b", purchaseDate: "2026-07-10T10:00:00Z" })];
    sortOrdersChronologically(orders);
    expect(orders.map(order => order.orderId)).toEqual(["a", "b"]);
  });

  it("is generic over any object with a purchaseDate — not hardcoded to PublicOrder — so it also sorts the internal reconstruction model", () => {
    const internal = [{ orderId: "old", purchaseDate: "2026-07-01T10:00:00Z", sourceEmails: ["a"] }, { orderId: "new", purchaseDate: "2026-07-10T10:00:00Z", sourceEmails: ["b"] }];
    expect(sortOrdersChronologically(internal).map(order => order.orderId)).toEqual(["new", "old"]);
  });
});

describe("summarizeOrders", () => {
  it("summarizes a single order", () => {
    const orders = [publicOrder({
      merchant: "meaco", purchaseAmount: 539.99, refundAmount: 539.99, currency: "GBP",
      timeline: [{ type: "ordered", date: "2026-07-10T10:00:00Z" }, { type: "cancelled", date: "2026-07-10T12:00:00Z" }],
    })];
    const summary = summarizeOrders(orders);
    expect(summary).toEqual({
      merchant: "meaco",
      orderCount: 1,
      purchasedRange: { earliest: "2026-07-10T10:00:00Z", latest: "2026-07-10T10:00:00Z" },
      cancelledRange: { earliest: "2026-07-10T12:00:00Z", latest: "2026-07-10T12:00:00Z" },
      purchaseTotals: [{ currency: "GBP", total: 539.99, orderCount: 1 }],
      refundTotals: [{ currency: "GBP", total: 539.99, orderCount: 1 }],
      deliveredCount: 0,
      activeCount: 1,
      averageOrderValue: [{ currency: "GBP", average: 539.99, orderCount: 1 }],
    });
  });

  it("summarizes multiple same-merchant orders with a purchased date range", () => {
    const orders = [
      publicOrder({ merchant: "meaco", purchaseAmount: 100, currency: "GBP", timeline: [{ type: "ordered", date: "2026-07-01T10:00:00Z" }] }),
      publicOrder({ merchant: "meaco", purchaseAmount: 200, currency: "GBP", timeline: [{ type: "ordered", date: "2026-07-10T10:00:00Z" }] }),
    ];
    const summary = summarizeOrders(orders);
    expect(summary.merchant).toBe("meaco");
    expect(summary.orderCount).toBe(2);
    expect(summary.purchasedRange).toEqual({ earliest: "2026-07-01T10:00:00Z", latest: "2026-07-10T10:00:00Z" });
    expect(summary.purchaseTotals).toEqual([{ currency: "GBP", total: 300, orderCount: 2 }]);
  });

  it("reports a null merchant when orders span more than one merchant", () => {
    const orders = [publicOrder({ merchant: "meaco" }), publicOrder({ merchant: "dimplex" })];
    expect(summarizeOrders(orders).merchant).toBeNull();
  });

  it("reports a null cancelledRange when no order has a cancellation event", () => {
    const orders = [publicOrder({ timeline: [{ type: "ordered", date: "2026-07-01T10:00:00Z" }] })];
    expect(summarizeOrders(orders).cancelledRange).toBeNull();
  });

  it("summarizes an empty order list", () => {
    expect(summarizeOrders([])).toEqual({
      merchant: null, orderCount: 0, purchasedRange: null, cancelledRange: null, purchaseTotals: [], refundTotals: [],
      deliveredCount: 0, activeCount: 0, averageOrderValue: [],
    });
  });

  it("counts delivered and still-active (in-flight) orders separately from resolved/reversed ones", () => {
    const orders = [
      publicOrder({ status: "delivered" }),
      publicOrder({ status: "dispatched" }),
      publicOrder({ status: "cancelled" }),
      publicOrder({ status: "refund_processed" }),
      publicOrder({ status: "ordered" }),
    ];
    const summary = summarizeOrders(orders);
    expect(summary.deliveredCount).toBe(1);
    expect(summary.activeCount).toBe(2); // dispatched + ordered; cancelled/refunded/delivered are resolved
  });

  it("computes the average order value per currency from the purchase totals", () => {
    const orders = [
      publicOrder({ purchaseAmount: 100, currency: "GBP" }),
      publicOrder({ purchaseAmount: 200, currency: "GBP" }),
      publicOrder({ purchaseAmount: 50, currency: "USD" }),
    ];
    const summary = summarizeOrders(orders);
    expect(summary.averageOrderValue).toEqual(expect.arrayContaining([
      { currency: "GBP", average: 150, orderCount: 2 },
      { currency: "USD", average: 50, orderCount: 1 },
    ]));
  });

  it("returns an empty averageOrderValue when no order has a known purchase amount", () => {
    expect(summarizeOrders([publicOrder({ purchaseAmount: null })]).averageOrderValue).toEqual([]);
  });
});

describe("statusBadge", () => {
  it.each([
    ["ordered", "Ordered", "ordered"],
    ["dispatched", "Dispatched", "dispatched"],
    ["out_for_delivery", "Dispatched", "dispatched"],
    ["delivered", "Delivered", "delivered"],
    ["cancelled", "Cancelled", "cancelled"],
    ["returned", "Returned", "returned"],
    ["refund_processed", "Refunded", "refunded"],
    ["sold", "Sold", "sold"],
    ["unknown", "Unknown", "unknown"],
  ] as const)("maps status %s to label %s / tone %s", (status, label, tone) => {
    expect(statusBadge(publicOrder({ status, isPreorder: false }))).toEqual({ label, tone });
  });

  it("overrides the 'Ordered' badge with 'Pre-order' when isPreorder is true", () => {
    expect(statusBadge(publicOrder({ status: "ordered", isPreorder: true }))).toEqual({ label: "Pre-order", tone: "preorder" });
  });

  it("does not override a non-'ordered' status even when isPreorder is true", () => {
    expect(statusBadge(publicOrder({ status: "dispatched", isPreorder: true }))).toEqual({ label: "Dispatched", tone: "dispatched" });
  });
});

describe("eventLabel", () => {
  it("uses the same label vocabulary as statusBadge", () => {
    expect(eventLabel("ordered")).toBe("Ordered");
    expect(eventLabel("dispatched")).toBe("Dispatched");
    expect(eventLabel("delivered")).toBe("Delivered");
    expect(eventLabel("cancelled")).toBe("Cancelled");
    expect(eventLabel("refund_processed")).toBe("Refunded");
  });
});

describe("timelineEventLabels", () => {
  it("uses the plain label when a type appears only once", () => {
    const events: PublicOrderEvent[] = [{ type: "ordered", date: null }, { type: "delivered", date: null }];
    expect(timelineEventLabels(events)).toEqual(["Ordered", "Delivered"]);
  });

  it("REGRESSION: numbers repeated same-type events instead of showing indistinguishable duplicates", () => {
    const events: PublicOrderEvent[] = [
      { type: "ordered", date: null }, { type: "dispatched", date: null }, { type: "dispatched", date: null },
    ];
    expect(timelineEventLabels(events)).toEqual(["Ordered", "Dispatched (1)", "Dispatched (2)"]);
  });

  it("numbers three or more repeats of the same type in order", () => {
    const events: PublicOrderEvent[] = [{ type: "dispatched", date: null }, { type: "dispatched", date: null }, { type: "dispatched", date: null }];
    expect(timelineEventLabels(events)).toEqual(["Dispatched (1)", "Dispatched (2)", "Dispatched (3)"]);
  });

  it("numbers each repeated type independently when more than one type repeats", () => {
    const events: PublicOrderEvent[] = [
      { type: "dispatched", date: null }, { type: "dispatched", date: null },
      { type: "cancelled", date: null }, { type: "cancelled", date: null },
    ];
    expect(timelineEventLabels(events)).toEqual(["Dispatched (1)", "Dispatched (2)", "Cancelled (1)", "Cancelled (2)"]);
  });

  it("returns an empty array for an empty timeline", () => {
    expect(timelineEventLabels([])).toEqual([]);
  });
});

describe("eventTone", () => {
  it("uses the same tone vocabulary as statusBadge for every event type", () => {
    expect(eventTone("ordered")).toBe("ordered");
    expect(eventTone("dispatched")).toBe("dispatched");
    expect(eventTone("delivered")).toBe("delivered");
    expect(eventTone("cancelled")).toBe("cancelled");
    expect(eventTone("refund_processed")).toBe("refunded");
    expect(eventTone("returned")).toBe("returned");
  });
});

describe("formatDisplayDate", () => {
  it("formats a UTC ISO date as 'D Mon YYYY'", () => {
    expect(formatDisplayDate("2026-07-10T09:08:00Z")).toBe("10 Jul 2026");
  });
  it("returns null for a null or invalid value", () => {
    expect(formatDisplayDate(null)).toBeNull();
    expect(formatDisplayDate("not a date")).toBeNull();
  });
});

describe("formatDisplayTime", () => {
  it("formats a UTC ISO time as 'HH:MM', zero-padded", () => {
    expect(formatDisplayTime("2026-07-10T09:08:00Z")).toBe("09:08");
    expect(formatDisplayTime("2026-07-10T23:05:00Z")).toBe("23:05");
  });
  it("returns null for a null or invalid value", () => {
    expect(formatDisplayTime(null)).toBeNull();
    expect(formatDisplayTime("not a date")).toBeNull();
  });
});

describe("formatDisplayDateTime", () => {
  it("combines date and time with a comma", () => {
    expect(formatDisplayDateTime("2026-07-10T09:08:00Z")).toBe("10 Jul 2026, 09:08");
  });
  it("returns null for a null or invalid value", () => {
    expect(formatDisplayDateTime(null)).toBeNull();
  });
});

describe("formatSummaryRange", () => {
  it("collapses a same-calendar-day range to one date plus a time range", () => {
    expect(formatSummaryRange({ earliest: "2026-07-10T09:08:00Z", latest: "2026-07-10T09:09:00Z" })).toEqual({ date: "10 Jul 2026", time: "09:08–09:09" });
  });
  it("shows a single time, not a range, when both timestamps are identical", () => {
    expect(formatSummaryRange({ earliest: "2026-07-10T09:08:00Z", latest: "2026-07-10T09:08:00Z" })).toEqual({ date: "10 Jul 2026", time: "09:08" });
  });
  it("shows a date range with no time when the range spans more than one day", () => {
    expect(formatSummaryRange({ earliest: "2026-07-01T09:08:00Z", latest: "2026-07-10T09:08:00Z" })).toEqual({ date: "1 Jul 2026 – 10 Jul 2026", time: null });
  });
  it("returns null for a null range", () => {
    expect(formatSummaryRange(null)).toBeNull();
  });
});

describe("titleCaseMerchant", () => {
  it("title-cases an ordinary lowercase merchant name", () => {
    expect(titleCaseMerchant("dimplex")).toBe("Dimplex");
  });
  it("title-cases a merchant name with a parenthesized dotted abbreviation, matching the exact reported example", () => {
    expect(titleCaseMerchant("meaco (u.k.) limited")).toBe("Meaco (U.K.) Limited");
  });
  it("title-cases multiple ordinary words", () => {
    expect(titleCaseMerchant("pokemon center")).toBe("Pokemon Center");
  });
});
