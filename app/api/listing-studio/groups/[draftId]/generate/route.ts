import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { MAX_GENERATION_IMAGES_PER_GROUP } from "@/lib/listing-studio/upload-limits";
import { prepareListingGenerationImageInputs } from "@/lib/listing-studio/listing-generation-image-input";
import { runListingGenerationAnalysis } from "@/lib/listing-studio/listing-generation-ai";
import { describeListingGenerationFailure } from "@/lib/listing-studio/listing-generation-schemas";
import { generateListingTitle, generateListingDescription, LISTING_CONDITION_TEXT, type GeneratedListingFields } from "@/lib/listing-studio/listing-template";
import { deriveUkSizeFromSource } from "@/lib/listing-studio/size-conversion";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";
import { resolveVintedCategoryAssignment, describeVintedCategoryAssignmentReason } from "@/lib/listing-studio/vinted-category-assignment";
import { normaliseFootwearVintedAudience, normaliseFootwearListingText, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { canonicaliseVintedBrand } from "@/lib/listing-studio/vinted-brand-canonicalisation";
import { estimateAnthropicCostUsd } from "@/lib/listing-studio/anthropic-pricing";
import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import { z } from "zod";
import { marketplaceSchema } from "@/lib/validation/listing-studio-marketplace";
import { buildEbayDraftFromGeneratedFields } from "@/lib/listing-studio/ebay-draft-generation";
import { upsertMarketplaceDraft, getMarketplaceSettingsDefaults } from "@/lib/listing-studio/marketplace-drafts";
import { resolveMarketplaceSettings, defaultContentModeForSourceType } from "@/lib/listing-studio/marketplace-settings";
import { marketplaceDraftSettingsSchema } from "@/lib/validation/listing-studio-marketplace";
import type { Marketplace } from "@/lib/listing-studio/marketplace-types";

export const runtime = "nodejs";
export const maxDuration = 60;

const UNSORTED_TITLE = "Unsorted";

// Stage 2 (marketplace-aware drafts): defaults to VINTED-only, matching
// this route's exact pre-existing behaviour when a caller sends no body
// at all — every existing caller (GroupingWorkspace.tsx's
// handleGenerateListings, every pre-existing test) keeps working
// completely unchanged. "targets" only ever names real marketplaces
// (never the UI-only "BOTH" concept — see
// lib/listing-studio/marketplace-types.ts's marketplacesForTarget, which
// the CLIENT uses to expand "Both" into ["VINTED","EBAY_UK"] before this
// route ever sees the request).
// Stage 3 (eBay draft settings) — an optional BATCH-level settings override
// for this one generate call, sitting between account defaults (lowest
// priority — see lib/listing-studio/marketplace-drafts.ts's
// getMarketplaceSettingsDefaults) and a per-draft override (highest —
// listing_marketplace_drafts.settings_json, not touched here since this
// route only ever creates/regenerates a fresh draft). Never persisted
// anywhere: this app has no standing "batch" entity for Listing Studio
// generation, so it lives only as long as this one request.
const generateRequestSchema = z.object({
  targets: z.array(marketplaceSchema).min(1).default(["VINTED"]),
  ebaySettings: marketplaceDraftSettingsSchema.optional(),
});

type DraftRow = {
  id: string; title: string | null; uk_size: string | null; uk_size_source: string | null;
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
  vinted_category_status: string | null;
  vinted_audience: VintedAudienceValue | null; vinted_audience_source: "ai" | "manual" | null;
  suggested_price_pence: number | null; confirmed_price_pence: number | null;
};
type CategoryRunOutcome = { status: "success" | "failed"; errorMessage: string | null; responseJson: unknown };
type ImageRow = { id: string; storage_path: string; mime_type: string };

/**
 * Generates ONE product group's listing: sends every one of its own
 * uploaded photos to Claude for structured field extraction ONLY (never a
 * title/description — see listing-generation-schemas.ts's own top
 * comment), then derives the title/description from those fields via
 * listing-template.ts's pure functions and persists everything. Called
 * once per eligible group by the client's "Generate Listings" bulk action
 * (components/listing-studio/GroupingWorkspace.tsx), one request per
 * group, sequentially — a product group's own photo count is naturally
 * small and bounded (MAX_GENERATION_IMAGES_PER_GROUP), unlike Milestone 3's
 * whole-Unsorted-session chunking, so no cross-request session
 * reconciliation is needed: every group is generated fully independently.
 *
 * On failure, nothing about the draft's stored fields is touched (no
 * partial/guessed data is ever written) — only an audit row is recorded,
 * so a retry is always safe and simply repeats the same call.
 */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const { targets, ebaySettings } = generateRequestSchema.parse(await request.json().catch(() => ({})));
    const targetSet = new Set<Marketplace>(targets);

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,title,uk_size,uk_size_source,vinted_category_id,vinted_category_path,vinted_category_source,vinted_category_status,vinted_audience,vinted_audience_source,suggested_price_pence,confirmed_price_pence`,
    );
    const draft = drafts[0];
    if (!draft) return NextResponse.json({ error: "Group not found." }, { status: 404 });
    if (draft.title === UNSORTED_TITLE) return NextResponse.json({ error: "Cannot generate a listing for the Unsorted group." }, { status: 400 });

    const images = await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=eq.${draftId}&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id,storage_path,mime_type&order=sort_order.asc`,
    );
    if (!images.length) return NextResponse.json({ error: "This group has no photos to generate a listing from." }, { status: 400 });
    // A generous, defensive bound — see MAX_GENERATION_IMAGES_PER_GROUP's own comment.
    const eligibleImages = images.slice(0, MAX_GENERATION_IMAGES_PER_GROUP);

    const { blocks } = await prepareListingGenerationImageInputs(
      eligibleImages.map(image => ({ id: image.id, storagePath: image.storage_path, mimeType: image.mime_type })),
      LISTING_STUDIO_BUCKET,
    );
    if (!blocks.length) return NextResponse.json({ error: "Could not prepare any of this group's photos for analysis." }, { status: 502 });

    const model = process.env.ANTHROPIC_MODEL ?? null;
    const startedAt = new Date().toISOString();
    const outcome = await runListingGenerationAnalysis(blocks);
    const completedAt = new Date().toISOString();

    if (outcome.status !== "success") {
      await supabaseRequest("listing_analysis_runs", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, stage: "generation", status: "failed",
          model, prompt_version: LISTING_PROMPT_VERSIONS.generation, schema_version: LISTING_SCHEMA_VERSIONS.generation,
          error_message: describeListingGenerationFailure(outcome.status), started_at: startedAt, completed_at: completedAt,
        }),
      }).catch(() => {});
      const status = outcome.status === "not_configured" ? 503 : 502;
      return NextResponse.json({ error: describeListingGenerationFailure(outcome.status) }, { status });
    }

    const fields = outcome.data;

    // Milestone 4 sizing correction, then sizing coverage correction: the
    // AI only ever reports the size exactly as printed (system + value +
    // category, if the label states it) — it never converts. A directly
    // observed UK size is used as-is; an EU/US size is converted
    // deterministically, brand-aware with a category-separated generic
    // fallback (lib/listing-studio/size-conversion.ts) — never estimated
    // or interpolated, and null whenever no exact table (brand-specific or
    // fallback) covers this system/category/value combination.
    const derived = deriveUkSizeFromSource({
      brand: fields.brand.value,
      sourceSizeSystem: fields.sourceSize.system,
      sourceSizeValue: fields.sourceSize.value,
      sourceSizeGender: fields.sourceSize.gender,
    });
    // An existing UK size (set by a prior generation, or manually entered
    // via Edit fields) is never silently overwritten by a later generate
    // call — only a currently-blank UK size (and its provenance) is ever
    // filled in here.
    const finalUkSize = draft.uk_size ?? derived.ukSize;
    const finalUkSizeSource = draft.uk_size ? draft.uk_size_source : derived.provenance;

    // Item family is classified from the AI's raw productType text before
    // any children's-wording cleanup below — the keyword match (e.g.
    // "trainers"/"shoes") is unaffected by an extra word like "Youth", so
    // there is no ordering hazard in deriving it first.
    const draftItemFamily = deriveDraftItemFamily(fields.productType.value);

    // Follow-up correction (2026-08-04): audience now comes from the AI's
    // own independent vintedAudience field, never sourceSize.gender — see
    // listing-generation-schemas.ts's own comment on exactly why. Run only
    // if this draft's category isn't already a manual choice (never
    // silently overwritten by regeneration — same rule as finalUkSize
    // above). resolveVintedCategoryAssignment is deterministic-first (a
    // single unambiguous match needs no AI call at all) and never throws;
    // only a genuinely SUCCESSFUL, validated outcome ever changes the
    // stored category — any other outcome leaves it exactly as it was, so
    // a bad/failed attempt can never destroy a previously good one.
    // A manually-corrected audience (Edit Fields) is just as sticky as a
    // manually-chosen category — never silently overwritten by a later
    // regenerate with a fresh (possibly still wrong) AI guess.
    const rawFinalVintedAudience = draft.vinted_audience_source === "manual" ? draft.vinted_audience : fields.vintedAudience.value;
    const finalVintedAudienceSource: "ai" | "manual" = draft.vinted_audience_source === "manual" ? "manual" : "ai";
    // Business-rule follow-up correction: footwear must never persist a
    // children's Vinted audience — normalised here immediately, before
    // either persistence or category resolution below, and regardless of
    // source (a legacy manual boys/girls pick predating this rule is
    // corrected too, same as a fresh AI one).
    const finalVintedAudience = normaliseFootwearVintedAudience(rawFinalVintedAudience, draftItemFamily);
    // Follow-up correction (2026-08-05): the factual evidence backing an
    // AI-determined audience — null whenever the audience is a manual
    // pick (a manual choice has no AI evidence, and showing stale AI
    // evidence next to it would be misleading).
    const finalVintedAudienceEvidence = finalVintedAudienceSource === "manual" ? null : fields.vintedAudienceEvidence;

    // Business-rule follow-up correction (children's wording in
    // customer-facing text): footwear listed as Women's must never carry
    // Youth/Kids/Junior/Boys/Girls/Child/Children wording in its title —
    // the STRUCTURED source fields (model/productType) are cleaned here,
    // before title/description generation, rather than scrubbing only the
    // rendered title string — so the same clean values are what's actually
    // persisted, displayed in Edit Fields, and re-derived from on every
    // future regeneration.
    const structuredFields: GeneratedListingFields = {
      brand: canonicaliseVintedBrand(fields.brand.value),
      model: normaliseFootwearListingText(fields.model.value, draftItemFamily, finalVintedAudience),
      productType: normaliseFootwearListingText(fields.productType.value, draftItemFamily, finalVintedAudience),
      colours: fields.colours.value, material: fields.material.value, ukSize: finalUkSize, sku: fields.sku.value,
    };
    const generatedTitle = generateListingTitle(structuredFields);
    const generatedDescription = generateListingDescription(structuredFields);

    let categoryId = draft.vinted_category_id;
    let categoryPath = draft.vinted_category_path;
    let categorySource = draft.vinted_category_source;
    let categoryStatus = draft.vinted_category_status;
    let categoryRunOutcome: CategoryRunOutcome | null = null;
    let categoryAiCostLog: { model: string | null; inputTokens: number | null; outputTokens: number | null; candidateCount: number; status: "success" | "failed" } | null = null;

    if (draft.vinted_category_source !== "manual") {
      const { result, aiCost } = await resolveVintedCategoryAssignment({
        vintedAudience: finalVintedAudience, productType: structuredFields.productType,
        brand: structuredFields.brand, model: structuredFields.model,
      });
      categoryStatus = result.reason;
      categoryAiCostLog = aiCost;
      if (result.reason === "category_assigned") {
        categoryId = result.categoryId;
        categoryPath = result.categoryPath;
        categorySource = "ai";
        categoryRunOutcome = { status: "success", errorMessage: null, responseJson: { vintedCategoryId: result.categoryId, method: result.method } };
      } else {
        categoryRunOutcome = { status: "failed", errorMessage: describeVintedCategoryAssignmentReason(result.reason), responseJson: { reason: result.reason } };
      }
    }

    // The structured fields + derived title/description are the real,
    // load-bearing write — never swallowed on failure (unlike the audit
    // row below), so a failure here surfaces as a genuine error rather
    // than silently reporting success with nothing actually saved.
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        brand: structuredFields.brand, model: structuredFields.model, product_type: structuredFields.productType,
        colours: structuredFields.colours, material: structuredFields.material, uk_size: finalUkSize, uk_size_source: finalUkSizeSource, sku: structuredFields.sku,
        source_size_system: fields.sourceSize.system, source_size_value: fields.sourceSize.value,
        source_size_gender: fields.sourceSize.gender,
        vinted_audience: finalVintedAudience, vinted_audience_source: finalVintedAudienceSource, vinted_audience_evidence: finalVintedAudienceEvidence,
        vinted_category_id: categoryId, vinted_category_path: categoryPath, vinted_category_source: categorySource, vinted_category_status: categoryStatus,
        condition: LISTING_CONDITION_TEXT,
        generated_title: generatedTitle, generated_description: generatedDescription,
        status: "ready", ai_result_json: fields, updated_at: completedAt,
      }),
    });

    await supabaseRequest("listing_analysis_runs", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        draft_id: draftId, owner_id: user.id, stage: "generation", status: "success",
        model, prompt_version: LISTING_PROMPT_VERSIONS.generation, schema_version: LISTING_SCHEMA_VERSIONS.generation,
        response_json: fields, started_at: startedAt, completed_at: completedAt,
      }),
    }).catch(() => {});

    if (categoryRunOutcome) {
      await supabaseRequest("listing_analysis_runs", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, stage: "category_selection", status: categoryRunOutcome.status,
          model, prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
          response_json: categoryRunOutcome.responseJson, error_message: categoryRunOutcome.errorMessage,
          started_at: completedAt, completed_at: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    // Milestone 7 follow-up (cost tracking) — only ever recorded when the
    // bounded category-selection AI call was ACTUALLY made (never for a
    // deterministic single-candidate match, which needed no AI call at
    // all) — see supabase-listing-studio.sql's vinted_category_selection_ai_calls.
    if (categoryAiCostLog) {
      await supabaseRequest("vinted_category_selection_ai_calls", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, model: categoryAiCostLog.model,
          input_tokens: categoryAiCostLog.inputTokens, output_tokens: categoryAiCostLog.outputTokens,
          prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
          candidate_count: categoryAiCostLog.candidateCount,
          estimated_cost_usd: estimateAnthropicCostUsd(categoryAiCostLog.model, categoryAiCostLog.inputTokens, categoryAiCostLog.outputTokens),
          status: categoryAiCostLog.status,
        }),
      }).catch(() => {});
    }

    // Stage 2 (marketplace-aware drafts): additive only — reuses the SAME
    // `fields`/`finalUkSize` the Vinted logic above already computed from
    // this one photo-analysis call, so selecting "eBay UK" or "Both" never
    // triggers a second AI call or a second photo upload. Never touches
    // anything written above; the eBay draft lives entirely in its own
    // listing_marketplace_drafts row (see that table's own header comment
    // in supabase-listing-studio-marketplace.sql for why it's a separate
    // table rather than a replacement of the Vinted-shaped columns above).
    let ebayDraft: Awaited<ReturnType<typeof buildEbayDraftFromGeneratedFields>> | null = null;
    if (targetSet.has("EBAY_UK")) {
      const accountDefaults = await getMarketplaceSettingsDefaults(user.id, "EBAY_UK");
      const resolvedSettings = resolveMarketplaceSettings(accountDefaults, ebaySettings, null);
      const contentMode = ebaySettings?.contentMode ?? accountDefaults.contentMode ?? defaultContentModeForSourceType("generated");
      const pricePence = draft.confirmed_price_pence ?? draft.suggested_price_pence;
      const generation = buildEbayDraftFromGeneratedFields({
        fields, ukSize: finalUkSize, hasPhoto: eligibleImages.length > 0, pricePence, quantity: resolvedSettings.quantity,
      });
      ebayDraft = generation;
      await upsertMarketplaceDraft({
        productDraftId: draftId, ownerId: user.id, marketplace: "EBAY_UK",
        sourceType: "generated", contentMode,
        title: generation.title, description: generation.description,
        conditionValue: generation.conditionValue,
        pricePence, quantity: resolvedSettings.quantity, currency: "GBP",
        status: generation.status, readiness: generation.readiness, validationMessages: generation.validationMessages,
        aiGeneration: { model, promptVersion: LISTING_PROMPT_VERSIONS.generation, schemaVersion: LISTING_SCHEMA_VERSIONS.generation, generatedAt: completedAt },
      });
    }

    return NextResponse.json({
      draftId,
      brand: structuredFields.brand, model: structuredFields.model, productType: structuredFields.productType,
      colours: structuredFields.colours, material: structuredFields.material, ukSize: structuredFields.ukSize, sku: structuredFields.sku,
      condition: LISTING_CONDITION_TEXT,
      generatedTitle, generatedDescription, status: "ready",
      vintedAudience: finalVintedAudience, vintedAudienceSource: finalVintedAudienceSource, vintedAudienceEvidence: finalVintedAudienceEvidence,
      vintedCategoryId: categoryId, vintedCategoryPath: categoryPath, vintedCategorySource: categorySource, vintedCategoryStatus: categoryStatus,
      ...(ebayDraft ? { ebayDraft: { title: ebayDraft.title, description: ebayDraft.description, status: ebayDraft.status, readiness: ebayDraft.readiness, validationMessages: ebayDraft.validationMessages } } : {}),
    });
  } catch (error) { return safeApiError(error, "Could not generate this listing."); }
}
