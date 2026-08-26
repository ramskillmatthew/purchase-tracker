/**
 * Milestone 7 follow-up (2026-08-03) — AI category-selection cost
 * tracking. Best-effort USD estimates from Anthropic's own published base
 * (non-cached, non-batch) per-million-token rates
 * (https://platform.claude.com/docs/en/about-claude/pricing, verified
 * 2026-08-03) — never a fabricated number. Matched by substring against
 * the configured model id (this app never hardcodes a full model string;
 * ANTHROPIC_MODEL is an env var, and Anthropic's own ids carry
 * version-specific suffixes this table can't fully predict), in order,
 * first match wins. A model this table doesn't recognise returns null —
 * tokens/model/candidate-count are still always recorded regardless (see
 * vinted_category_selection_ai_calls), only the dollar estimate is
 * best-effort.
 *
 * Claude Sonnet 5's $2/$10 rate is INTRODUCTORY, in effect only through
 * 2026-08-31 (rising to $3/$15 on 2026-09-01 per Anthropic's own pricing
 * page) — this table will need updating after that date to stay accurate.
 */
const ANTHROPIC_BASE_PRICING_USD_PER_MILLION_TOKENS: { match: RegExp; input: number; output: number }[] = [
  { match: /fable-?5/i, input: 10, output: 50 },
  { match: /mythos-?5/i, input: 10, output: 50 },
  { match: /opus-?4[.-]1(?!\d)/i, input: 15, output: 75 },
  { match: /opus-?4(?![.-]\d)/i, input: 15, output: 75 }, // bare "opus-4" (retired Opus 4)
  { match: /opus-?5|opus-?4[.-][5-8]/i, input: 5, output: 25 },
  { match: /sonnet-?5/i, input: 2, output: 10 }, // introductory rate through 2026-08-31
  { match: /sonnet-?4[.-][4-6]|sonnet-?4(?![.-]\d)/i, input: 3, output: 15 },
  { match: /haiku-?4[.-]5/i, input: 1, output: 5 },
  { match: /haiku-?3[.-]5/i, input: 0.8, output: 4 },
];

/** Returns null (never a guessed number) when the model isn't recognised, or either token count is missing. */
export function estimateAnthropicCostUsd(model: string | null, inputTokens: number | null, outputTokens: number | null): number | null {
  if (!model || inputTokens === null || inputTokens === undefined || outputTokens === null || outputTokens === undefined) return null;
  const pricing = ANTHROPIC_BASE_PRICING_USD_PER_MILLION_TOKENS.find((p) => p.match.test(model));
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
