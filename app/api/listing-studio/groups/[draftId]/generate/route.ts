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

export const runtime = "nodejs";
export const maxDuration = 60;

const UNSORTED_TITLE = "Unsorted";

type DraftRow = { id: string; title: string | null; uk_size: string | null; uk_size_source: string | null };
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
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const drafts = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,title,uk_size,uk_size_source`);
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

    const structuredFields: GeneratedListingFields = {
      brand: fields.brand.value, model: fields.model.value, productType: fields.productType.value,
      colour: fields.colour.value, ukSize: finalUkSize, sku: fields.sku.value,
    };
    const generatedTitle = generateListingTitle(structuredFields);
    const generatedDescription = generateListingDescription(structuredFields);

    // The structured fields + derived title/description are the real,
    // load-bearing write — never swallowed on failure (unlike the audit
    // row below), so a failure here surfaces as a genuine error rather
    // than silently reporting success with nothing actually saved.
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        brand: structuredFields.brand, model: structuredFields.model, product_type: structuredFields.productType,
        colour: structuredFields.colour, uk_size: finalUkSize, uk_size_source: finalUkSizeSource, sku: structuredFields.sku,
        source_size_system: fields.sourceSize.system, source_size_value: fields.sourceSize.value,
        source_size_gender: fields.sourceSize.gender,
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

    return NextResponse.json({
      draftId,
      brand: structuredFields.brand, model: structuredFields.model, productType: structuredFields.productType,
      colour: structuredFields.colour, ukSize: structuredFields.ukSize, sku: structuredFields.sku,
      condition: LISTING_CONDITION_TEXT,
      generatedTitle, generatedDescription, status: "ready",
    });
  } catch (error) { return safeApiError(error, "Could not generate this listing."); }
}
