import { readContentGenerationState, type EbayContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { readEbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";
import { resolveCategoryReviewState, readCategoryConfirmation } from "@/lib/listing-studio/ebay-category-review";
import type { MarketplaceDynamicData, MarketplaceReadiness } from "@/lib/listing-studio/marketplace-types";

/**
 * Phase 6/13 fix — a genuinely eBay-specific product-card status,
 * completely separate from ProductGroupCard.tsx's own `computeStatus`
 * (which stays exactly as-is — the Vinted status source of truth, "Do not
 * let the new eBay status logic alter Vinted behaviour"). The caller picks
 * ONE of these two functions to render, based on which marketplace is
 * currently selected (GroupingWorkspace's own `generationTarget`) — never
 * both blended into one ambiguous badge.
 *
 * Never green "Ready" for fallback content, and never derived from
 * title/description alone — see ebay-content-generation-state.ts's own
 * top comment for exactly why that was the proven bug.
 */
export type EbaySummary = {
  contentState: EbayContentGenerationState;
  // Regression fix (proven root cause of "eBay-only generation makes the
  // draft inaccessible") — the workspace route already fetched these from
  // listing_marketplace_drafts but never included them in the summary it
  // sent the client, so the product card had no eBay-specific title to
  // fall back to and showed "Product 1" forever. Every eBay-aware
  // display surface (card title, Preview's mounting condition) reads
  // these from this ONE shared summary, never a second fetch.
  title: string | null;
  description: string | null;
  categoryId: string | null;
  conditionValue: string | null;
  pricePence: number | null;
  quantity: number | null;
  readiness: MarketplaceReadiness | null;
  // Live-diagnostic follow-up fix (proven root cause of an unexplained
  // "Needs review" badge) — the ONE genuine count of unresolved review
  // reasons (a category still needing confirmation, or a REQUIRED/
  // RECOMMENDED item specific flagged needsReview and not yet confirmed).
  // computeEbayCardStatus below reads ONLY this — never infers "review"
  // from incomplete recommended-field counts again, which was the actual
  // bug: 7 blank recommended fields with zero real review reasons among
  // them produced this exact false "Needs review" for the screenshot
  // reproduction.
  reviewReasonCount: number;
  categoryReviewReason: string | null;
};

export type EbayCardStatus =
  | "not_generated" | "generating" | "generation_failed"
  | "needs_category" | "needs_condition" | "needs_price" | "needs_details" | "needs_review"
  | "draft_complete";

export const EBAY_CARD_STATUS_LABELS: Record<EbayCardStatus, string> = {
  not_generated: "Not generated",
  generating: "Generating…",
  generation_failed: "Generation failed",
  needs_category: "Needs category",
  needs_condition: "Needs condition",
  needs_price: "Needs price",
  needs_details: "Needs details",
  needs_review: "Needs review",
  draft_complete: "Draft details complete",
};

/** Red only for a genuine failure; amber for anything still incomplete;
 * green only for real completion; muted/primary for the two neutral
 * states — matches Phase 6's own "never colour alone" + tone rules. Text/
 * label is always shown alongside (EBAY_CARD_STATUS_LABELS above), so
 * colour is never the only signal. */
export type EbayCardStatusTone = "neutral" | "primary" | "danger" | "warning" | "success";
export const EBAY_CARD_STATUS_TONES: Record<EbayCardStatus, EbayCardStatusTone> = {
  not_generated: "neutral", generating: "primary", generation_failed: "danger",
  needs_category: "warning", needs_condition: "warning", needs_price: "warning", needs_details: "warning", needs_review: "warning",
  draft_complete: "success",
};

/**
 * Builds the ONE canonical `EbaySummary` a product card's status derives
 * from, straight off the persisted `listing_marketplace_drafts` row —
 * `row.price_pence` is read here and nowhere else is a second, independent
 * price ever invented for this summary. Moved here (out of
 * app/api/listing-studio/workspace/route.ts, a route.ts file whose exports
 * are restricted by Next.js's own route-handler convention — see that
 * file's own comment) so this exact mapping — not a reimplementation of it
 * — can be exercised directly in tests, proving the real price-save ->
 * summary -> card-status path end to end.
 */
/** Counts genuine, unresolved review reasons only — a category still
 * needing confirmation (via the SAME resolveCategoryReviewState the
 * dialog's own review summary reads from, so the row and the dialog can
 * never disagree about "why"), plus any REAL (non-reserved, non-`__`-
 * prefixed) item specific the aspect-resolution pipeline itself already
 * flagged `needsReview: true` and the owner hasn't yet confirmed. Blank
 * optional/recommended fields are never counted — they simply aren't
 * "flagged for review" at all, they're just not yet filled in. */
function countReviewReasons(row: {
  category_id: string | null; category_name: string | null; category_path: string | null;
  category_confidence: "high" | "medium" | "low" | null; category_source: "ai" | "manual" | null;
  dynamic_data_json: MarketplaceDynamicData | null;
}): { count: number; categoryReviewReason: string | null } {
  const productFacts = readEbayProductFacts(row.dynamic_data_json);
  const categoryReview = resolveCategoryReviewState({
    categoryId: row.category_id, categoryName: row.category_name, categoryPath: row.category_path,
    categoryConfidence: row.category_confidence, categorySource: row.category_source,
    itemFamily: productFacts?.itemFamily ?? "uncertain", ukShoeSize: productFacts?.ukShoeSize ?? null,
    confirmedForCategoryId: readCategoryConfirmation(row.dynamic_data_json),
  });

  let aspectReviewCount = 0;
  for (const [name, aspect] of Object.entries(row.dynamic_data_json ?? {})) {
    if (name.startsWith("__")) continue; // reserved pseudo-aspect, never a real item specific
    if (aspect?.needsReview && !aspect.userConfirmed) aspectReviewCount += 1;
  }

  return { count: (categoryReview.needsReview ? 1 : 0) + aspectReviewCount, categoryReviewReason: categoryReview.reason };
}

export function buildEbaySummary(row: {
  title: string | null; description: string | null; source_type: string; content_mode: string;
  dynamic_data_json: MarketplaceDynamicData | null; category_id: string | null; category_name: string | null; category_path: string | null;
  category_confidence: "high" | "medium" | "low" | null; category_source: "ai" | "manual" | null;
  condition_value: string | null; price_pence: number | null; quantity: number | null; readiness_json: MarketplaceReadiness | null;
}): EbaySummary & { contentStateCode: string | null; contentStateMessage: string | null; attemptCount: number } {
  const record = readContentGenerationState(row.dynamic_data_json, {
    sourceType: row.source_type, contentMode: row.content_mode,
    hasTitle: Boolean(row.title), hasDescription: Boolean(row.description),
  });
  const { count: reviewReasonCount, categoryReviewReason } = countReviewReasons(row);
  return {
    contentState: record.state,
    contentStateCode: record.code,
    contentStateMessage: record.message,
    attemptCount: record.attemptCount,
    title: row.title,
    description: row.description,
    categoryId: row.category_id,
    conditionValue: row.condition_value,
    pricePence: row.price_pence,
    quantity: row.quantity,
    readiness: row.readiness_json,
    reviewReasonCount,
    categoryReviewReason,
  };
}

export function computeEbayCardStatus(ebay: EbaySummary | null, isGenerating: boolean): EbayCardStatus {
  if (isGenerating) return "generating";
  if (!ebay || ebay.contentState === "not_started") return "not_generated";
  // Bug fix (the exact reported symptom): a FALLBACK or FAILED row must
  // never read as anything but a failure here, regardless of what other
  // fields happen to be set.
  if (ebay.contentState === "fallback" || ebay.contentState === "failed") return "generation_failed";

  // contentState === "generated" from here on — blocking gaps checked in
  // the same priority order the eBay details dialog now shows them in.
  if (!ebay.categoryId) return "needs_category";
  if (!ebay.conditionValue) return "needs_condition";
  if (!ebay.pricePence) return "needs_price";
  if (!ebay.quantity) return "needs_details";
  if (ebay.readiness && !ebay.readiness.ready) return "needs_details";
  // PROVEN ROOT CAUSE FIX — this used to be
  // `readiness.recommendedTotal > readiness.recommendedComplete`, which
  // meant ANY blank recommended field (there are often many, and most are
  // genuinely optional-in-practice) produced "Needs review" with no
  // visible reason anywhere in the dialog. reviewReasonCount is a genuine
  // count of real, actionable review reasons (an unresolved category
  // confirmation, or a specific item specific flagged needsReview) — see
  // buildEbaySummary's own countReviewReasons. Missing recommended/
  // optional fields alone can never produce this state.
  if (ebay.reviewReasonCount > 0) return "needs_review";
  return "draft_complete";
}
