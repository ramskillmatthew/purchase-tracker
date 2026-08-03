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
  // v2 (Milestone 4): the Stage 1-planned 5-pass pipeline (image_quality/
  // label_extraction/visual_identification/consistency_check/generation,
  // culminating in an AI-authored title/description) was never actually
  // wired up to any real route — v1 above was unused. This milestone's
  // real "generation" call is a single, direct structured-extraction pass
  // per product group (lib/listing-studio/listing-generation-schemas.ts)
  // that never returns a title or description at all; the application
  // derives those from the structured fields (lib/listing-studio/listing-template.ts).
  // v3 (Milestone 4 sizing correction): the SIZE instructions were rewritten
  // entirely — the AI no longer reports a UK size directly; it reports
  // sourceSize (system/value/gender exactly as printed on the label, UK
  // preferred over EU over US, never converted). See
  // lib/listing-studio/size-conversion.ts for the deterministic conversion
  // this replaced AI-side guessing with.
  // v4 (Milestone 4 sizing coverage correction): the SIZE instructions gained
  // a 4th sourceSize.gender value, "childrens" — reported only when the
  // label itself states it (e.g. "Kids"/"Youth"/"Toddler" wording), never
  // inferred from the shoe's general style.
  generation: "listing-generation-v4",
  // v3: replaces free-clustering with ordered boundary detection — a real
  // 24-photo/3-pair test still over-split two of three products under v2
  // (the model's own reasoning admitted a fragment might be the same item
  // as another group), proving similarity-based clustering was the wrong
  // primary task for a workflow where photos are uploaded in photography
  // order. See AUTO_GROUP_SYSTEM_PROMPT's own comment.
  product_grouping: "listing-product-grouping-v3",
};
