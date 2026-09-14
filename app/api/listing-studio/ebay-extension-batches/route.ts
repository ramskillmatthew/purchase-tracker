import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { generatePairingCode, hashPairingCode } from "@/lib/listing-studio/extension-pairing-code";
import { MAX_EBAY_EXTENSION_BATCH_LISTINGS, EBAY_EXTENSION_BATCH_EXPIRY_SECONDS } from "@/lib/listing-studio/ebay-extension-batch-schema";
import { enforceRateLimit } from "@/lib/security/activity";
import { SERVER_BUILD_ID, SUPABASE_PROJECT_REF } from "@/lib/listing-studio/server-diagnostics";

export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_LIMIT_MAX_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

const createBatchRequestSchema = z.object({
  marketplaceDraftIds: z.array(uuidSchema).min(1).max(MAX_EBAY_EXTENSION_BATCH_LISTINGS),
}).strict();

type MarketplaceDraftRow = {
  id: string; product_draft_id: string; marketplace: string; title: string | null; description: string | null;
  category_id: string | null; condition_value: string | null; price_pence: number | null; quantity: number | null;
};
type ImageRow = { id: string; draft_id: string };

/**
 * eBay Seller Hub extension drafter — mirrors
 * app/api/listing-studio/extension-batches/route.ts's own GET/POST
 * structure, scoped to ebay_extension_batches and EBAY_UK marketplace
 * drafts. REQUIREMENT (legacy-offer/blocker audit, carried forward): this
 * route's readiness check never reads ebay_offer_id — a legacy,
 * unpublished Inventory API offer must never block sending to the
 * extension. It DOES require a genuinely usable eBay preparation (title,
 * description, category, condition, price, quantity, at least one photo)
 * — the same content-readiness bar Create Seller Hub draft already uses,
 * reused here rather than re-invented, since "ready to draft" is the same
 * real question either pipeline asks.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    type OwnerBatchRow = { id: string; status: string; expires_at: string; display_number: number; box_dismissed_at: string | null };
    const batches = await supabaseRequestAll<OwnerBatchRow>(
      `ebay_extension_batches?owner_id=eq.${user.id}&select=id,status,expires_at,display_number,box_dismissed_at&order=created_at.desc`,
    );
    const now = Date.now();
    const visible = batches.filter(batch => {
      if (batch.box_dismissed_at !== null) return false;
      const isLive = batch.status === "pending_claim" || batch.status === "claimed" || batch.status === "in_progress";
      return isLive ? new Date(batch.expires_at).getTime() > now : true;
    });
    return NextResponse.json({ batchIds: visible.map(batch => ({ batchId: batch.id, displayNumber: batch.display_number })) });
  } catch (error) { return safeApiError(error, "Could not check for active eBay extension batches."); }
}

function isDraftAlreadyActiveConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("DRAFT_ALREADY_IN_ACTIVE_BATCH");
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { marketplaceDraftIds } = createBatchRequestSchema.parse(await request.json());
    await enforceRateLimit(user.id, "ebay_extension_batch_create", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const uniqueIds = [...new Set(marketplaceDraftIds)];
    const drafts = await supabaseRequestAll<MarketplaceDraftRow>(
      `listing_marketplace_drafts?id=in.(${uniqueIds.join(",")})&owner_id=eq.${user.id}&marketplace=eq.EBAY_UK`
      + `&select=id,product_draft_id,marketplace,title,description,category_id,condition_value,price_pence,quantity`,
    );
    const draftsById = new Map(drafts.map(d => [d.id, d]));

    const rejected: Array<{ marketplaceDraftId: string; reasons: string[] }> = uniqueIds
      .filter(id => !draftsById.has(id))
      .map(id => ({ marketplaceDraftId: id, reasons: ["eBay preparation not found."] }));
    const foundIds = uniqueIds.filter(id => draftsById.has(id));

    const productDraftIds = foundIds.map(id => draftsById.get(id)!.product_draft_id);
    const images = productDraftIds.length ? await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=in.(${productDraftIds.join(",")})&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id,draft_id`,
    ) : [];
    const photoCountByDraftId = new Map<string, number>();
    for (const image of images) photoCountByDraftId.set(image.draft_id, (photoCountByDraftId.get(image.draft_id) ?? 0) + 1);

    for (const id of foundIds) {
      const draft = draftsById.get(id)!;
      const reasons: string[] = [];
      if (!draft.title) reasons.push("Missing eBay title.");
      if (!draft.description) reasons.push("Missing eBay description.");
      if (!draft.category_id) reasons.push("Missing eBay category.");
      if (!draft.condition_value) reasons.push("Missing eBay condition.");
      if (!draft.price_pence || draft.price_pence <= 0) reasons.push("Missing eBay selling price.");
      if (!draft.quantity || draft.quantity <= 0) reasons.push("Missing quantity.");
      if ((photoCountByDraftId.get(draft.product_draft_id) ?? 0) === 0) reasons.push("No uploaded photos.");
      if (reasons.length > 0) rejected.push({ marketplaceDraftId: id, reasons });
    }

    if (rejected.length > 0) {
      return NextResponse.json({ error: "One or more selected listings are not ready to send to the eBay extension.", rejected }, { status: 400 });
    }

    const pairingCode = generatePairingCode();
    const pairingCodeHash = hashPairingCode(pairingCode);
    const expiresAtIso = new Date(Date.now() + EBAY_EXTENSION_BATCH_EXPIRY_SECONDS * 1000).toISOString();

    // CORRECTIVE PASS 6 (retry truthfulness review) — a genuine retry is
    // this SAME action, unchanged: the create RPC itself derives
    // retry_of_item_id server-side (the most recent genuinely 'failed'
    // item for this owner+listing, if any — see its own comment in
    // supabase-ebay-extension-batches.sql). Nothing here ever resets or
    // overwrites that old row; nothing here can create two fresh batches
    // from a double-click either — the RPC's own owner-scoped advisory
    // lock and conflict check (unchanged) already serialize this exactly
    // like every other create-batch call.
    let created: { batch_id: string; display_number: number; retry_of_item_id: string | null };
    try {
      const rpcResponse = await supabaseRequest("rpc/listing_studio_create_ebay_extension_batch", {
        method: "POST",
        body: JSON.stringify({ p_owner_id: user.id, p_pairing_code_hash: pairingCodeHash, p_expires_at: expiresAtIso, p_marketplace_draft_ids: foundIds }),
      });
      const [row] = await rpcResponse.json() as { batch_id: string; display_number: number; retry_of_item_id: string | null }[];
      created = row;
    } catch (error) {
      if (isDraftAlreadyActiveConflict(error)) {
        return NextResponse.json({ error: "One or more selected listings are already part of another active eBay extension batch." }, { status: 409 });
      }
      throw error;
    }

    // CORRECTIVE PASS (environment provenance audit) — the SAME two safe,
    // non-secret identifiers GET /api/extension/ebay-batch/health reports,
    // resolved from the SAME shared module. The Listings Review pairing
    // card shows these alongside the pairing code so a human can compare
    // them against the extension's own diagnostics panel and catch a
    // genuine environment mismatch (two different app instances, two
    // different Supabase projects) before ever attempting to pair.
    return NextResponse.json({
      batchId: created.batch_id, displayNumber: created.display_number, pairingCode, expiresAt: expiresAtIso, listingCount: foundIds.length,
      isRetry: created.retry_of_item_id !== null,
      buildId: SERVER_BUILD_ID, supabaseProjectRef: SUPABASE_PROJECT_REF,
    });
  } catch (error) { return safeApiError(error, "Could not create an eBay extension batch."); }
}
