import "server-only";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";

/**
 * Stage 5 — a bounded AI step for aspects deterministic matching
 * (lib/listing-studio/ebay-aspect-matching.ts) left unresolved. Only ever
 * sent SELECTION_ONLY aspects (each with its own real, currently-valid
 * eBay allowed-value list) — never a FREE_TEXT aspect, since there the AI
 * would have nothing genuine to select among and this app never lets the
 * AI invent free text for a factual, unverifiable field (EAN, MPN, etc. —
 * see the product spec's own "never invent" rules). One call covers every
 * still-unresolved SELECTION_ONLY aspect for a category at once, reusing
 * the SAME Anthropic client/model as every other AI call in this app.
 *
 * The tool schema's enum for every aspect is built FRESH from that exact
 * aspect's own allowed-value list, so the model is structurally incapable
 * of returning a value eBay wouldn't accept — mirrors
 * lib/listing-studio/vinted-category-selection-ai.ts's and
 * lib/listing-studio/ebay-category-ranking-ai.ts's own "candidate list
 * baked into the schema itself" convention exactly.
 */

export type EbayAspectSuggestionInput = {
  brand: string | null;
  productType: string | null;
  model: string | null;
  title: string | null;
  knownFacts: Record<string, string>;
};

function propertyFor(aspect: GroupedAspect) {
  if (aspect.cardinality === "MULTI") {
    return {
      type: "array",
      items: { type: "string", enum: aspect.allowedValues },
      description: `Zero or more exact values from eBay's own allowed list for "${aspect.name}". Empty array if none confidently apply.`,
    };
  }
  return {
    type: ["string", "null"], enum: [...aspect.allowedValues, null],
    description: `One exact value from eBay's own allowed list for "${aspect.name}", or null if none confidently apply. Never a paraphrase.`,
  };
}

function buildTool(aspects: GroupedAspect[]): Anthropic.Tool {
  const properties: Record<string, unknown> = {};
  for (const aspect of aspects) properties[aspect.name] = propertyFor(aspect);
  return {
    name: "suggest_ebay_aspects",
    description: "Suggest a value for each listed eBay item specific, choosing ONLY from that specific's own supplied allowed values. Call this exactly once. Leave an aspect null (or an empty array for multi-select ones) if you are not genuinely confident — never guess a factual detail you cannot verify from the given product information.",
    input_schema: { type: "object", properties, required: aspects.map(a => a.name), additionalProperties: false },
  };
}

function buildSystemPrompt(aspects: GroupedAspect[], input: EbayAspectSuggestionInput): string {
  const list = aspects.map(a => `- ${a.name} (${a.cardinality === "MULTI" ? "select any that apply" : "select one"}): ${a.allowedValues.join(", ")}`).join("\n");
  const facts = Object.entries(input.knownFacts).map(([k, v]) => `${k}: ${v}`).join("\n");
  return "You suggest values for eBay item specifics for ONE physical product, using only the product information given, via the suggest_ebay_aspects tool. You must call that tool exactly once. "
    + "For every item specific, you may ONLY choose a value that appears in that specific's own allowed-value list below — never invent a value, never return one that is not listed, never guess a factual detail (like an edition, region, or included-accessories claim) you cannot actually verify from the given information. Leave a specific null (or an empty array for multi-select ones) whenever you are not genuinely confident — this is always the correct answer over a weak guess.\n\n"
    + `Item specifics and their allowed values:\n${list}\n\n`
    + `Known product information:\nBrand: ${input.brand ?? "unknown"}\nProduct type: ${input.productType ?? "unknown"}\nModel: ${input.model ?? "unknown"}\nTitle: ${input.title ?? "unknown"}\n${facts}`;
}

function outputSchema(aspects: GroupedAspect[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const aspect of aspects) {
    if (aspect.cardinality === "MULTI") {
      const allowed = new Set(aspect.allowedValues);
      shape[aspect.name] = z.array(z.string()).refine(values => values.every(v => allowed.has(v)), { message: `Every value for "${aspect.name}" must be one of its supplied allowed values.` });
    } else {
      const allowed = new Set(aspect.allowedValues);
      shape[aspect.name] = z.string().nullable().refine(value => value === null || allowed.has(value), { message: `Value for "${aspect.name}" must be one of its supplied allowed values, or null.` });
    }
  }
  return z.object(shape).strict();
}

export type EbayAspectSuggestionAiOutcome =
  | { status: "success"; values: Record<string, string | string[] | null>; model: string; inputTokens: number; outputTokens: number }
  | { status: "not_configured" }
  | { status: "request_failed" }
  | { status: "no_tool_call" }
  | { status: "invalid_output" };

export async function runEbayAspectSuggestion(input: EbayAspectSuggestionInput, aspects: GroupedAspect[]): Promise<EbayAspectSuggestionAiOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };
  if (aspects.length === 0) return { status: "success", values: {}, model, inputTokens: 0, outputTokens: 0 };

  const tool = buildTool(aspects);
  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 512, system: buildSystemPrompt(aspects, input),
      tools: [tool], tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: "Suggest values for the listed item specifics." }],
    });
  } catch {
    return { status: "request_failed" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === tool.name);
  if (!toolUse) return { status: "no_tool_call" };

  const validated = outputSchema(aspects).safeParse(toolUse.input);
  if (!validated.success) return { status: "invalid_output" };

  return { status: "success", values: validated.data as Record<string, string | string[] | null>, model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

export function describeEbayAspectSuggestionFailure(status: Exclude<EbayAspectSuggestionAiOutcome["status"], "success">): string {
  switch (status) {
    case "not_configured": return "Item specific suggestions are not available right now.";
    case "request_failed": return "Item specific suggestions failed.";
    case "no_tool_call": return "Item specific suggestions did not return a structured result.";
    case "invalid_output": return "Item specific suggestions returned an unexpected result.";
  }
}
