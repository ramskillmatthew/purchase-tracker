import "server-only";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Milestone 7 (Vinted category catalogue sync) — a second, separate,
 * text-only AI step run after the main "generation" stage (see
 * app/api/listing-studio/groups/[draftId]/generate/route.ts). Mirrors
 * lib/listing-studio/listing-generation-ai.ts's calling convention
 * exactly (forced single tool call, output re-validated regardless of
 * well-formedness, closed-set outcome type) with one deliberate
 * difference: the tool's own JSON schema is built FRESH for every call
 * from that draft's own small candidate list, so the model is
 * structurally incapable of returning an id that wasn't offered — never
 * given the full catalogue, never given photos, never allowed free text.
 */

export type VintedCategorySelectionCandidate = { id: number; fullPath: string };

export type VintedCategorySelectionInput = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  audience: string | null;
  itemFamily: string | null;
};

function buildTool(candidates: VintedCategorySelectionCandidate[]): Anthropic.Tool {
  const ids = candidates.map((c) => c.id);
  return {
    name: "select_vinted_category",
    description: "Choose the single best-matching Vinted category id for this product from the supplied candidate list, or null if none genuinely fit. Call this exactly once.",
    input_schema: {
      type: "object",
      properties: {
        vintedCategoryId: {
          type: ["number", "null"],
          enum: [...ids, null],
          description: "The id of the single best-matching candidate, or null if none confidently fit. Must be exactly one of the supplied candidate ids, or null — never any other value.",
        },
      },
      required: ["vintedCategoryId"],
      additionalProperties: false,
    },
  };
}

function buildSystemPrompt(candidates: VintedCategorySelectionCandidate[]): string {
  const list = candidates.map((c) => `${c.id}: ${c.fullPath}`).join("\n");
  return "You choose the single best-matching Vinted marketplace category for one physical product, using only the structured fields already extracted for it, via the select_vinted_category tool. You must call that tool exactly once. "
    + "You may ONLY return a category id that appears in the candidate list below, or null — never invent an id, never return one that is not listed, and never return free text. "
    + "Prefer the most specific matching category over a broader one. If you are not genuinely confident any candidate fits, return null rather than guessing.\n\n"
    + `Candidates (id: full category path):\n${list}`;
}

function outputSchema(candidates: VintedCategorySelectionCandidate[]) {
  const ids = new Set(candidates.map((c) => c.id));
  return z.object({
    vintedCategoryId: z.number().int().nullable().refine((value) => value === null || ids.has(value), {
      message: "vintedCategoryId must be one of the supplied candidates, or null.",
    }),
  }).strict();
}

export type VintedCategorySelectionAiOutcome =
  // model/inputTokens/outputTokens are always present on success — see
  // supabase-listing-studio.sql's vinted_category_selection_ai_calls
  // (Milestone 7 follow-up, cost tracking): every actual call this
  // function makes gets logged by its caller regardless of outcome, but
  // only "success" carries real usage numbers to log.
  | { status: "success"; vintedCategoryId: number | null; model: string; inputTokens: number; outputTokens: number }
  | { status: "not_configured" }
  | { status: "request_failed" }
  | { status: "no_tool_call" }
  | { status: "invalid_output" };

export async function runVintedCategorySelection(
  input: VintedCategorySelectionInput,
  candidates: VintedCategorySelectionCandidate[],
): Promise<VintedCategorySelectionAiOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };

  const tool = buildTool(candidates);
  const userText = `Product fields:\nBrand: ${input.brand ?? "unknown"}\nModel: ${input.model ?? "unknown"}\nProduct type: ${input.productType ?? "unknown"}\nAudience: ${input.audience ?? "unknown"}\nItem family: ${input.itemFamily ?? "unknown"}`;

  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 256, system: buildSystemPrompt(candidates),
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
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
    status: "success", vintedCategoryId: validated.data.vintedCategoryId,
    model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
  };
}

export function describeVintedCategorySelectionFailure(status: Exclude<VintedCategorySelectionAiOutcome["status"], "success">): string {
  switch (status) {
    case "not_configured": return "Category selection is not available right now.";
    case "request_failed": return "Category selection failed.";
    case "no_tool_call": return "Category selection did not return a structured result.";
    case "invalid_output": return "Category selection returned an unexpected result.";
  }
}
