import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Stage 6 (eBay-specific generation) — a genuinely SEPARATE prompt/schema
 * from lib/listing-studio/listing-generation-schemas.ts's Vinted one. Never
 * calls the Vinted generator and relabels its result (the reported Fault
 * 1) — this is its own tool, its own system prompt, its own validation.
 *
 * Problem 2/3 fix — the AI NEVER writes the final title OR description
 * string itself. Brand/model/product type/colours/material/UK size/
 * audience all come from the SAME shared structured facts Vinted's own
 * generation already extracted (lib/listing-studio/listing-generation-schemas.ts).
 * This eBay-specific call supplies only the genuinely eBay-specific
 * ADDITIONAL facts that reuse alone can't provide:
 *   - the manufacturer style/product code (never the seller's own internal
 *     SKU — that's a separate, already-extracted field — see
 *     ebay-description-renderer.ts's own header comment for why), with its
 *     own confidence/evidence so a low-confidence guess never leaks into
 *     the title or description;
 *   - a few high-value buyer-search keywords;
 *   - honest, evidence-based CONDITION EVIDENCE (never final condition
 *     prose — lib/listing-studio/ebay-description-renderer.ts's
 *     resolveEbayConditionText is the one place that turns evidence into
 *     the final sentence, deterministically);
 *   - category search term hints;
 *   - anything it's unsure about.
 * lib/listing-studio/ebay-title-builder.ts (title) and
 * lib/listing-studio/ebay-description-renderer.ts (description) are the
 * ONLY two places that ever assemble final customer-facing text, from
 * these facts plus the shared Vinted-extracted ones — a fixed, ordered,
 * deterministic composition that makes Vinted-style
 * padding/quoting/repetition/markdown structurally impossible to produce,
 * not just discouraged by prompt wording.
 */

const shortText = z.string().trim().min(1).max(300).nullable();
const keywordArray = z.array(z.string().trim().min(1).max(30)).max(4);
const confidenceSchema = z.enum(["high", "medium", "low"]);

export const ebayListingGenerationOutputSchema = z.object({
  // Manufacturer style/product code (e.g. "M2002RST") — genuinely distinct
  // from the seller's own internal inventory SKU (already extracted
  // separately by the shared vision analysis — see
  // listing-generation-schemas.ts's own `sku` field). Only ever returned
  // when confidently established from a reliable source (a visible
  // label/tag, or well-established brand+model->code knowledge) — never
  // invented, never a guess dressed up as fact. The caller only ever
  // includes it in the title/description when confidence is "high".
  styleCode: z.string().trim().min(1).max(30).nullable(),
  styleCodeConfidence: confidenceSchema.nullable(),
  styleCodeEvidence: shortText,
  // High-value differentiators buyers actually search for (e.g.
  // "Lightweight", "Waterproof", "Factory Sealed") — ONLY when directly
  // evidenced, never invented to fill space. Max 4, enforced again by the
  // title builder's own 80-character cap regardless of what's returned here.
  otherKeywords: keywordArray,
  // Honest, evidence-based note about visible condition — NEVER final
  // condition prose (see this module's own top comment). Null when
  // nothing can be confidently said; the renderer then uses the standard
  // pre-owned wording, matching this business's own established default.
  conditionEvidence: shortText,
  // Free-text search terms for the EXISTING eBay category-suggestion
  // pipeline — an AI-suggested REFINEMENT/supplement the category service
  // may use instead when non-empty, never a replacement for that
  // deterministic builder's own safety rules.
  categorySearchTerms: z.array(z.string().trim().min(1).max(60)).max(6),
  // Anything the AI itself flagged as uncertain — surfaced to the owner,
  // never silently dropped.
  warnings: z.array(z.string().trim().min(1).max(300)).max(6),
}).strict();
export type EbayListingGenerationOutput = z.infer<typeof ebayListingGenerationOutputSchema>;

export const EBAY_LISTING_GENERATION_SYSTEM_PROMPT =
  "You are supplying FACTS for an eBay UK listing — NOT a Vinted listing, and you do NOT write the final title or description; deterministic code assembles those from verified facts. Use the propose_ebay_listing_facts tool exactly once. "
  + "Use ONLY the verified structured facts you are given below — never invent a brand, model, material, identifier, or claim you were not given. If something is uncertain, add it to `warnings` and leave the related field null rather than guessing. "
  + "`styleCode`: the MANUFACTURER's own style/product code (e.g. a New Balance code like \"M2002RST\", visible on a box label or tag, or confidently known from the brand+model). This is completely different from the seller's own internal inventory SKU sticker (that is tracked separately) — never confuse the two, and never return the internal SKU here. Only return a value when you are genuinely confident it's correct; otherwise null. `styleCodeConfidence` must honestly reflect how sure you are (\"high\" only when you would stake the listing's accuracy on it); `styleCodeEvidence` is a short note on where the code came from (e.g. \"visible on box label\") — null if styleCode is null. "
  + "`otherKeywords`: at most 4 short, high-value differentiators a real buyer searches for (e.g. \"Lightweight\", \"Waterproof\", \"Factory Sealed\") — ONLY when the given facts directly support them. \"Factory Sealed\"/\"New\"/\"Unopened\" must NEVER be included unless you were explicitly told the item is confirmed sealed/unopened. Never repeat a word already present in the given brand/model/product type/material/colour — e.g. if the material is \"Mesh\", never propose a keyword like \"Mesh Upper\" or \"Mesh Panels\"; that restates a fact already covered elsewhere in the title, it is not a differentiator. "
  + "`conditionEvidence`: one short, honest, factual note about visible condition ONLY if you were given real evidence to describe (e.g. visible wear, or a confirmed new/unused state) — null otherwise. Never invent flaws, never claim an item is new/sealed/unworn without being told so explicitly, and never write final marketing prose — a plain factual observation only (e.g. \"light scuffing on the toe\", \"unworn, tags still attached\"). "
  + "`categorySearchTerms`: up to 6 short search terms (brand, product line, product type, key attribute) suited to searching eBay's own category suggestion API — not marketing copy. "
  + "`warnings`: short notes about anything you were unsure about or could not verify — empty array if nothing. "
  + "NEVER include emojis, decorative symbols, quotation marks, ALL CAPS, seller marketing language (\"look\", \"wow\", \"must see\", \"best\", \"cheap\", \"bargain\"), bundle/discount offers, or advertising of other stock anywhere in your response.";

export function buildEbayListingGenerationTool(): Anthropic.Tool {
  return {
    name: "propose_ebay_listing_facts",
    description: "Report the eBay-specific structured facts (manufacturer style/product code, buyer-search keywords, condition evidence, category search terms, warnings) for one physical product already analysed. Call this exactly once. Never invent facts not given to you. Never write a final title or description — those are assembled deterministically from these facts.",
    input_schema: {
      type: "object",
      properties: {
        styleCode: { type: ["string", "null"], description: "The manufacturer's own style/product code, only if confidently known. Never the seller's internal SKU." },
        styleCodeConfidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
        styleCodeEvidence: { type: ["string", "null"], description: "Short note on where the style code came from, or null." },
        otherKeywords: { type: "array", items: { type: "string" }, maxItems: 4 },
        conditionEvidence: { type: ["string", "null"], description: "One short, honest factual note about visible condition, or null if genuinely unknown." },
        categorySearchTerms: { type: "array", items: { type: "string" }, maxItems: 6 },
        warnings: { type: "array", items: { type: "string" }, maxItems: 6 },
      },
      required: ["styleCode", "styleCodeConfidence", "styleCodeEvidence", "otherKeywords", "conditionEvidence", "categorySearchTerms", "warnings"],
      additionalProperties: false,
    },
  } as const;
}

// Phase 9 fix — stable, safe internal error codes distinct from the
// (unchanged, still status-driven) control-flow discriminator below. Never
// derived from a raw provider error string — only from the SDK's own
// typed error classes (status/type), which never carry the API key,
// request headers, or response body.
export type EbayAiErrorCode =
  | "EBAY_AI_NOT_CONFIGURED" | "EBAY_AI_AUTH_FAILED" | "EBAY_AI_RATE_LIMITED" | "EBAY_AI_TIMEOUT"
  | "EBAY_AI_INVALID_OUTPUT" | "EBAY_AI_VALIDATION_FAILED" | "EBAY_AI_UNKNOWN";

export type EbayListingGenerationAiOutcome =
  | { status: "success"; data: EbayListingGenerationOutput }
  | { status: "not_configured"; code: "EBAY_AI_NOT_CONFIGURED" }
  | { status: "request_failed"; code: Exclude<EbayAiErrorCode, "EBAY_AI_NOT_CONFIGURED" | "EBAY_AI_INVALID_OUTPUT" | "EBAY_AI_VALIDATION_FAILED"> }
  | { status: "no_tool_call"; code: "EBAY_AI_INVALID_OUTPUT" }
  // `issues` are Zod field paths + short messages only (e.g.
  // "warnings.1: String must contain at most 300 character(s)") — never
  // the model's own generated text, never anything provider- or
  // secret-bearing. Safe to log; safe to keep in memory only (never
  // persisted to the database — see ebay-draft-generation.ts).
  | { status: "invalid_output"; code: "EBAY_AI_VALIDATION_FAILED"; issues: string[] };

export function describeEbayListingGenerationFailure(status: Exclude<EbayListingGenerationAiOutcome["status"], "success">): string {
  switch (status) {
    case "not_configured": return "eBay listing generation is not available right now.";
    case "request_failed": return "eBay listing generation failed. Please try again.";
    case "no_tool_call": return "eBay listing generation did not return a structured result. Please try again.";
    case "invalid_output": return "eBay listing generation returned an unexpected result. Please try again.";
  }
}

// Repair pass (Phase 2 — "bounded retry/repair, not infinite retries"):
// applied ONCE, only when the raw tool input fails schema validation, and
// only to fields that are purely informational (never the title-building
// facts, never invented). Clamps any string exceeding its schema's own
// max length at the last whitespace boundary before the limit, rather
// than a raw mid-word cut — see the proven real 223-character warning
// case this exists to protect (schema max is 300 now, but this repair
// also protects against a rarer overrun beyond even that).
function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated).trim();
}

export function repairRawEbayListingGenerationOutput(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const repaired: Record<string, unknown> = { ...obj };

  // Deliberately clamps STRING LENGTH only, never array ITEM COUNT — an
  // over-length string is an honest model writing a genuinely useful
  // sentence a few characters too long (the proven real case); too MANY
  // items (5 otherKeywords when only 4 are allowed, say) is a sign the
  // model didn't follow the schema's own constraints and stays a genuine
  // validation failure rather than being silently trimmed away.
  if (typeof obj.styleCode === "string") repaired.styleCode = clampText(obj.styleCode, 30);
  if (typeof obj.styleCodeEvidence === "string") repaired.styleCodeEvidence = clampText(obj.styleCodeEvidence, 300);
  if (typeof obj.conditionEvidence === "string") repaired.conditionEvidence = clampText(obj.conditionEvidence, 300);
  if (Array.isArray(obj.categorySearchTerms)) {
    repaired.categorySearchTerms = obj.categorySearchTerms.map(term => typeof term === "string" ? clampText(term, 60) : term);
  }
  if (Array.isArray(obj.warnings)) {
    repaired.warnings = obj.warnings.map(warning => typeof warning === "string" ? clampText(warning, 300) : warning);
  }
  if (Array.isArray(obj.otherKeywords)) {
    repaired.otherKeywords = obj.otherKeywords.map(keyword => typeof keyword === "string" ? clampText(keyword, 30) : keyword);
  }
  return repaired;
}
