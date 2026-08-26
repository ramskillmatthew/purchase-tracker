import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { LISTING_GENERATION_SYSTEM_PROMPT, LISTING_GENERATION_TOOL, listingGenerationFieldsSchema, type ListingGenerationAiOutcome } from "./listing-generation-schemas";
import type { PreparedListingImageBlock } from "./listing-generation-image-input";

export type { ListingGenerationAiOutcome };

/**
 * Calls Claude once with every available photo of ONE already-created
 * product group, asking only for structured product fields (never a title
 * or description — see listing-generation-schemas.ts's own top comment).
 * Follows this codebase's one established AI-calling convention exactly
 * (lib/purchase-import/ai-extract.ts, lib/listing-studio/auto-group-ai.ts):
 * forces exactly one call to a single tool via `tool_choice`, never trusts
 * a well-formed tool call on its own — the returned `input` is always
 * re-validated against listingGenerationFieldsSchema regardless.
 */
export async function runListingGenerationAnalysis(images: PreparedListingImageBlock[]): Promise<ListingGenerationAiOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };

  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `You are shown ${images.length} photo${images.length === 1 ? "" : "s"} of one physical product. Identify its structured fields.` },
  ];
  images.forEach((image, index) => {
    content.push({ type: "text", text: `Photo ${index + 1}` });
    content.push(image.content);
  });

  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 1024, system: LISTING_GENERATION_SYSTEM_PROMPT,
      tools: [LISTING_GENERATION_TOOL],
      tool_choice: { type: "tool", name: LISTING_GENERATION_TOOL.name },
      messages: [{ role: "user", content }],
    });
  } catch {
    // Never log/surface the raw error — it can carry request/response details.
    return { status: "request_failed" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === LISTING_GENERATION_TOOL.name);
  if (!toolUse) return { status: "no_tool_call" };

  const validated = listingGenerationFieldsSchema.safeParse(toolUse.input);
  if (!validated.success) return { status: "invalid_output" };

  return { status: "success", data: validated.data };
}
