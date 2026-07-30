import type { ListingAnalysisStage } from "./types";

// Independent of LISTING_PROMPT_VERSIONS (lib/listing-studio/prompt-versions.ts)
// by design: prompt wording and the expected AI response JSON shape can each
// change on their own schedule. A prompt rewrite that doesn't alter the
// response shape only bumps LISTING_PROMPT_VERSIONS; a schema change (e.g.
// adding/removing a field in lib/listing-studio/ai-schemas.ts) only bumps
// this one. Never bump both just because one changed.
export const LISTING_SCHEMA_VERSIONS: Record<ListingAnalysisStage, string> = {
  image_quality: "listing-image-quality-schema-v1",
  label_extraction: "listing-label-extraction-schema-v1",
  visual_identification: "listing-visual-identification-schema-v1",
  consistency_check: "listing-consistency-check-schema-v1",
  generation: "listing-generation-schema-v1",
  // v2: the tool's response shape changed from an arbitrary imageIds list
  // per group to a contiguous sequence range (startSequenceIndex/
  // endSequenceIndex/orderedImageIds/continuesFromPreviousChunk) — ordered
  // boundary detection, not free clustering. Prior run rows recorded under
  // schema-v1 remain readable as-is; nothing reads them back as input to
  // this version's logic, so no migration of old rows is needed.
  product_grouping: "listing-product-grouping-schema-v2",
};
