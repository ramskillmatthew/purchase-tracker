import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ParsedOrder } from "./types";
import { AI_SYSTEM_PROMPT, aiOrderSchema, toParsedOrder } from "./ai-schema";

/**
 * Claude-based structured-extraction fallback — used only when the
 * deterministic parsers (lib/vinted/parser.ts, lib/purchase-import/parser.ts)
 * produced an incomplete or ambiguous result for an email the retrieval
 * layer has *already* shortlisted as a likely purchase confirmation. Never
 * scans a mailbox itself and never receives more than the one bounded
 * email it's called with — the sync route decides which shortlisted
 * emails are ambiguous enough to warrant this call.
 *
 * Malformed or invalid model output is rejected by the strict
 * `aiOrderSchema` (see lib/purchase-import/ai-schema.ts) and this function
 * returns `null` — callers must fall through to human review rather than
 * trust an unvalidated shape.
 */
export async function extractOrderWithAi(
  email: { messageId: string; sender: string; subject: string; date: string; text: string },
  context: { candidateType: "vinted" | "general"; fallbackPurchasedFrom: string },
): Promise<ParsedOrder | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return null;

  let raw: string;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model, max_tokens: 1200, system: AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `From: ${email.sender}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.text.slice(0, 6000)}` }],
    });
    raw = response.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map(block => block.text).join("\n").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  } catch { return null; }

  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch { return null; }
  const extractionResult = aiOrderSchema.safeParse(parsedJson);
  if (!extractionResult.success) return null;
  return toParsedOrder(email, extractionResult.data, context);
}
