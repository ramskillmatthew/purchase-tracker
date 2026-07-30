import type { ListingAnalysisStage } from "./types";

// Every AI stage's current prompt version, stored on every
// listing_analysis_runs row (Stage 1 spec §18) so a later prompt change
// never loses track of which version produced a given result. Bump the
// suffix (v1 -> v2) when a stage's prompt changes in a way that could alter
// its output shape or behaviour — never edit a version string in place.
export const LISTING_PROMPT_VERSIONS: Record<ListingAnalysisStage, string> = {
  image_quality: "listing-image-quality-v1",
  label_extraction: "listing-label-extraction-v1",
  visual_identification: "listing-visual-identification-v1",
  consistency_check: "listing-consistency-check-v1",
  generation: "listing-generation-v1",
  // v3: replaces free-clustering with ordered boundary detection — a real
  // 24-photo/3-pair test still over-split two of three products under v2
  // (the model's own reasoning admitted a fragment might be the same item
  // as another group), proving similarity-based clustering was the wrong
  // primary task for a workflow where photos are uploaded in photography
  // order. See AUTO_GROUP_SYSTEM_PROMPT's own comment.
  product_grouping: "listing-product-grouping-v3",
};
