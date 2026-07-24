import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  aiOrderSchema, toParsedOrder, type AiOrderExtraction,
  EXTRACT_PURCHASE_ORDER_TOOL, isSupportedCurrency, describeAiFailure, buildFallbackOrder, resolveOrderForEmail,
} from "@/lib/purchase-import/ai-schema";
import type { ParsedOrder } from "@/lib/purchase-import/types";

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

describe("EXTRACT_PURCHASE_ORDER_TOOL (the forced tool-use schema)", () => {
  it("REGRESSION: defines every field the AI_SYSTEM_PROMPT refers to, as a real JSON Schema the Anthropic API enforces — not just prose asking for a shape", () => {
    const props = EXTRACT_PURCHASE_ORDER_TOOL.input_schema.properties as Record<string, unknown>;
    for (const field of ["retailerOrPlatform", "sellerUsername", "orderReference", "orderDate", "items", "deliveryPence", "feesPence", "discountPence", "totalChargedPence", "currency"]) {
      expect(props).toHaveProperty(field);
    }
    const itemProps = (props.items as { items: { properties: Record<string, unknown> } }).items.properties;
    for (const field of ["description", "size", "condition", "quantity", "linePricePence"]) {
      expect(itemProps).toHaveProperty(field);
    }
  });

  it("rejects any field the model might invent beyond the schema (additionalProperties: false), at both the order and item level", () => {
    expect(EXTRACT_PURCHASE_ORDER_TOOL.input_schema.additionalProperties).toBe(false);
    const items = EXTRACT_PURCHASE_ORDER_TOOL.input_schema.properties as { items: { items: { additionalProperties: boolean } } };
    expect(items.items.items.additionalProperties).toBe(false);
  });

  it("has a stable name matching what ai-extract.ts forces via tool_choice", () => {
    expect(EXTRACT_PURCHASE_ORDER_TOOL.name).toBe("extract_purchase_order");
  });
});

describe("isSupportedCurrency", () => {
  it("accepts GBP and its symbol, case-insensitively", () => {
    expect(isSupportedCurrency("GBP")).toBe(true);
    expect(isSupportedCurrency("gbp")).toBe(true);
    expect(isSupportedCurrency("£")).toBe(true);
  });

  it("REGRESSION: rejects a different, explicitly-stated currency rather than silently treating it as GBP", () => {
    expect(isSupportedCurrency("USD")).toBe(false);
    expect(isSupportedCurrency("EUR")).toBe(false);
    expect(isSupportedCurrency("$")).toBe(false);
  });

  it("accepts null (currency not stated) — most genuine GBP receipts never spell it out", () => {
    expect(isSupportedCurrency(null)).toBe(true);
  });
});

describe("describeAiFailure", () => {
  it("returns a fixed, safe sentence for every failure category — never the raw error or model output", () => {
    for (const status of ["not_configured", "request_failed", "no_tool_call", "invalid_output", "unsupported_currency", "limit_reached"] as const) {
      const message = describeAiFailure(status);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

const fallbackEmail = { messageId: "gmail:xyz789", sender: "Some Shop <orders@some-shop.example>", subject: "Your recent purchase", date: "2026-07-21T09:00:00.000Z", text: "Some receipt body." };
const fallbackContext = { candidateType: "general" as const, fallbackPurchasedFrom: "Some Shop" };

describe("buildFallbackOrder (REGRESSION — never silently discard a shortlisted email)", () => {
  it("uses the email subject as a provisional item description, never inventing one", () => {
    const order = buildFallbackOrder(fallbackEmail, fallbackContext, ["reason"]);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].description).toBe("Your recent purchase");
  });

  it("leaves size, condition, and price completely blank — never invented", () => {
    const order = buildFallbackOrder(fallbackEmail, fallbackContext, ["reason"]);
    expect(order.items[0].size).toBeNull();
    expect(order.items[0].condition).toBeNull();
    expect(order.items[0].linePricePence).toBeNull();
    expect(order.totalPaidPence).toBeNull();
  });

  it("carries the given reasons as the order's own uncertainty text, so the review UI shows why this needs attention", () => {
    const order = buildFallbackOrder(fallbackEmail, fallbackContext, ["Extraction failed for this email."]);
    expect(order.uncertaintyReasons).toContain("Extraction failed for this email.");
  });

  it("retains the source email/provider identity (messageId, sender, subject, date) so it can still be traced and grouped", () => {
    const order = buildFallbackOrder(fallbackEmail, fallbackContext, []);
    expect(order.messageId).toBe(fallbackEmail.messageId);
    expect(order.sender).toBe(fallbackEmail.sender);
    expect(order.candidateType).toBe("general");
    expect(order.purchasedFrom).toBe("Some Shop");
  });

  it("uses a deliberately very low parserConfidence so it reads as unreliable in the review UI", () => {
    const order = buildFallbackOrder(fallbackEmail, fallbackContext, []);
    expect(order.parserConfidence).toBeLessThan(0.2);
  });

  it("falls back to a placeholder description if the subject is somehow blank, rather than failing to build a candidate at all", () => {
    const order = buildFallbackOrder({ ...fallbackEmail, subject: "" }, fallbackContext, []);
    expect(order.items[0].description).toBe("(No subject)");
  });
});

describe("resolveOrderForEmail (REGRESSION — decides the final order for every deterministic/AI outcome combination)", () => {
  const deterministic: ParsedOrder = {
    messageId: fallbackEmail.messageId, emailDate: fallbackEmail.date, sender: fallbackEmail.sender, subject: fallbackEmail.subject,
    orderReference: "REF-1", sellerName: null, purchasedFrom: "Some Shop", candidateType: "general", purchaseDate: "2026-07-21",
    dispatchStatus: null, deliveryStatus: null, cancellationRefundStatus: null,
    items: [{ description: "Deterministically parsed item", size: "M", condition: "Brand new", quantity: 1, linePricePence: 1999 }],
    totalPaidPence: 1999, parserConfidence: 0.9, fingerprint: "a".repeat(64), sanitizedExcerpt: "excerpt", uncertaintyReasons: [],
  };
  const aiSuccessOrder: ParsedOrder = { ...deterministic, purchasedFrom: "AI-Extracted Shop", parserConfidence: 0.5 };

  it("AI success wins outright, even over an existing deterministic parse", () => {
    const order = resolveOrderForEmail(deterministic, { status: "success", order: aiSuccessOrder }, fallbackEmail, fallbackContext);
    expect(order.purchasedFrom).toBe("AI-Extracted Shop");
  });

  it("REGRESSION: deterministic parser failure followed by successful AI extraction produces the AI result", () => {
    const order = resolveOrderForEmail(null, { status: "success", order: aiSuccessOrder }, fallbackEmail, fallbackContext);
    expect(order).toBe(aiSuccessOrder);
  });

  it("uses the deterministic order, untouched, when AI wasn't attempted at all", () => {
    const order = resolveOrderForEmail(deterministic, { status: "not_attempted" }, fallbackEmail, fallbackContext);
    expect(order).toBe(deterministic);
  });

  it("uses the deterministic order when AI was attempted but failed", () => {
    const order = resolveOrderForEmail(deterministic, { status: "invalid_output" }, fallbackEmail, fallbackContext);
    expect(order).toBe(deterministic);
  });

  it("REGRESSION: both deterministic parsing and AI extraction failing produces a low-confidence fallback candidate, never a dropped email", () => {
    const order = resolveOrderForEmail(null, { status: "request_failed" }, fallbackEmail, fallbackContext);
    expect(order.items[0].description).toBe(fallbackEmail.subject);
    expect(order.totalPaidPence).toBeNull();
    expect(order.uncertaintyReasons.some(reason => reason.includes("Automatic extraction failed"))).toBe(true);
  });

  it("both failing with AI never attempted (e.g. the per-run limit was reached) still produces a fallback candidate, not a dropped email", () => {
    const order = resolveOrderForEmail(null, { status: "limit_reached" }, fallbackEmail, fallbackContext);
    expect(order.items[0].description).toBe(fallbackEmail.subject);
    expect(order.uncertaintyReasons.some(reason => reason.includes("limit was reached"))).toBe(true);
  });

  it("both failing with AI genuinely not_attempted still produces a fallback candidate with only the generic reason (no fabricated AI-specific detail)", () => {
    const order = resolveOrderForEmail(null, { status: "not_attempted" }, fallbackEmail, fallbackContext);
    expect(order.uncertaintyReasons).toHaveLength(1);
  });
});

// lib/purchase-import/ai-extract.ts is "server-only" and cannot be imported
// with a real network call in vitest — the actual Anthropic response
// handling is exercised for real in
// tests/purchase-import-ai-extract-runtime.test.ts (via a mocked SDK
// client). What's left here are structural invariants that don't need a
// live call to verify.
describe("extractOrderWithAi (network entry point) — structural checks", () => {
  const source = readFileSync("lib/purchase-import/ai-extract.ts", "utf8");

  it("is marked server-only", () => {
    expect(source).toContain('import "server-only"');
  });

  it("returns a not_configured outcome when Anthropic isn't configured, rather than throwing", () => {
    expect(source).toMatch(/if \(!apiKey \|\| !model\) return \{ status: "not_configured" \};/);
  });

  it("never scans a mailbox itself — only ever called with one bounded email already provided by the caller", () => {
    expect(source).not.toMatch(/searchYahoo|scanYahooMetadata|scanGmailMetadata|queryIndex|getMails?\(/);
  });

  it("REGRESSION: forces a single tool call via tool_choice rather than asking for free-form JSON text", () => {
    expect(source).toContain("tools: [EXTRACT_PURCHASE_ORDER_TOOL]");
    expect(source).toContain('tool_choice: { type: "tool", name: EXTRACT_PURCHASE_ORDER_TOOL.name }');
    expect(source).not.toContain("JSON.parse(raw)");
  });

  it("re-validates the tool's returned input with aiOrderSchema — a well-formed tool call alone is never trusted", () => {
    expect(source).toContain("aiOrderSchema.safeParse(toolUse.input)");
    expect(source).toMatch(/if \(!extractionResult\.success\) return \{ status: "invalid_output" \};/);
  });

  it("never trusts the model for fingerprint/confidence — those are computed deterministically in toParsedOrder", () => {
    expect(source).not.toMatch(/fingerprint\s*:\s*(?:extraction|result)/i);
  });

  it("never logs the raw request/response error", () => {
    const catchBlock = source.slice(source.indexOf("} catch {"), source.indexOf("return { status: \"request_failed\" };") + 40);
    expect(catchBlock).not.toMatch(/console\.(log|error|warn)/);
  });
});
