import "server-only";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { VINTED_AUDIENCE_VALUES, VINTED_AUDIENCE_GUIDANCE, type VintedAudienceValue } from "./listing-generation-schemas";
import type { PreparedListingImageBlock } from "./listing-generation-image-input";

/**
 * Follow-up correction (2026-08-05) — re-determines JUST vintedAudience
 * (+ evidence) for an already-generated draft, without touching brand/
 * model/productType/colours/material/size/SKU. Two variants, both
 * sharing VINTED_AUDIENCE_GUIDANCE with the main generation prompt so the
 * reasoning never drifts:
 *
 *  - runVintedAudienceTextReassessment: text-only, no images — reuses
 *    this draft's already-stored brand/model/productType/prior evidence.
 *    Cheap (no image tokens at all). This is the automatic step
 *    "Assign category" tries first, per this milestone's own "reassess
 *    audience from stored data before returning Audience required, do
 *    not rerun full photo analysis unless genuinely insufficient".
 *  - runVintedAudiencePhotoReassessment: re-examines this draft's actual
 *    stored photos with a narrow, audience-only tool (cheaper than the
 *    full propose_listing_fields extraction, but still a real photo-based
 *    call with real cost) — only ever invoked by the explicit "Reassess
 *    audience" action, never automatically.
 */

const TOOL_NAME = "reassess_vinted_audience";

const outputSchema = z.object({
  vintedAudience: z.enum(VINTED_AUDIENCE_VALUES),
  vintedAudienceEvidence: z.array(z.string().trim().min(1).max(200)).max(6),
}).strict();

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Report the Vinted marketplace audience for this one product, plus the factual evidence behind it. Call this exactly once. Work through the priority-ordered evidence described in the system prompt — never decide from size alone, and never default to \"unknown\" without genuinely weighing the evidence available.",
  input_schema: {
    type: "object",
    properties: {
      vintedAudience: { type: "string", enum: [...VINTED_AUDIENCE_VALUES] },
      vintedAudienceEvidence: {
        type: "array", items: { type: "string" }, maxItems: 6,
        description: "Short factual statements naming the specific signal(s) relied on, e.g. \"Model identified as the men's version\". Empty array only if vintedAudience is \"unknown\" with genuinely nothing to cite. Never a confidence percentage.",
      },
    },
    required: ["vintedAudience", "vintedAudienceEvidence"],
    additionalProperties: false,
  },
};

export type VintedAudienceReassessmentInput = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  priorVintedAudience: VintedAudienceValue | null;
  priorEvidence: string[] | null;
};

export type VintedAudienceReassessmentOutcome =
  | { status: "success"; vintedAudience: VintedAudienceValue; vintedAudienceEvidence: string[]; model: string; inputTokens: number; outputTokens: number }
  | { status: "not_configured" }
  | { status: "request_failed" }
  | { status: "no_tool_call" }
  | { status: "invalid_output" };

function describeInput(input: VintedAudienceReassessmentInput): string {
  const lines = [
    `Brand: ${input.brand ?? "unknown"}`,
    `Model: ${input.model ?? "unknown"}`,
    `Product type: ${input.productType ?? "unknown"}`,
  ];
  if (input.priorVintedAudience) lines.push(`Previous audience determination: ${input.priorVintedAudience}`);
  if (input.priorEvidence && input.priorEvidence.length) lines.push(`Previous evidence considered: ${input.priorEvidence.join("; ")}`);
  return lines.join("\n");
}

async function callTool(system: string, content: Anthropic.MessageParam["content"]): Promise<VintedAudienceReassessmentOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey || !model) return { status: "not_configured" };

  let response: Anthropic.Message;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model, max_tokens: 300, system,
      tools: [TOOL], tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content }],
    });
  } catch {
    return { status: "request_failed" };
  }

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME);
  if (!toolUse) return { status: "no_tool_call" };

  const validated = outputSchema.safeParse(toolUse.input);
  if (!validated.success) return { status: "invalid_output" };

  return {
    status: "success", vintedAudience: validated.data.vintedAudience, vintedAudienceEvidence: validated.data.vintedAudienceEvidence,
    model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
  };
}

/** Cheap, text-only reassessment — no images, no new photo cost. Reuses this draft's already-stored structured fields. */
export async function runVintedAudienceTextReassessment(input: VintedAudienceReassessmentInput): Promise<VintedAudienceReassessmentOutcome> {
  const system = "You re-determine the Vinted marketplace audience for ONE physical product using ONLY the text facts given to you — you are NOT shown any photos this time, so rely on the model/style knowledge and brand knowledge tiers of the priority order below; if the previous attempt already considered label/photo evidence and still landed on \"unknown\", and you have no additional text-only signal beyond what's already listed, it is correct to also return \"unknown\" rather than inventing something new. "
    + VINTED_AUDIENCE_GUIDANCE;
  return callTool(system, describeInput(input));
}

/** More expensive — re-examines this draft's actual stored photos. Only ever called from the explicit "Reassess audience" action, never automatically. */
export async function runVintedAudiencePhotoReassessment(images: PreparedListingImageBlock[], input: VintedAudienceReassessmentInput): Promise<VintedAudienceReassessmentOutcome> {
  const system = "You re-determine the Vinted marketplace audience for ONE physical product, shown its photos again specifically to look for audience evidence (label/department text, model/style-code knowledge, design). "
    + VINTED_AUDIENCE_GUIDANCE;
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: describeInput(input) }];
  images.forEach((image, index) => {
    content.push({ type: "text", text: `Photo ${index + 1}` });
    content.push(image.content);
  });
  return callTool(system, content);
}

export function describeVintedAudienceReassessmentFailure(status: Exclude<VintedAudienceReassessmentOutcome["status"], "success">): string {
  switch (status) {
    case "not_configured": return "Audience reassessment is not available right now.";
    case "request_failed": return "Audience reassessment failed.";
    case "no_tool_call": return "Audience reassessment did not return a structured result.";
    case "invalid_output": return "Audience reassessment returned an unexpected result.";
  }
}
