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
};
