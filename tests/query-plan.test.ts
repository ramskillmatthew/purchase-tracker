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
    expect(planEmailQuery(message, now)).toMatchObject({ operation, entity, intent, startDate, endDate, transactional: true });
  });
});
