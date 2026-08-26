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
  // v5 (Milestone 6, Vinted-aware colours/materials): COLOUR was rewritten
  // to COLOURS (up to 2, exact Vinted enum values only, empty array if
  // unclear) and a new MATERIAL instruction was added (single exact Vinted
  // enum value or null) — free-text colour/invented material can no
  // longer be published to Vinted, which only accepts its own fixed lists.
  // v6 (2026-08-04 follow-up correction): added a new, independent
  // VINTED AUDIENCE instruction (mens/womens/boys/girls/unisex/unknown),
  // determined from ALL evidence together, never from sourceSize.gender
  // alone — a real bug traced sourceSize.gender being null/unisex (very
  // common for footwear, whose size tags rarely print a gender marker) to
  // silently skipping Vinted category assignment entirely, with no
  // failure record. The SIZE instruction was also reworded to make clear
  // sourceSize.gender describes the size SCALE only and must never be
  // read as an audience signal.
  // v7 (2026-08-05 follow-up correction): real testing showed "unknown"
  // returned for clearly-gendered products, AND the one real generation
  // run in the live database showed the opposite failure — deciding
  // audience from shoe size alone ("at UK 5 / EU 37.5 this sits in the
  // womens size range"). VINTED AUDIENCE was rewritten with an explicit
  // 5-tier evidence priority order (label/department text > model-specific
  // knowledge > brand knowledge > design > size-as-support-only), an
  // explicit instruction that "unknown" must follow genuinely weighing
  // evidence rather than being a default, and a new required
  // vintedAudienceEvidence field forcing the model to name the actual
  // signal(s) used — which structurally discourages both a lazy "unknown"
  // (nothing to cite) and a size-only guess (size alone is explicitly
  // disqualified in the prompt).
  // v8 (business-rule follow-up correction — children's wording in
  // customer-facing text): MODEL and PRODUCT TYPE now explicitly forbid
  // age/gender qualifiers (Youth/Kids/GS/Junior/Toddler/Boys/Girls) in
  // their own reported value, even when the physical label/box prints one
  // alongside the model name (e.g. "Clifton 9 Youth" -> model "Clifton
  // 9") — a real listing surfaced "Youth" in a generated title despite the
  // item correctly being categorised as Women's. The deterministic
  // application-side helper (normaliseFootwearListingText, see
  // lib/listing-studio/vinted-category-selection.ts) remains the actual
  // enforcement point regardless of what the AI returns — this prompt
  // change only reduces how often it has anything to clean up.
  generation: "listing-generation-v8",
  // v3: replaces free-clustering with ordered boundary detection — a real
  // 24-photo/3-pair test still over-split two of three products under v2
  // (the model's own reasoning admitted a fragment might be the same item
  // as another group), proving similarity-based clustering was the wrong
  // primary task for a workflow where photos are uploaded in photography
  // order. See AUTO_GROUP_SYSTEM_PROMPT's own comment.
  product_grouping: "listing-product-grouping-v3",
  // v1 (Milestone 7, Vinted category catalogue sync): a new, separate,
  // text-only step — given only the structured fields already extracted
  // by "generation" plus a compact candidate list (id + full path) looked
  // up from the synced catalogue, picks one candidate id or null. Never
  // shown photos, never given the full catalogue, never allowed to invent
  // an id or free-text category — see
  // lib/listing-studio/vinted-category-selection-ai.ts.
  category_selection: "listing-category-selection-v1",
  // v1 (2026-08-05 follow-up correction) — a separate, bounded step that
  // re-determines JUST vintedAudience (+ evidence) for an already-generated
  // draft, either from stored text fields alone (cheap, no photos — the
  // default) or by re-examining the draft's stored photos with a narrow
  // audience-only tool (more expensive, only via the explicit "Reassess
  // audience" action) — see lib/listing-studio/vinted-audience-reassessment-ai.ts.
  audience_reassessment: "listing-audience-reassessment-v1",
};
