import { describe, expect, it } from "vitest";
import { planEmailQuery } from "@/lib/yahoo/query-plan";

describe("deterministic email query planning matrix", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  it.each([
    ["How many Vinted sold emails did I receive in the last three months?", "count", "vinted", "sold", "2026-04-20", "2026-07-20"],
    ["Count my ASOS order confirmations during the past two weeks", "count", "asos", "confirmation", "2026-07-07", "2026-07-20"],
    ["Find my latest Pokémon Centre receipt", "search", "pokemon center", "confirmation", undefined, undefined],
    ["Show Vinted shipping emails from 10th July to 20th July", "search", "vinted", "shipping", "2026-07-10", "2026-07-20"],
    ["How many Nike cancellations did I get last month?", "count", "nike", "cancellation", "2026-06-01", "2026-06-30"],
    ["How many PayPal refunds did I receive this year?", "count", "paypal", "refund", "2026-01-01", "2026-07-20"],
    ["Find Amazon delivery emails yesterday", "search", "amazon", "delivery", "2026-07-19", "2026-07-19"],
    ["Import all my purchases from ASOS this year", "search", "asos", "confirmation", "2026-01-01", "2026-07-20"],
  ])("plans %s", (message, operation, entity, intent, startDate, endDate) => {
    expect(planEmailQuery(message, now)).toMatchObject({ operation, entity, intent, startDate, endDate, transactional: true, hybrid: false });
  });
});

describe("hybrid count+explain detection", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  it.each([
    "How many Pokémon Center cancellation emails did I receive this month and what was cancelled?",
    "How many Meaco orders were cancelled and which items were affected?",
    "How many refunds did I receive and what were they for?",
    "How many ASOS orders were returned, and who were they from?",
    "How many orders were cancelled — list them",
  ])("treats %s as a hybrid count+explain request, not a bare count", message => {
    expect(planEmailQuery(message, now)).toMatchObject({ operation: "count", hybrid: true });
  });

  it.each([
    "How many Pokémon Center cancellation emails did I receive this month?",
    "How many ASOS order confirmations do I have?",
    "Count my Vinted sold emails this month",
  ])("keeps a simple count-only query returning a concise count, not hybrid", message => {
    expect(planEmailQuery(message, now)).toMatchObject({ operation: "count", hybrid: false });
  });

  it.each([
    "Find my Pokémon Center order confirmation",
    "Did my Meaco order arrive?",
    "Show my refund email from ASOS",
  ])("leaves narrow non-count search queries unaffected by hybrid detection", message => {
    expect(planEmailQuery(message, now)).toMatchObject({ operation: "search", hybrid: false });
  });

  it("resolves the bare-count and hybrid Meaco cancellation queries to the identical entity and intent — the explanatory clause must not shrink the candidate set", () => {
    const bareCount = planEmailQuery("How many Meaco cancellation emails did I receive", now);
    const hybrid = planEmailQuery("How many Meaco cancellation emails did I receive, and what were they for?", now);
    // Both plans must agree on everything that determines the retrieved
    // candidate set (entity, intent, date range); only `hybrid` — which adds
    // synthesis on top of the same retrieval — may differ.
    expect(hybrid.entity).toBe(bareCount.entity);
    expect(hybrid.entity).toBe("meaco");
    expect(hybrid.intent).toBe(bareCount.intent);
    expect(hybrid.startDate).toBe(bareCount.startDate);
    expect(hybrid.endDate).toBe(bareCount.endDate);
    expect(hybrid.transactional).toBe(bareCount.transactional);
    expect(bareCount.hybrid).toBe(false);
    expect(hybrid.hybrid).toBe(true);
  });
});

describe("specific vs. generic counts — determines whether supporting emailResults are populated", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  // runAssistant only populates emailResults for a count when it has both an
  // entity token and a recognized (non-"other") lifecycle/document type —
  // exactly plan.entity and plan.transactional. These three real examples
  // must satisfy that gate.
  it.each([
    ["How many Meaco cancellation emails did I receive?", "meaco", "cancellation"],
    ["How many Pokémon Center cancellation emails have I received this month?", "pokemon center", "cancellation"],
    ["How many Dimplex order confirmations do I have?", "dimplex", "confirmation"],
  ])("qualifies as a specific typed count: %s", (message, entity, intent) => {
    const plan = planEmailQuery(message, now);
    expect(plan.entity).toBe(entity);
    expect(plan.intent).toBe(intent);
    expect(plan.transactional).toBe(true);
    expect(plan.operation).toBe("count");
  });

  it.each([
    "How many emails do I have?",
    "How many unread emails are there?",
  ])("does not qualify as a specific typed count, since no retailer/entity is named: %s", message => {
    const plan = planEmailQuery(message, now);
    expect(plan.entity).toBeNull();
  });
});

describe("comparison/summarization wording resolves to the same entity as the equivalent broad-history question", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  it("'Compare my five Meaco orders.' preserves the same entity as 'What happened with my Meaco orders?', so it retrieves the same evidence", () => {
    const broadHistory = planEmailQuery("What happened with my Meaco orders?", now);
    const compare = planEmailQuery("Compare my five Meaco orders.", now);
    const compareNoCount = planEmailQuery("Compare my Meaco orders.", now);
    const summarise = planEmailQuery("Summarise my five Meaco orders.", now);
    expect(broadHistory.entity).toBe("meaco");
    expect(compare.entity).toBe("meaco");
    expect(compareNoCount.entity).toBe("meaco");
    expect(summarise.entity).toBe("meaco");
    expect(compare.transactional).toBe(true);
    expect(summarise.transactional).toBe(true);
  });
});
