import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { marketplaceSchema, marketplaceDraftSettingsSchema } from "@/lib/validation/listing-studio-marketplace";
import { FALLBACK_MARKETPLACE_DRAFT_SETTINGS } from "@/lib/listing-studio/marketplace-settings";
import type { PartialMarketplaceDraftSettings } from "@/lib/listing-studio/marketplace-types";

export const runtime = "nodejs";

/**
 * Stage 3 — account-level default draft settings, one row per (owner,
 * marketplace) in listing_marketplace_settings_defaults. This is the
 * LOWEST-priority level of the 3-level settings hierarchy (see
 * lib/listing-studio/marketplace-settings.ts's resolveMarketplaceSettings)
 * — batch settings (passed directly in a generate request) and a per-draft
 * override (listing_marketplace_drafts.settings_json) both take priority
 * over whatever is saved here.
 */
type DefaultsRow = {
  content_mode: PartialMarketplaceDraftSettings["contentMode"] | null;
  listing_format: PartialMarketplaceDraftSettings["listingFormat"];
  default_quantity: number;
  allow_offers: boolean;
  postage_profile_label: string | null;
  return_profile_label: string | null;
  payment_profile_label: string | null;
  package_size: PartialMarketplaceDraftSettings["packageSize"] | null;
  automation_mode: PartialMarketplaceDraftSettings["automationMode"];
};

function rowToSettings(row: DefaultsRow): PartialMarketplaceDraftSettings {
  const settings: PartialMarketplaceDraftSettings = {
    listingFormat: row.listing_format, quantity: row.default_quantity, allowOffers: row.allow_offers,
    postageProfileLabel: row.postage_profile_label, returnProfileLabel: row.return_profile_label,
    paymentProfileLabel: row.payment_profile_label, packageSize: row.package_size, automationMode: row.automation_mode,
  };
  if (row.content_mode) settings.contentMode = row.content_mode;
  return settings;
}

export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const marketplace = marketplaceSchema.parse(new URL(request.url).searchParams.get("marketplace"));
    const rows = await supabaseRequestAll<DefaultsRow>(
      `listing_marketplace_settings_defaults?owner_id=eq.${user.id}&marketplace=eq.${marketplace}&select=content_mode,listing_format,default_quantity,allow_offers,postage_profile_label,return_profile_label,payment_profile_label,package_size,automation_mode`,
    );
    const settings = rows[0] ? { ...FALLBACK_MARKETPLACE_DRAFT_SETTINGS, ...rowToSettings(rows[0]) } : FALLBACK_MARKETPLACE_DRAFT_SETTINGS;
    return NextResponse.json({ marketplace, settings });
  } catch (error) { return safeApiError(error, "Could not load marketplace settings."); }
}

const patchRequestSchema = z.object({ marketplace: marketplaceSchema, settings: marketplaceDraftSettingsSchema });

export async function PATCH(request: Request) {
  try {
    const user = await requireOwner();
    const { marketplace, settings } = patchRequestSchema.parse(await request.json());
    const body: Record<string, unknown> = { owner_id: user.id, marketplace, updated_at: new Date().toISOString() };
    if (settings.contentMode !== undefined) body.content_mode = settings.contentMode;
    if (settings.listingFormat !== undefined) body.listing_format = settings.listingFormat;
    if (settings.quantity !== undefined) body.default_quantity = settings.quantity;
    if (settings.allowOffers !== undefined) body.allow_offers = settings.allowOffers;
    if (settings.postageProfileLabel !== undefined) body.postage_profile_label = settings.postageProfileLabel;
    if (settings.returnProfileLabel !== undefined) body.return_profile_label = settings.returnProfileLabel;
    if (settings.paymentProfileLabel !== undefined) body.payment_profile_label = settings.paymentProfileLabel;
    if (settings.packageSize !== undefined) body.package_size = settings.packageSize;
    if (settings.automationMode !== undefined) body.automation_mode = settings.automationMode;

    await supabaseRequest("listing_marketplace_settings_defaults?on_conflict=owner_id,marketplace", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body),
    });
    return NextResponse.json({ marketplace, ok: true });
  } catch (error) { return safeApiError(error, "Could not save marketplace settings."); }
}
