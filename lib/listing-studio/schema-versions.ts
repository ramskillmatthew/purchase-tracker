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
  // v2 (Milestone 4): response shape changed entirely — from the unused
  // Stage 1 listingGenerationResultSchema (title/description/brand/model/
  // .../suggestedPricePence/searchKeywords, AI-authored title+description)
  // to { brand, model, productType, colour, ukSize, sku } each as
  // {value, confidence}, plus notes — no title/description field at all.
  // v3 (Milestone 4 sizing correction): `ukSize: {value, confidence}` was
  // removed entirely, replaced by `sourceSize: {system, value, gender,
  // confidence}` — the AI reports only what's printed on the label; the
  // application derives ukSize deterministically (lib/listing-studio/size-conversion.ts).
  // v4 (Milestone 4 sizing coverage correction): sourceSize.gender's enum
  // gained a 4th value, "childrens" — a genuine response-shape change to
  // the tool's JSON schema (LISTING_GENERATION_TOOL), not just prompt wording.
  generation: "listing-generation-schema-v4",
  // v2: the tool's response shape changed from an arbitrary imageIds list
  // per group to a contiguous sequence range (startSequenceIndex/
  // endSequenceIndex/orderedImageIds/continuesFromPreviousChunk) — ordered
  // boundary detection, not free clustering. Prior run rows recorded under
  // schema-v1 remain readable as-is; nothing reads them back as input to
  // this version's logic, so no migration of old rows is needed.
  product_grouping: "listing-product-grouping-schema-v2",
};
