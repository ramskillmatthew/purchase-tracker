import "server-only";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Stage 4 — a second, separate, text-only AI step, run ONLY when eBay's own
 * relevancy scores leave the top candidate ambiguous (see
 * lib/listing-studio/ebay-category-service.ts's deterministic-first
 * ranking). Mirrors lib/listing-studio/vinted-category-selection-ai.ts's
 * calling convention exactly (forced single tool call, output re-validated
 * regardless of well-formedness, closed-set outcome type, a fresh tool
 * schema built per call from that exact candidate list) — the model is
 * structurally incapable of returning a category id that wasn't in the
 * list eBay itself just returned. Uses the SAME Anthropic client, API key,
 * and model as every other AI call in this app — no second provider, no
 * second key.
 */

export type EbayCategoryRankingCandidate = { categoryId: string; categoryName: string; categoryPath: string; relevancy: string | null };

export type EbayCategoryRankingInput = {
  brand: string | null;
  productType: string | null;
  model: string | null;
  set: string | null;
  searchTerms: string;
};

function buildTool(candidates: EbayCategoryRankingCandidate[]): Anthropic.Tool {
  const ids = candidates.map(c => c.categoryId);
  return {
    name: "select_ebay_category",
    description: "Choose the single best-matching eBay category id for this product from the supplied candidate list, or null if none genuinely fit. Call this exactly once.",
    input_schema: {
      type: "object",
      properties: {
        categoryId: {
          type: ["string", "null"], enum: [...ids, null],
          description: "The categoryId of the single best-matching candidate, or null if none confidently fit. Must be exactly one of the supplied candidate ids, or null — never any other value, never an invented id.",
        },
        reason: { type: "string", description: "One short factual sentence explaining the match (e.g. 'Matches a sealed trading card game box'). Empty string if categoryId is null." },
      },
      required: ["categoryId", "reason"],
      additionalProperties: false,
    },
  };
}

function buildSystemPrompt(candidates: EbayCategoryRankingCandidate[]): string {
  const list = candidates.map(c => `${c.categoryId}: ${c.categoryPath}`).join("\n");
  return "You choose the single best-matching eBay UK category for one physical product, using only the structured facts already extracted for it, via the select_ebay_category tool. You must call that tool exactly once. "
    + "You may ONLY return a category id that appears in the candidate list below, or null — never invent an id, never return one that is not listed, and never return free text. Every listed candidate is already a genuine, currently-valid eBay leaf category — you are ranking real options, never inventing one. "
    + "Prefer the most specific matching category over a broader one. If you are not genuinely confident any candidate fits this exact product, return null rather than guessing.\n\n"
    + `Candidates (id: full category path):\n${list}`;
}

function outputSchema(candidates: EbayCategoryRankingCandidate[]) {
  const ids = new Set(candidates.map(c => c.categoryId));
  return z.object({
    categoryId: z.string().nullable().refine(value => value === null || ids.has(value), { message: "categoryId must be one of the supplied candidates, or null." }),
    reason: z.string().max(300),
  }).strict();
}

export type EbayCategoryRankingAiOutcome =
  | { status: "success"; categoryId: string | null; reason: string; model: string; inputTokens: number; outputTokens: number }
  | { status: "not_configured" }
  | { status: "request_failed" }
  | { status: "no_tool_call" }
  | { status: "invalid_output" };

export async function runEbayCategoryRanking(input: EbayCategoryRankingInput, candidates: EbayCategoryRankingCandidate[]): Promise<EbayCategoryRankingAiOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };

  const tool = buildTool(candidates);
  const userText = `Search terms used: ${input.searchTerms}\nBrand: ${input.brand ?? "unknown"}\nProduct type: ${input.productType ?? "unknown"}\nModel: ${input.model ?? "unknown"}\nSet: ${input.set ?? "unknown"}`;

  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 256, system: buildSystemPrompt(candidates),
      tools: [tool], tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: userText }],
    });
  } catch {
    return { status: "request_failed" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === tool.name);
  if (!toolUse) return { status: "no_tool_call" };

  const validated = outputSchema(candidates).safeParse(toolUse.input);
  if (!validated.success) return { status: "invalid_output" };

  return {
    status: "success", categoryId: validated.data.categoryId, reason: validated.data.reason,
    model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
  };
}

export function describeEbayCategoryRankingFailure(status: Exclude<EbayCategoryRankingAiOutcome["status"], "success">): string {
  switch (status) {
    case "not_configured": return "Category ranking is not available right now.";
    case "request_failed": return "Category ranking failed.";
    case "no_tool_call": return "Category ranking did not return a structured result.";
    case "invalid_output": return "Category ranking returned an unexpected result.";
  }
}
