import { describe, expect, it } from "vitest";
import { diversifyByLifecycleStage, lifecycleTypeFilter } from "@/lib/yahoo/lifecycle-scope";

describe("lifecycleTypeFilter", () => {
  it("retrieves the whole forward lifecycle for a dated status question using the indexed path", () => {
    expect(lifecycleTypeFilter("delivery", "did my dimplex order arrive last week")).toEqual(["confirmation", "shipping", "delivery"]);
    expect(lifecycleTypeFilter("shipping", "has my dimplex parcel been dispatched this week")).toEqual(["confirmation", "shipping", "delivery"]);
  });

  it("also broadens a generic order question that only reached \"confirmation\" via the bare order/purchase fallback", () => {
    expect(lifecycleTypeFilter("confirmation", "how is my dimplex order getting on last week")).toEqual(["confirmation", "shipping", "delivery"]);
  });

  it("applies no type filter at all for \"what happened\" phrasing, since that is a broad-history question wanting every event including reversals", () => {
    expect(lifecycleTypeFilter("confirmation", "what happened to my dimplex order last week")).toBeUndefined();
  });

  it("keeps an explicit confirmation/receipt/invoice request narrow to that one type", () => {
    expect(lifecycleTypeFilter("confirmation", "find my dimplex order confirmation from last week")).toBe("confirmation");
    expect(lifecycleTypeFilter("confirmation", "show my dimplex invoice from last week")).toBe("confirmation");
    expect(lifecycleTypeFilter("confirmation", "find my dimplex receipt from last week")).toBe("confirmation");
  });

  it("keeps cancellation, refund, and sold as their own narrow types — a different outcome, not another lifecycle stage", () => {
    expect(lifecycleTypeFilter("cancellation", "was my dimplex order cancelled last week")).toBe("cancellation");
    expect(lifecycleTypeFilter("refund", "did I get a refund for my dimplex order")).toBe("refund");
    expect(lifecycleTypeFilter("sold", "what did I sell on vinted last week")).toBe("sold");
  });

  it("returns undefined for unclassified queries, applying no type filter at all", () => {
    expect(lifecycleTypeFilter("other", "dimplex")).toBeUndefined();
  });

  it("applies no type filter for a broad-history question, so the indexed path can also retrieve cancellations and refunds", () => {
    expect(lifecycleTypeFilter("confirmation", "What happened with my Meaco orders?")).toBeUndefined();
    expect(lifecycleTypeFilter("confirmation", "Tell me the full story of my Meaco orders")).toBeUndefined();
    expect(lifecycleTypeFilter("cancellation", "What happened with my Meaco orders?")).toBeUndefined();
  });

  it("keeps a narrow delivery question scoped to the forward lifecycle even though it shares wording with history questions", () => {
    expect(lifecycleTypeFilter("delivery", "Did my Meaco order arrive?")).toEqual(["confirmation", "shipping", "delivery"]);
  });
});

describe("diversifyByLifecycleStage", () => {
  type Email = { subject: string; date: string };
  const subjectOf = (email: Email) => email.subject;
  const dateOf = (email: Email) => email.date;

  it("guarantees one representative of every present stage before a second from any stage", () => {
    const emails: Email[] = [
      { subject: "Order confirmed #1", date: "2026-07-01" },
      { subject: "Order confirmed #2", date: "2026-07-02" },
      { subject: "Order confirmed #3", date: "2026-07-03" },
      { subject: "Order confirmed #4", date: "2026-07-04" },
      { subject: "Order confirmed #5", date: "2026-07-05" },
      { subject: "Your parcel was delivered", date: "2026-06-01" }, // older than every confirmation, but must not be crowded out
    ];
    const picked = diversifyByLifecycleStage(emails, subjectOf, dateOf, 3);
    expect(picked.length).toBe(3);
    expect(picked.some(email => email.subject === "Your parcel was delivered")).toBe(true);
  });

  it("takes the most recent item within each stage first", () => {
    const emails: Email[] = [
      { subject: "Order confirmed old", date: "2026-01-01" },
      { subject: "Order confirmed new", date: "2026-07-01" },
    ];
    const picked = diversifyByLifecycleStage(emails, subjectOf, dateOf, 1);
    expect(picked).toEqual([{ subject: "Order confirmed new", date: "2026-07-01" }]);
  });

  it("never returns more than the requested limit and never fabricates items", () => {
    const emails: Email[] = [{ subject: "Order confirmed", date: "2026-07-01" }];
    expect(diversifyByLifecycleStage(emails, subjectOf, dateOf, 5).length).toBe(1);
    expect(diversifyByLifecycleStage([], subjectOf, dateOf, 5)).toEqual([]);
  });
});
