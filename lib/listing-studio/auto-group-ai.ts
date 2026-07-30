import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AUTO_GROUP_SYSTEM_PROMPT, AUTO_GROUP_TOOL, autoGroupToolInputSchema, truncateOverlongBoundaryReasons, type AutoGroupAiOutcome } from "./auto-group-schemas";
import type { PreparedImageBlock } from "./auto-group-image-input";

export type { AutoGroupAiOutcome };

/**
 * Calls Claude once per chunk with that chunk's own photos, in their exact
 * sequence order, so it can detect PRODUCT BOUNDARIES in the sequence
 * rather than freely clustering an unordered set — see
 * lib/listing-studio/auto-group-schemas.ts's top-of-file comment for why
 * free clustering was replaced. Optionally preceded by a handful of
 * read-only "context" photos from the tail of the previous chunk, so the
 * model can judge whether this chunk's own first photo continues that same
 * product across the chunk boundary (`continuesFromPreviousChunk`) —
 * without ever being able to include those context photos in its own
 * response (reconciliation discards any attempt to do so, since they
 * aren't part of `chunkImages`' sequence range).
 *
 * Follows this codebase's one established AI-calling convention exactly
 * (lib/purchase-import/ai-extract.ts): forces exactly one call to a single
 * tool via `tool_choice`, never trusts a well-formed tool call on its own —
 * the returned `input` is re-validated against autoGroupToolInputSchema
 * regardless.
 */
export async function runAutoGroupAnalysis(
  chunkImages: PreparedImageBlock[],
  chunkStartSequenceIndex: number,
  overlapImages: PreparedImageBlock[] = [],
): Promise<AutoGroupAiOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: `You will be shown${overlapImages.length > 0 ? ` ${overlapImages.length} context photo${overlapImages.length === 1 ? "" : "s"} from the previous batch, then` : ""} ${chunkImages.length} new unsorted product photo${chunkImages.length === 1 ? "" : "s"} to analyse, in their exact order (sequence numbers ${chunkStartSequenceIndex}-${chunkStartSequenceIndex + chunkImages.length - 1}).`,
    },
  ];
  for (const image of overlapImages) {
    content.push({ type: "text", text: `Context photo (already assigned to an earlier product — do not include in any group below) — ID: ${image.imageId}` });
    content.push(image.content);
  }
  chunkImages.forEach((image, index) => {
    content.push({ type: "text", text: `Photo #${chunkStartSequenceIndex + index} — ID: ${image.imageId}` });
    content.push(image.content);
  });

  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 4000, system: AUTO_GROUP_SYSTEM_PROMPT,
      tools: [AUTO_GROUP_TOOL],
      tool_choice: { type: "tool", name: AUTO_GROUP_TOOL.name },
      messages: [{ role: "user", content }],
    });
  } catch {
    // Never log/surface the raw error — it can carry request/response details.
    return { status: "request_failed" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === AUTO_GROUP_TOOL.name);
  if (!toolUse) return { status: "no_tool_call" };

  // REGRESSION (v2, unchanged in v3; extended for warnings[] after a real
  // 38-photo run failed with code: too_big, maximum: 300 on warnings, not
  // boundaryReason): a genuinely valid range (correct photo ids, correct
  // contiguity, a real confidence value) must never be rejected purely
  // because one group's free text (boundaryReason or a warning) ran long —
  // truncate before validating, not after.
  const truncatedInput = truncateOverlongBoundaryReasons(toolUse.input);

  const validated = autoGroupToolInputSchema.safeParse(truncatedInput);
  if (!validated.success) return { status: "invalid_output" };

  return { status: "success", data: validated.data };
}
