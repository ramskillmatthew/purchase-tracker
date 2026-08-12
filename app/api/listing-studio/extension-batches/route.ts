import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getVintedCategoriesByIds, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";
import { normaliseFootwearVintedAudience, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { buildListingWarnings, type ReadinessCheckFields } from "@/lib/listing-studio/listing-review";
import { generatePairingCode, hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";
import { MAX_EXTENSION_BATCH_LISTINGS, EXTENSION_BATCH_EXPIRY_SECONDS } from "@/lib/listing-studio/extension-batch-schema";
import { enforceRateLimit } from "@/lib/security/activity";
import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";

export const runtime = "nodejs";
export const maxDuration = 30;

// Batch creation itself is cheap (no photo I/O — that only happens when
// the extension actually fetches the payload/photos), but still bounded:
// this is the one owner-authenticated action that mints a fresh
// human-typeable pairing code, so it gets the same enforceRateLimit
// treatment every other owner-triggered action with a real cost/exposure
// surface in this app already uses.
const RATE_LIMIT_MAX_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

const createBatchRequestSchema = z.object({
  draftIds: z.array(uuidSchema).min(1).max(MAX_EXTENSION_BATCH_LISTINGS),
}).strict();

type DraftRow = {
  id: string;
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  vinted_audience: VintedAudienceValue | null;
  vinted_category_id: number | null; vinted_category_status: string | null;
  confirmed_price_pence: number | null;
};
type ImageRow = { id: string; draft_id: string; upload_state: string };
type RejectedListing = { draftId: string; sku: string | null; reasons: string[] };

/**
 * Listings Review redesign — root-cause fix for status/counts appearing
 * stale after a page reload (or simply reopening the tab): activeBatchId
 * previously lived only in this component's own React state, so a batch
 * created in an earlier page load was completely invisible to a fresh
 * mount — no polling, no activity, no live workflow status, even while
 * the extension was genuinely still processing it. This returns EVERY
 * one of the owner's batches that is still genuinely visible in the grid
 * — either still in flight (not completed/cancelled/expired, and not
 * past its real expiry — a 'pending_claim'/'claimed'/'in_progress' row
 * whose expires_at has already passed is treated as gone, never
 * resurrected) or terminal but not yet dismissed (box_dismissed_at is
 * still null) — so the client can resume tracking/displaying all of them
 * on mount. Multi-batch: never narrows to "the" active batch, since more
 * than one may legitimately be in flight at once. Read-only,
 * owner-scoped, no photo I/O.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const batches = await supabaseRequestAll<{ id: string; status: string; expires_at: string; display_number: number }>(
      `vinted_extension_batches?owner_id=eq.${user.id}&box_dismissed_at=is.null`
      + `&select=id,status,expires_at,display_number&order=created_at.desc`,
    );
    const visible = batches.filter(batch => {
      const isLive = batch.status === "pending_claim" || batch.status === "claimed" || batch.status === "in_progress";
      return isLive ? new Date(batch.expires_at).getTime() > Date.now() : true;
    });
    return NextResponse.json({
      batchIds: visible.map(batch => ({ batchId: batch.id, displayNumber: batch.display_number })),
    });
  } catch (error) { return safeApiError(error, "Could not check for active batches."); }
}

// Only a recognized, expected conflict from
// rpc/listing_studio_create_extension_batch is ever reported back as a
// clean 409/validation-style response. Anything else (a missing
// migration/function, malformed input, a database outage, a permission
// problem) is genuinely unexpected and must fail the request safely and
// visibly via safeApiError below, never silently absorbed here — same
// discipline as lib/purchase-import/rpc-errors.ts's own classifyRpcError.
function isDraftAlreadyActiveConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("DRAFT_ALREADY_IN_ACTIVE_BATCH");
}

/**
 * Milestone 7 (Chrome extension draft queue) — creates a short-lived,
 * single-use extension batch for up to MAX_EXTENSION_BATCH_LISTINGS Ready
 * listings, and returns a fresh pairing code (visible in plaintext exactly
 * once, in this response, to the authenticated owner who just requested
 * it — never logged, never stored anywhere but its hash).
 *
 * All-or-nothing, same as the ZIP export route: if ANY selected listing
 * fails a fresh server-side Ready re-check, the WHOLE request is rejected
 * with the specific reasons and NO batch is created — never a batch that
 * silently contains fewer items than the owner selected.
 *
 * Multi-batch support — creating this batch never touches, cancels, or
 * supersedes any other batch: there is no "one active batch per owner"
 * check anywhere in this route or the RPC it calls. The only thing that
 * can reject creation (besides normal readiness) is a SPECIFIC selected
 * draft already sitting in a different batch that is itself still live —
 * checked and enforced atomically inside
 * rpc/listing_studio_create_extension_batch (see supabase-listing-studio.sql),
 * which also allocates this batch's reusable "Batch N" display number in
 * the same atomic step. Two concurrent calls to this route (even for the
 * same owner) can never both succeed for an overlapping draft set, and can
 * never allocate the same display number — see that RPC's own comment.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds } = createBatchRequestSchema.parse(await request.json());
    await enforceRateLimit(user.id, "extension_batch_create", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const uniqueDraftIds = [...new Set(draftIds)];
    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=in.(${uniqueDraftIds.join(",")})&owner_id=eq.${user.id}`
      + `&select=id,brand,model,product_type,colours,material,uk_size,sku,condition,generated_title,generated_description,vinted_audience,vinted_category_id,vinted_category_status,confirmed_price_pence`,
    );
    const draftsById = new Map(drafts.map(d => [d.id, d]));

    const rejected: RejectedListing[] = uniqueDraftIds
      .filter(id => !draftsById.has(id))
      .map(id => ({ draftId: id, sku: null, reasons: ["Listing not found."] }));
    const foundIds = uniqueDraftIds.filter(id => draftsById.has(id));

    const images = foundIds.length ? await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=in.(${foundIds.join(",")})&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id,draft_id,upload_state`,
    ) : [];
    const photoCountByDraftId = new Map<string, number>();
    for (const image of images) photoCountByDraftId.set(image.draft_id, (photoCountByDraftId.get(image.draft_id) ?? 0) + 1);

    const categoryIds = foundIds.map(id => draftsById.get(id)!.vinted_category_id).filter((id): id is number => id !== null);
    const categoriesById = await getVintedCategoriesByIds(categoryIds);

    for (const id of foundIds) {
      const draft = draftsById.get(id)!;
      const itemFamily = deriveDraftItemFamily(draft.product_type);
      const audience = normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily);
      const category = draft.vinted_category_id ? categoriesById.get(draft.vinted_category_id) ?? null : null;

      const readinessFields: ReadinessCheckFields = {
        brand: draft.brand, model: draft.model, productType: draft.product_type, colours: draft.colours ?? [], material: draft.material,
        ukSize: draft.uk_size, sku: draft.sku,
        generatedTitle: draft.generated_title ?? "", generatedDescription: draft.generated_description ?? "",
        condition: draft.condition,
        vintedAudience: audience,
        vintedCategoryId: draft.vinted_category_id, vintedCategoryValid: isPublishableVintedCategory(category), vintedCategoryStatus: draft.vinted_category_status,
        hasPhoto: (photoCountByDraftId.get(id) ?? 0) > 0,
        sellingPricePence: draft.confirmed_price_pence,
      };
      const warnings = buildListingWarnings(readinessFields);
      if (warnings.length > 0) rejected.push({ draftId: id, sku: draft.sku, reasons: warnings });
    }

    if (rejected.length > 0) {
      return NextResponse.json({ error: "One or more selected listings are not ready to send to the extension.", rejected }, { status: 400 });
    }

    const pairingCode = generatePairingCode();
    const pairingCodeHash = hashPairingCode(pairingCode);
    const expiresAtIso = new Date(Date.now() + EXTENSION_BATCH_EXPIRY_SECONDS * 1000).toISOString();

    let created: { batch_id: string; display_number: number };
    try {
      const rpcResponse = await supabaseRequest("rpc/listing_studio_create_extension_batch", {
        method: "POST",
        body: JSON.stringify({
          p_owner_id: user.id, p_pairing_code_hash: pairingCodeHash, p_expires_at: expiresAtIso, p_draft_ids: foundIds,
        }),
      });
      const [row] = await rpcResponse.json() as { batch_id: string; display_number: number }[];
      created = row;
    } catch (error) {
      if (isDraftAlreadyActiveConflict(error)) {
        return NextResponse.json({
          error: "One or more selected listings are already part of another active batch. Wait for that batch to finish, or choose different listings.",
          rejected: [],
        }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({
      batchId: created.batch_id, displayNumber: created.display_number, pairingCode, expiresAt: expiresAtIso, listingCount: foundIds.length,
    });
  } catch (error) { return safeApiError(error, "Could not create a Chrome extension batch."); }
}
