import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AI_SYSTEM_PROMPT, EXTRACT_PURCHASE_ORDER_TOOL, aiOrderSchema, isSupportedCurrency, toParsedOrder, type AiExtractionOutcome } from "./ai-schema";

export type { AiExtractionOutcome };

/**
 * Claude-based structured-extraction fallback — used only when the
 * deterministic parsers (lib/vinted/parser.ts, lib/purchase-import/parser.ts)
 * produced an incomplete or ambiguous result for an email the retrieval
 * layer has *already* shortlisted as a likely purchase confirmation. Never
 * scans a mailbox itself and never receives more than the one bounded
 * email it's called with — the sync route decides which shortlisted
 * emails are ambiguous enough to warrant this call.
 *
 * REGRESSION: this used to ask Claude to return free-form JSON text in its
 * message content and parse it with JSON.parse — nothing actually
 * constrained the model to that shape despite the system prompt asking
 * for it, and in a real-mailbox run every single AI-assisted email was
 * rejected as a result. It now forces exactly one call to the
 * `extract_purchase_order` tool via `tool_choice` — the model can only
 * ever respond with a structured `tool_use` block, never prose. The
 * returned `input` is still re-validated against the same strict
 * `aiOrderSchema` before use; a well-formed tool call is not itself
 * trusted, only a tool call that also passes validation is.
 *
 * The email's own content (subject/body) is passed only inside the user
 * turn's data, never as instructions — AI_SYSTEM_PROMPT explicitly tells
 * the model to treat it as untrusted data and never obey anything it says.
 */
export async function extractOrderWithAi(
  email: { messageId: string; sender: string; subject: string; date: string; text: string },
  context: { candidateType: "vinted" | "general"; fallbackPurchasedFrom: string },
): Promise<AiExtractionOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };

  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 1200, system: AI_SYSTEM_PROMPT,
      tools: [EXTRACT_PURCHASE_ORDER_TOOL],
      tool_choice: { type: "tool", name: EXTRACT_PURCHASE_ORDER_TOOL.name },
      messages: [{ role: "user", content: `From: ${email.sender}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.text.slice(0, 6000)}` }],
    });
  } catch {
    // Never log the raw error — it can carry request/response details.
    return { status: "request_failed" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === EXTRACT_PURCHASE_ORDER_TOOL.name);
  if (!toolUse) return { status: "no_tool_call" };

  const extractionResult = aiOrderSchema.safeParse(toolUse.input);
  if (!extractionResult.success) return { status: "invalid_output" };

  if (!isSupportedCurrency(extractionResult.data.currency)) return { status: "unsupported_currency" };

  const order = toParsedOrder(email, extractionResult.data, context);
  if (!order) return { status: "invalid_output" };
  return { status: "success", order };
}
