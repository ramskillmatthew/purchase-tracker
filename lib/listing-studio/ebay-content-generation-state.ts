import type { EbayAiErrorCode } from "@/lib/listing-studio/ebay-listing-generation-schemas";
import type { MarketplaceAspectValue, MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

/**
 * Phase 3 fix — one authoritative eBay CONTENT GENERATION state, distinct
 * from draft readiness (Phase 4) and stored WITHOUT a schema migration
 * (Phase 3: "If existing flexible JSON can support these fields reliably,
 * avoid an unnecessary migration") — reserved key __contentGeneration
 * inside listing_marketplace_drafts.dynamic_data_json, the exact same
 * pattern already established for __packageSize (see
 * ebay-package-suggestion.ts). Reusing the existing
 * MarketplaceAspectValue-shaped storage means zero new database risk;
 * the extra fields this needs (code/attemptCount/etc.) ride along as
 * additional JSON keys the strict MarketplaceAspectValue TYPE never sees
 * elsewhere (dynamicData's real per-aspect consumers only ever read
 * aspect names an eBay category actually defines — this reserved key,
 * like __packageSize, is never one of those).
 *
 * Proven root cause this state model fixes: before this, "generated" was
 * INFERRED from title/description being non-empty — but a FALLBACK row
 * (the 3-line deterministic recovery text) also has a non-empty title
 * and description, so it was indistinguishable from a genuine AI success
 * anywhere status was inferred that way (readiness, eligibility, product
 * card, counters).
 */
export const EBAY_CONTENT_GENERATION_STATES = ["not_started", "generating", "generated", "fallback", "failed"] as const;
export type EbayContentGenerationState = typeof EBAY_CONTENT_GENERATION_STATES[number];

export type EbayContentGenerationRecord = {
  state: EbayContentGenerationState;
  code: EbayAiErrorCode | null;
  message: string | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  generatedAt: string | null;
  model: string | null;
  usedFallback: boolean;
  warnings: string[];
};

const CONTENT_GENERATION_KEY = "__contentGeneration";

export const EBAY_CONTENT_GENERATION_STATE_LABELS: Record<EbayContentGenerationState, string> = {
  not_started: "Not generated",
  generating: "Generating…",
  generated: "Content generated",
  fallback: "Generation failed",
  failed: "Generation failed",
};

function defaultRecord(state: EbayContentGenerationState): EbayContentGenerationRecord {
  return { state, code: null, message: null, attemptCount: 0, lastAttemptedAt: null, generatedAt: null, model: null, usedFallback: false, warnings: [] };
}

/**
 * Phase 16 fix — backward compatibility for rows that predate this state
 * model. Never marks an existing row GENERATED merely because a title
 * exists (the exact mistake this whole fix corrects) — a legacy row with
 * no marker is inferred conservatively:
 *   - An imported exact-copy row (source_type=imported_ebay,
 *     content_mode=exact_copy) is treated as generated — it was never
 *     put through this AI pipeline at all, and its content is the
 *     seller's own real, previously-published listing.
 *   - Any other legacy row with real title/description content, but no
 *     explicit state marker, is inferred as GENERATED *once*, cautiously
 *     — never re-labelled FALLBACK retroactively (that would incorrectly
 *     imply a failure that was never actually recorded). This is a
 *     one-time, read-time inference; the very next successful/failed
 *     generation call writes a real, explicit record.
 *   - A row with neither title nor description is NOT_STARTED.
 */
export function readContentGenerationState(
  dynamicData: MarketplaceDynamicData | null | undefined,
  context: { sourceType: string; contentMode: string; hasTitle: boolean; hasDescription: boolean },
): EbayContentGenerationRecord {
  const raw = (dynamicData as Record<string, unknown> | null | undefined)?.[CONTENT_GENERATION_KEY];
  if (raw && typeof raw === "object" && "state" in raw) {
    const record = raw as Partial<EbayContentGenerationRecord>;
    if (typeof record.state === "string" && (EBAY_CONTENT_GENERATION_STATES as readonly string[]).includes(record.state)) {
      return {
        state: record.state as EbayContentGenerationState,
        code: record.code ?? null, message: record.message ?? null,
        attemptCount: typeof record.attemptCount === "number" ? record.attemptCount : 0,
        lastAttemptedAt: record.lastAttemptedAt ?? null, generatedAt: record.generatedAt ?? null,
        model: record.model ?? null, usedFallback: Boolean(record.usedFallback),
        warnings: Array.isArray(record.warnings) ? record.warnings.filter((w): w is string => typeof w === "string") : [],
      };
    }
  }

  // No explicit marker — legacy row, infer conservatively (see doc comment).
  if (context.sourceType === "imported_ebay" && context.contentMode === "exact_copy") {
    return { ...defaultRecord("generated"), usedFallback: false };
  }
  if (context.hasTitle && context.hasDescription) {
    return { ...defaultRecord("generated"), usedFallback: false };
  }
  return defaultRecord("not_started");
}

/** Builds the record for a genuinely successful AI generation. */
export function buildGeneratedRecord(input: { model: string | null; warnings: string[]; previousAttemptCount: number; now: string }): EbayContentGenerationRecord {
  return {
    state: "generated", code: null, message: null,
    attemptCount: input.previousAttemptCount + 1, lastAttemptedAt: input.now, generatedAt: input.now,
    model: input.model, usedFallback: false, warnings: input.warnings,
  };
}

/** Builds the record for a failed AI generation where a safe deterministic
 * fallback was still persisted (the FALLBACK state — never GENERATED,
 * always distinguishable, always eligible for Retry). */
export function buildFallbackRecord(input: { code: EbayAiErrorCode; message: string; previousAttemptCount: number; now: string }): EbayContentGenerationRecord {
  return {
    state: "fallback", code: input.code, message: input.message,
    attemptCount: input.previousAttemptCount + 1, lastAttemptedAt: input.now, generatedAt: null,
    model: null, usedFallback: true, warnings: [],
  };
}

/** Serialises a record back into the exact MarketplaceAspectValue-shaped
 * JSON object stored under the reserved key — matches __packageSize's own
 * convention (value/confidence/source/... plus extra fields) so nothing
 * else that reads dynamicData generically ever chokes on this key. */
export function serialiseContentGenerationRecord(record: EbayContentGenerationRecord): MarketplaceAspectValue & EbayContentGenerationRecord {
  return {
    value: record.state, confidence: "unknown", source: "system",
    appliedAutomatically: true, needsReview: record.state === "fallback" || record.state === "failed",
    userConfirmed: false, updatedAt: record.lastAttemptedAt ?? new Date().toISOString(),
    ...record,
  };
}

export { CONTENT_GENERATION_KEY };
