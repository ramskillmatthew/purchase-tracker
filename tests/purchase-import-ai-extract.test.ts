import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aiOrderSchema, toParsedOrder, type AiOrderExtraction } from "@/lib/purchase-import/ai-schema";

const email = { messageId: "gmail:abc123", sender: "Boutique Example <orders@boutique.example>", subject: "Your order is confirmed", date: "2026-07-10T10:00:00.000Z", text: "Thank you for your order." };

const validExtraction: AiOrderExtraction = {
  retailerOrPlatform: "Boutique Example", sellerUsername: null, orderReference: "BX-4471", orderDate: "2026-07-10",
  items: [{ description: "Wool Scarf", size: "One size", condition: "Brand new", quantity: 1, linePricePence: 2500 }],
  deliveryPence: 300, feesPence: null, discountPence: null, totalChargedPence: 2800, currency: "GBP",
};

describe("aiOrderSchema (strict validation of Claude's structured output)", () => {
  it("accepts a well-formed extraction", () => {
    expect(aiOrderSchema.safeParse(validExtraction).success).toBe(true);
  });

  it("REGRESSION: rejects an extraction with an extra, unexpected field rather than silently accepting it", () => {
    const malformed = { ...validExtraction, madeUpField: "should not be here" };
    expect(aiOrderSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a price expressed as a decimal pounds value instead of integer pence", () => {
    const malformed = { ...validExtraction, totalChargedPence: 28.5 };
    expect(aiOrderSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an empty items array", () => {
    const malformed = { ...validExtraction, items: [] };
    expect(aiOrderSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an item missing a required field", () => {
    const malformed = { ...validExtraction, items: [{ description: "Wool Scarf", size: null, condition: null, quantity: 1 }] };
    expect(aiOrderSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a negative price", () => {
    const malformed = { ...validExtraction, totalChargedPence: -100 };
    expect(aiOrderSchema.safeParse(malformed).success).toBe(false);
  });

  it("accepts every monetary field being null (nothing reliably found)", () => {
    const minimal: AiOrderExtraction = { ...validExtraction, deliveryPence: null, feesPence: null, discountPence: null, totalChargedPence: null };
    expect(aiOrderSchema.safeParse(minimal).success).toBe(true);
  });
});

describe("toParsedOrder (merging a validated AI extraction into the shared ParsedOrder shape)", () => {
  it("merges a valid extraction into a ParsedOrder", () => {
    const order = toParsedOrder(email, validExtraction, { candidateType: "general", fallbackPurchasedFrom: "Boutique Example" });
    expect(order).toMatchObject({ purchasedFrom: "Boutique Example", orderReference: "BX-4471", totalPaidPence: 2800, candidateType: "general" });
    expect(order?.items).toEqual([{ description: "Wool Scarf", size: "One size", condition: "Brand new", quantity: 1, linePricePence: 2500 }]);
  });

  it("REGRESSION: flags AI-assisted rows for manual double-checking", () => {
    const order = toParsedOrder(email, validExtraction, { candidateType: "general", fallbackPurchasedFrom: "Boutique Example" });
    expect(order?.uncertaintyReasons).toContain("Extracted with AI assistance — please double-check before importing.");
  });

  it("falls back to the caller-provided retailer name when the model didn't extract one", () => {
    const extraction = { ...validExtraction, retailerOrPlatform: null };
    const order = toParsedOrder(email, extraction, { candidateType: "general", fallbackPurchasedFrom: "Boutique Example" });
    expect(order?.purchasedFrom).toBe("Boutique Example");
  });

  it("falls back to the email date when the model didn't extract an order date", () => {
    const extraction = { ...validExtraction, orderDate: null };
    const order = toParsedOrder(email, extraction, { candidateType: "general", fallbackPurchasedFrom: "Boutique Example" });
    expect(order?.purchaseDate).toBe("2026-07-10");
  });

  it("never invents a price: a null total stays null through to the ParsedOrder, never defaulted to zero", () => {
    const extraction = { ...validExtraction, totalChargedPence: null };
    const order = toParsedOrder(email, extraction, { candidateType: "general", fallbackPurchasedFrom: "Boutique Example" });
    expect(order?.totalPaidPence).toBeNull();
    expect(order?.uncertaintyReasons).toContain("Price could not be determined.");
  });

  it("flags uncertainty when multiple items are extracted but not every line price is known", () => {
    const extraction: AiOrderExtraction = {
      ...validExtraction,
      items: [
        { description: "Wool Scarf", size: null, condition: null, quantity: 1, linePricePence: 2500 },
        { description: "Leather Gloves", size: null, condition: null, quantity: 1, linePricePence: null },
      ],
    };
    const order = toParsedOrder(email, extraction, { candidateType: "general", fallbackPurchasedFrom: "Boutique Example" });
    expect(order?.uncertaintyReasons).toContain("Not every individual item price could be confirmed.");
  });

  it("respects the caller's candidateType classification rather than guessing one itself", () => {
    const vintedExtraction = { ...validExtraction, sellerUsername: "sample_seller" };
    const order = toParsedOrder(email, vintedExtraction, { candidateType: "vinted", fallbackPurchasedFrom: "Vinted" });
    expect(order?.candidateType).toBe("vinted");
    expect(order?.sellerName).toBe("sample_seller");
  });
});

// lib/purchase-import/ai-extract.ts is "server-only" and cannot be imported
// by vitest, so — consistent with the existing security-boundaries.test.ts
// / order-synthesis-integration.test.ts pattern elsewhere in this repo —
// its network-call behaviour is asserted structurally against the source
// text instead of by importing and invoking it.
describe("extractOrderWithAi (network entry point) — structural checks", () => {
  const source = readFileSync("lib/purchase-import/ai-extract.ts", "utf8");

  it("is marked server-only", () => {
    expect(source).toContain('import "server-only"');
  });

  it("returns null when Anthropic is not configured, rather than throwing", () => {
    expect(source).toMatch(/if \(!apiKey \|\| !model\) return null;/);
  });

  it("never scans a mailbox itself — only ever called with one bounded email already provided by the caller", () => {
    expect(source).not.toMatch(/searchYahoo|scanYahooMetadata|scanGmailMetadata|queryIndex|getMails?\(/);
  });

  it("rejects malformed JSON and non-schema-conforming model output safely rather than throwing or trusting it", () => {
    expect(source).toContain("aiOrderSchema.safeParse(parsedJson)");
    expect(source).toMatch(/if \(!extractionResult\.success\) return null;/);
    expect(source).toMatch(/catch \{ return null; \}/);
  });

  it("never trusts the model for fingerprint/confidence — those are computed deterministically in toParsedOrder", () => {
    expect(source).not.toMatch(/fingerprint\s*:\s*(?:extraction|result)/i);
  });
});
