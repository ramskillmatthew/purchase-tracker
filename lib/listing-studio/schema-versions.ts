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
  // v5 (Milestone 6, Vinted-aware colours/materials): `colour: {value,
  // confidence}` (free-text string) was replaced by `colours: {value,
  // confidence}` (value is now a string[] of up to 2 exact Vinted enum
  // values), and a new `material: {value, confidence}` field was added
  // (value is a single exact Vinted enum value or null) — a genuine
  // response-shape change to the tool's JSON schema.
  // v6 (2026-08-04 follow-up correction): a new `vintedAudience: {value,
  // confidence}` field added (value one of mens/womens/boys/girls/unisex/
  // unknown) — a genuine response-shape change, and now the ONLY source
  // Vinted category audience is derived from (never sourceSize.gender).
  // v7 (2026-08-05 follow-up correction): a new `vintedAudienceEvidence:
  // string[]` field added, sibling to vintedAudience — a genuine
  // response-shape change forcing the model to name the actual signal(s)
  // it relied on, never a confidence percentage.
  generation: "listing-generation-schema-v7",
  // v2: the tool's response shape changed from an arbitrary imageIds list
  // per group to a contiguous sequence range (startSequenceIndex/
  // endSequenceIndex/orderedImageIds/continuesFromPreviousChunk) — ordered
  // boundary detection, not free clustering. Prior run rows recorded under
  // schema-v1 remain readable as-is; nothing reads them back as input to
  // this version's logic, so no migration of old rows is needed.
  product_grouping: "listing-product-grouping-schema-v2",
  // v1 (Milestone 7, Vinted category catalogue sync): { vintedCategoryId:
  // number | null } — the tool must choose one of the supplied candidate
  // ids, or null; never re-validated by shape alone (the route also
  // checks the id was genuinely one of the supplied candidates AND is
  // still active/selectable in the catalogue table before it's ever
  // persisted — see app/api/listing-studio/groups/[draftId]/generate/route.ts).
  category_selection: "listing-category-selection-schema-v1",
  // v1 (2026-08-05 follow-up correction): { vintedAudience: string,
  // vintedAudienceEvidence: string[] } — see
  // lib/listing-studio/vinted-audience-reassessment-ai.ts.
  audience_reassessment: "listing-audience-reassessment-schema-v1",
};
