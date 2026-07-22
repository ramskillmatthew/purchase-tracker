import { describe, expect, it } from "vitest"; import { preferLifecycleEvidence, queryEntityTokens, queryRequestsTransaction, resultMatchesQueryEntity } from "@/lib/yahoo/query-relevance";
const result=(sender:string,subject:string,excerpt="")=>({sender,subject,excerpt});
describe("deterministic result relevance",()=>{
  it("keeps a broader branded division while excluding unrelated retailers",()=>{const query="find my most recent asos purchase";expect(queryEntityTokens(query)).toEqual(["asos"]);expect(resultMatchesQueryEntity(query,result("ASOS Sample Sale <orders@example.test>","We received your order"))).toBe(true);expect(resultMatchesQueryEntity(query,result("Just Eat <news@example.test>","Score 50% off"))).toBe(false);});
  it("requires transaction evidence for purchase and receipt requests",()=>{const query="find me my most recent asos purchase/receipt";expect(resultMatchesQueryEntity(query,result("ASOS <account@asos.com>","Your account's set up","Get delivery and returns updates"))).toBe(false);expect(resultMatchesQueryEntity(query,result("ASOS Sample Sale","A shipment from order AC-563216 is on the way","Track your shipment"))).toBe(false);expect(resultMatchesQueryEntity(query,result("ASOS Sample Sale","We've got your order","Order details. Total paid £42.00"))).toBe(true);});
  it("accepts retailer-specific order subjects without accepting lifecycle mail",()=>{const query="find my latest asos receipt";expect(resultMatchesQueryEntity(query,result("ASOS Sample Sale","Your ASOS order AC-12345","Thanks for shopping with us"))).toBe(true);expect(resultMatchesQueryEntity(query,result("ASOS Sample Sale","Your ASOS order AC-12345 has shipped","Track it here"))).toBe(false);});
  it("does not confuse order reversals with confirmations",()=>{const query="Find my latest Pokémon Center order confirmation";expect(resultMatchesQueryEntity(query,result("Pokémon Center","Your order has been cancelled"))).toBe(false);expect(resultMatchesQueryEntity(query,result("Pokémon Center","Thank you for placing an order with Pokémon Center!","Order details"))).toBe(true);});
  it("does not confuse shipping notices with confirmations",()=>{const query="Find my latest Pokémon Center order confirmation";expect(resultMatchesQueryEntity(query,result("Pokémon Center","Your Pokémon Center order is on its way!","Find out when your order will arrive"))).toBe(false);expect(resultMatchesQueryEntity(query,result("Pokémon Center","Thank you for placing an order with Pokémon Center!","Below is a copy of your order details"))).toBe(true);});
  it("detects transactional lookup intent independently of retailer",()=>{expect(queryRequestsTransaction("find my latest receipt from any shop")).toBe(true);expect(queryRequestsTransaction("show unread emails this week")).toBe(false);});
  it("recognizes plural confirmation requests",()=>{expect(queryRequestsTransaction("how many Pokémon Center email confirmations do I have")).toBe(true);});
  it("treats standalone confirmation and common typos as transactional",()=>{expect(queryRequestsTransaction("find my latest Pokémon Center confirmation")).toBe(true);expect(queryRequestsTransaction("find my latest pokemon cente conformation")).toBe(true);expect(queryEntityTokens("find my latest pokemon cente conformation")).toEqual(["pokemon","center"]);});
  it("does not treat recency words as part of the retailer",()=>{expect(queryEntityTokens("find me my last asos receipt")).toEqual(["asos"]);expect(queryEntityTokens("show the newest nike order")).toEqual(["nike"]);});
  it("does not treat counting language as part of the retailer",()=>{expect(queryEntityTokens("how many ASOS order confirmations were there")).toEqual(["asos"]);});
  it("does not treat dates or question grammar as part of the retailer",()=>{expect(queryEntityTokens("find all Pokémon Center confirmations from the 10th July to 20th July")).toEqual(["pokemon","center"]);expect(queryEntityTokens("how many Nike orders did I receive in June")).toEqual(["nike"]);});
  it("does not treat between-and count grammar as part of the retailer",()=>{expect(queryEntityTokens("how many Pokémon Center confirmations do I have between July 10th and July 20th")).toEqual(["pokemon","center"]);});
  it("normalizes accents and UK/US spelling",()=>{expect(resultMatchesQueryEntity("pokemon centre order",result("Pokémon Center <news@example.test>","We received your order"))).toBe(true);});
  it("fuzzily validates ordinary one-character retailer typos",()=>{expect(resultMatchesQueryEntity("find my latest pokmon cnter order",result("Pokémon Center <news@example.test>","We received your order"))).toBe(true);expect(resultMatchesQueryEntity("find my latest assos order",result("ASOS Sample Sale <orders@example.test>","Order confirmed"))).toBe(true);expect(resultMatchesQueryEntity("find my latest assos order",result("Just Eat <news@example.test>","Order confirmed"))).toBe(false);});
  it("keeps unconstrained status searches broad",()=>{expect(resultMatchesQueryEntity("show unread emails this week",result("Any sender","Any subject"))).toBe(true);});
  it("requires every meaningful entity token",()=>{expect(resultMatchesQueryEntity("holiday booking reference",result("Travel Company","Your holiday booking","Reference ABC123"))).toBe(true);expect(resultMatchesQueryEntity("holiday booking reference",result("Holiday Deals","Weekly offers"))).toBe(false);});
  it("handles Vinted sold-message searches without confusing purchases",()=>{const query="find my Vinted solds emails this month";expect(queryRequestsTransaction(query)).toBe(true);expect(queryEntityTokens(query)).toEqual(["vinted"]);expect(resultMatchesQueryEntity(query,result("Team Vinted","You’ve sold an item on Vinted"))).toBe(true);expect(resultMatchesQueryEntity(query,result("Team Vinted","Your Vinted purchase receipt"))).toBe(false);});
  it("does not mistake plural date units for part of a company name",()=>{expect(queryEntityTokens("how many Vinted sold emails did I receive in the last 3 months")).toEqual(["vinted"]);expect(queryEntityTokens("how many ASOS orders in the past two weeks")).toEqual(["asos"]);});
  it("reduces natural-language dimplex questions to the same clean keyword instead of a glued filler-word phrase",()=>{
    expect(queryEntityTokens("your dimplex order")).toEqual(["dimplex"]);
    expect(queryEntityTokens("find my dimplex delivery")).toEqual(["dimplex"]);
    expect(queryEntityTokens("when is my dimplex order arriving")).toEqual(["dimplex"]);
    expect(queryEntityTokens("show me my dimplex order")).toEqual(["dimplex"]);
    expect(queryEntityTokens("emails about my dimplex order")).toEqual(["dimplex"]);
    expect(queryEntityTokens("tell me about my dimplex order")).toEqual(["dimplex"]);
  });
  it("reduces natural-language parcel questions to the same clean keyword",()=>{
    expect(queryEntityTokens("my parcel")).toEqual(["parcel"]);
    expect(queryEntityTokens("where is my parcel")).toEqual(["parcel"]);
    expect(queryEntityTokens("parcel delivery")).toEqual(["parcel"]);
    expect(queryEntityTokens("parcel tracking")).toEqual(["parcel"]);
  });
  it("accepts shipping-worded evidence for a delivery-classified query and vice versa, since people use them interchangeably",()=>{
    expect(resultMatchesQueryEntity("dimplex delivery",result("Dimplex <orders@dimplex.co.uk>","Your Dimplex order has been dispatched","Track it here"))).toBe(true);
    expect(resultMatchesQueryEntity("dimplex tracking",result("Dimplex <orders@dimplex.co.uk>","Your Dimplex parcel has been delivered",""))).toBe(true);
  });

  describe("lifecycle status questions retrieve the whole order narrative", () => {
    const parcelAnticipation = result("Dimplex <orders@dimplex.co.uk>", "We're expecting your Dimplex parcel", "");
    const deliveredToday = result("Dimplex <orders@dimplex.co.uk>", "Your Dimplex order will be delivered today", "");
    const confirmationEmail = result("Dimplex <orders@dimplex.co.uk>", "Thank you for your Dimplex order", "Order details");
    const cancelledEmail = result("Dimplex <orders@dimplex.co.uk>", "Your Dimplex order has been cancelled", "");

    it("finds both a parcel-anticipation email and a delivered email for \"When did my Dimplex order arrive?\"", () => {
      const query = "When did my Dimplex order arrive?";
      expect(resultMatchesQueryEntity(query, parcelAnticipation)).toBe(true);
      expect(resultMatchesQueryEntity(query, deliveredToday)).toBe(true);
    });

    it("finds both lifecycle emails for the shorter \"Did my Dimplex order arrive?\"", () => {
      const query = "Did my Dimplex order arrive?";
      expect(resultMatchesQueryEntity(query, parcelAnticipation)).toBe(true);
      expect(resultMatchesQueryEntity(query, deliveredToday)).toBe(true);
    });

    it("recognizes bare \"arrive\" and \"arrives\", not only \"arrived\"/\"arriving\"", () => {
      expect(resultMatchesQueryEntity("when does my dimplex order arrive", deliveredToday)).toBe(true);
      expect(resultMatchesQueryEntity("my dimplex parcel arrives when", parcelAnticipation)).toBe(true);
    });

    it("keeps an explicit \"find my order confirmation\" request narrow to the confirmation document", () => {
      const query = "find my dimplex order confirmation";
      expect(resultMatchesQueryEntity(query, parcelAnticipation)).toBe(false);
      expect(resultMatchesQueryEntity(query, deliveredToday)).toBe(false);
      expect(resultMatchesQueryEntity(query, confirmationEmail)).toBe(true);
    });

    it("excludes cancellation/refund emails from a normal delivery-status question", () => {
      const query = "When did my Dimplex order arrive?";
      expect(resultMatchesQueryEntity(query, cancelledEmail)).toBe(false);
    });

    it("still surfaces a cancellation email when the query actually asks about it", () => {
      expect(resultMatchesQueryEntity("was my dimplex order cancelled", cancelledEmail)).toBe(true);
    });
  });

  describe("broad-history questions retrieve the complete order narrative, including reversals", () => {
    const meacoConfirmation = result("Meaco <orders@meaco.com>", "Thank you for your Meaco order MC-1001", "Order details. Total paid £199.00");
    const meacoCancelled = result("Meaco <orders@meaco.com>", "Your Meaco order MC-1001 has been cancelled", "");
    const meacoRefunded = result("Meaco <orders@meaco.com>", "Your refund for order MC-1001 has been processed", "Refund confirmation");
    const secondMeacoConfirmation = result("Meaco <orders@meaco.com>", "Thank you for your Meaco order MC-2002", "Order details. Total paid £249.00");

    it("finds confirmation, cancellation, and refund emails for \"What happened with my Meaco orders?\"", () => {
      const query = "What happened with my Meaco orders?";
      expect(resultMatchesQueryEntity(query, meacoConfirmation)).toBe(true);
      expect(resultMatchesQueryEntity(query, meacoCancelled)).toBe(true);
      expect(resultMatchesQueryEntity(query, meacoRefunded)).toBe(true);
    });

    it("finds the same complete narrative for \"Tell me the full story of my Meaco orders\"", () => {
      const query = "Tell me the full story of my Meaco orders";
      expect(resultMatchesQueryEntity(query, meacoConfirmation)).toBe(true);
      expect(resultMatchesQueryEntity(query, meacoCancelled)).toBe(true);
      expect(resultMatchesQueryEntity(query, meacoRefunded)).toBe(true);
    });

    it("keeps \"Did my Meaco order arrive?\" focused on forward-lifecycle evidence, excluding the reversal emails", () => {
      const query = "Did my Meaco order arrive?";
      expect(resultMatchesQueryEntity(query, meacoCancelled)).toBe(false);
      expect(resultMatchesQueryEntity(query, meacoRefunded)).toBe(false);
    });

    it("keeps \"Find my Meaco order confirmation\" strict to the confirmation document, excluding the reversal emails", () => {
      const query = "Find my Meaco order confirmation";
      expect(resultMatchesQueryEntity(query, meacoConfirmation)).toBe(true);
      expect(resultMatchesQueryEntity(query, meacoCancelled)).toBe(false);
      expect(resultMatchesQueryEntity(query, meacoRefunded)).toBe(false);
    });

    it("keeps a normal narrow delivery question excluding unrelated reversal emails, unaffected by the broad-history bypass", () => {
      const query = "When did my Meaco order arrive?";
      expect(resultMatchesQueryEntity(query, meacoCancelled)).toBe(false);
    });

    it("retrieves emails for two separate order numbers under a broad-history question, so synthesis can keep them apart", () => {
      const query = "What happened with my Meaco orders?";
      expect(resultMatchesQueryEntity(query, meacoConfirmation)).toBe(true);
      expect(resultMatchesQueryEntity(query, secondMeacoConfirmation)).toBe(true);
      expect(meacoConfirmation.subject).toContain("MC-1001");
      expect(secondMeacoConfirmation.subject).toContain("MC-2002");
    });
  });

  describe("comparison/summary questions also retrieve reversals, not just confirmations", () => {
    const cancelled = result("Meaco <orders@meaco.com>", "Your Meaco order MC-2002 has been cancelled", "");
    const refunded = result("Meaco <orders@meaco.com>", "Refund confirmed for order MC-2002", "£629.99 has been refunded");
    const confirmed = result("Meaco <orders@meaco.com>", "Your Meaco order MC-1001 confirmed", "Order details. Total paid £629.99");

    it.each([
      "Compare my five Meaco orders.",
      "Compare my Meaco orders.",
      "Summarise my five Meaco orders.",
      "Summarize my Meaco orders.",
    ])("finds cancellation, refund, and confirmation evidence alike for: %s", query => {
      expect(resultMatchesQueryEntity(query, cancelled)).toBe(true);
      expect(resultMatchesQueryEntity(query, refunded)).toBe(true);
      expect(resultMatchesQueryEntity(query, confirmed)).toBe(true);
    });

    it("still excludes an unrelated reversal from a normal narrow status question (comparison wording doesn't loosen every query)", () => {
      expect(resultMatchesQueryEntity("Did my Meaco order arrive?", cancelled)).toBe(false);
    });
  });

  describe("hybrid count+explain phrasing never leaks pronouns/instruction words into the entity", () => {
    it("extracts only the retailer from the exact failing hybrid query, matching its bare-count counterpart", () => {
      const bareCount = "How many Meaco cancellation emails did I receive";
      const hybrid = "How many Meaco cancellation emails did I receive, and what were they for?";
      expect(queryEntityTokens(hybrid)).toEqual(["meaco"]);
      expect(queryEntityTokens(hybrid)).toEqual(queryEntityTokens(bareCount));
    });

    it("extracts only the retailer from 'which items ... were cancelled' phrasing", () => {
      expect(queryEntityTokens("Which items from my Meaco orders were cancelled?")).toEqual(["meaco"]);
    });

    it("extracts every real entity word from 'list them for <retailer>' phrasing", () => {
      expect(queryEntityTokens("List them for Pokémon Center")).toEqual(["pokemon", "center"]);
    });

    it("finds no entity at all in 'who were they from', since it names no retailer", () => {
      expect(queryEntityTokens("Who were they from?")).toEqual([]);
    });

    it("strips 'what were they for' entirely when it is the whole query", () => {
      expect(queryEntityTokens("what were they for")).toEqual([]);
    });

    it("strips bare 'which items'", () => {
      expect(queryEntityTokens("which items")).toEqual([]);
    });

    it("strips 'show them'", () => {
      expect(queryEntityTokens("show them")).toEqual([]);
    });

    it("does not let a pronoun leak into a sender/entity string used for retrieval", () => {
      const tokens = queryEntityTokens("How many Meaco cancellation emails did I receive, and what were they for?");
      expect(tokens.join(" ")).not.toContain("they");
      expect(tokens.join(" ")).toBe("meaco");
    });

    it("handles 'they're'/'they've' contractions without leaking the leftover fragment as an entity token", () => {
      expect(queryEntityTokens("they're from meaco")).toEqual(["meaco"]);
      expect(queryEntityTokens("what were they've cancelled for")).toEqual([]);
    });

    it("still extracts the same entity tokens for accented and unaccented Pokémon Center", () => {
      expect(queryEntityTokens("Pokémon Center")).toEqual(["pokemon", "center"]);
      expect(queryEntityTokens("Pokemon Center")).toEqual(["pokemon", "center"]);
      expect(queryEntityTokens("List them for Pokémon Center")).toEqual(queryEntityTokens("List them for Pokemon Center"));
    });
  });

  describe("comparison/summarization wording never leaks into the entity, matching the exact failing query", () => {
    it.each([
      "Compare my five Meaco orders.",
      "Compare my Meaco orders.",
      "Summarise my five Meaco orders.",
    ])("preserves Meaco as the sole entity for: %s", message => {
      expect(queryEntityTokens(message)).toEqual(["meaco"]);
    });
  });

  describe("generic attribute-descriptor wording never leaks into the entity", () => {
    it.each([
      "Which Meaco order was refunded to card ending 0428?",
      "Which Meaco order cost £539.99?",
    ])("preserves Meaco as the sole entity for: %s", message => {
      expect(queryEntityTokens(message)).toEqual(["meaco"]);
    });
  });

  describe("preferLifecycleEvidence", () => {
    const accountEmail = result("ASOS <noreply@asos.com>", "Your ASOS account is set up", "Welcome! Track your orders, manage your wishlist and more.");
    const marketingEmail = result("ASOS <noreply@asos.com>", "20% off everything this weekend", "Shop the sale now");
    const genuineOrder = result("ASOS Sample Sale <orders@asos.com>", "Your ASOS order AC-563216", "Order details. Total paid £24.00");

    it("keeps only the genuine order when a newer account-setup email is also present", () => {
      expect(preferLifecycleEvidence([accountEmail, genuineOrder])).toEqual([genuineOrder]);
    });

    it("keeps only the genuine order when a newer marketing email is also present", () => {
      expect(preferLifecycleEvidence([marketingEmail, genuineOrder])).toEqual([genuineOrder]);
    });

    it("falls back to the full set when every candidate is unrelated (nothing to narrow to)", () => {
      expect(preferLifecycleEvidence([accountEmail, marketingEmail])).toEqual([accountEmail, marketingEmail]);
    });

    it("returns the set unchanged when every candidate already carries lifecycle evidence", () => {
      const dispatched = result("Meaco <orders@meaco.com>", "Your Meaco order has been dispatched", "");
      expect(preferLifecycleEvidence([genuineOrder, dispatched])).toEqual([genuineOrder, dispatched]);
    });

    it("broad-history wording and direct 'most recent purchase' wording resolve to the same genuine order out of the same candidate pool", () => {
      const candidates = [accountEmail, genuineOrder];
      const broadHistory = "What's the history of my most recent ASOS purchase?";
      const direct = "Find my most recent ASOS purchase";
      const forBroadHistory = preferLifecycleEvidence(candidates.filter(candidate => resultMatchesQueryEntity(broadHistory, candidate)));
      const forDirect = preferLifecycleEvidence(candidates.filter(candidate => resultMatchesQueryEntity(direct, candidate)));
      expect(forBroadHistory).toEqual([genuineOrder]);
      expect(forDirect).toEqual([genuineOrder]);
    });
  });
});
