import "server-only";
import Anthropic, { APIError, AuthenticationError, RateLimitError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import {
  EBAY_LISTING_GENERATION_SYSTEM_PROMPT, buildEbayListingGenerationTool, ebayListingGenerationOutputSchema,
  repairRawEbayListingGenerationOutput, type EbayListingGenerationAiOutcome,
} from "./ebay-listing-generation-schemas";

export type { EbayListingGenerationAiOutcome };

export type EbayGenerationFactsInput = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  colours: string[];
  material: string | null;
  ukSize: string | null;
  vintedAudience: string | null;
  notes: string | null;
  /** Real evidence about visible condition, if any is already known (e.g.
   * from an imported eBay listing's own condition text, or a manual note)
   * — never fabricated here; null when nothing is known yet. */
  knownConditionEvidence: string | null;
};

function buildUserText(facts: EbayGenerationFactsInput): string {
  const lines = [
    `Brand: ${facts.brand ?? "unknown"}`,
    `Model: ${facts.model ?? "unknown"}`,
    `Product type: ${facts.productType ?? "unknown"}`,
    `Colours: ${facts.colours.length ? facts.colours.join(", ") : "unknown"}`,
    `Material: ${facts.material ?? "unknown"}`,
    `UK size: ${facts.ukSize ?? "unknown"}`,
    `Audience: ${facts.vintedAudience ?? "unknown"}`,
    `Notes from photo analysis: ${facts.notes ?? "none"}`,
    `Known condition evidence: ${facts.knownConditionEvidence ?? "none — do not invent a condition"}`,
  ];
  return `Write eBay UK listing content for this one physical product, using ONLY the facts below:\n${lines.join("\n")}`;
}

/**
 * Calls Claude once, TEXT-ONLY (never re-sends photos — the vision pass
 * already happened for the shared structured analysis both Vinted and
 * eBay reuse), asking for eBay-specific title components/description/
 * condition summary/category search terms. Follows the exact same calling
 * convention as lib/listing-studio/listing-generation-ai.ts: forces one
 * tool call, never trusts it without re-validating against
 * ebayListingGenerationOutputSchema regardless of how well-formed it looks.
 */
// Phase 1/9 fix — safe, structured diagnostics for every failure branch.
// Never the request/response body, never headers, never the API key —
// only a stage label and the SDK's own typed status/error-type fields
// (identical in spirit to how ebay-taxonomy-client.ts already
// distinguishes eBay's own 401 from a generic failure). This is what made
// the real root cause of the reported failure provable in the first
// place — this call previously discarded the error entirely.
function logEbaySafely(stage: string, details: Record<string, unknown>): void {
  console.error(`[ebay-listing-generation-ai] ${stage}`, details);
}

export async function runEbayListingGeneration(facts: EbayGenerationFactsInput): Promise<EbayListingGenerationAiOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) {
    logEbaySafely("not_configured", { hasApiKey: Boolean(apiKey), hasModel: Boolean(model) });
    return { status: "not_configured", code: "EBAY_AI_NOT_CONFIGURED" };
  }

  const tool = buildEbayListingGenerationTool();
  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 1024, system: EBAY_LISTING_GENERATION_SYSTEM_PROMPT,
      tools: [tool], tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: buildUserText(facts) }],
    });
  } catch (error) {
    // Never log/surface the raw error message or body — only the SDK's
    // own typed, safe classification.
    if (error instanceof AuthenticationError) {
      logEbaySafely("request_failed", { model, httpStatus: 401, providerErrorType: error.type ?? null });
      return { status: "request_failed", code: "EBAY_AI_AUTH_FAILED" };
    }
    if (error instanceof RateLimitError) {
      logEbaySafely("request_failed", { model, httpStatus: 429, providerErrorType: error.type ?? null });
      return { status: "request_failed", code: "EBAY_AI_RATE_LIMITED" };
    }
    if (error instanceof APIConnectionTimeoutError) {
      logEbaySafely("request_failed", { model, reason: "timeout" });
      return { status: "request_failed", code: "EBAY_AI_TIMEOUT" };
    }
    if (error instanceof APIError) {
      logEbaySafely("request_failed", { model, httpStatus: error.status ?? null, providerErrorType: error.type ?? null });
      return { status: "request_failed", code: "EBAY_AI_UNKNOWN" };
    }
    logEbaySafely("request_failed", { model, reason: "non_api_error", errorName: error instanceof Error ? error.name : typeof error });
    return { status: "request_failed", code: "EBAY_AI_UNKNOWN" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === tool.name);
  if (!toolUse) {
    logEbaySafely("no_tool_call", { model, stopReason: response.stop_reason });
    return { status: "no_tool_call", code: "EBAY_AI_INVALID_OUTPUT" };
  }

  let validated = ebayListingGenerationOutputSchema.safeParse(toolUse.input);
  if (!validated.success) {
    // Bounded, single repair attempt (Phase 2: "bounded retry/repair, not
    // infinite retries") — proven necessary and sufficient by this fix's
    // own diagnosis: a well-formed, professional response was being
    // discarded wholesale over one auxiliary field a few characters too
    // long. Never repairs by inventing content — only clamps what the
    // model already wrote.
    const repaired = repairRawEbayListingGenerationOutput(toolUse.input);
    validated = ebayListingGenerationOutputSchema.safeParse(repaired);
  }
  if (!validated.success) {
    const issues = validated.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`);
    logEbaySafely("invalid_output", { model, issues });
    return { status: "invalid_output", code: "EBAY_AI_VALIDATION_FAILED", issues };
  }

  return { status: "success", data: validated.data };
}
