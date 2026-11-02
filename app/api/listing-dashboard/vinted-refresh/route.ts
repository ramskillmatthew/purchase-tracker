import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import { savedVintedAccounts } from "@/lib/listing-dashboard/vinted-accounts";
import { fetchAllVintedProfileListings, type PublicVintedListing, type SavedVintedAccount } from "@/lib/listing-dashboard/vinted-public-profile";
import { enforceRateLimit } from "@/lib/security/activity";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

type ExistingRow = {
  id: string;
  source_item_id: string | null;
  source_url: string | null;
  ai_result_json: Record<string, unknown> | null;
};

function importedId(ownerId: string, profileId: string, itemId: string) {
  const bytes = Buffer.from(createHash("sha256").update(`${ownerId}:vinted:${profileId}:${itemId}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function snapshot(account: SavedVintedAccount, listing: PublicVintedListing, checkedAt: string, active = true) {
  return {
    source: "vinted_profile",
    sourceUrl: listing.url,
    sourceItemId: listing.id,
    importedAt: checkedAt,
    vintedProfileListing: {
      accountSlot: account.slot,
      accountNumber: account.number,
      profileId: account.profileId,
      profileUrl: account.profileUrl,
      username: account.username,
      listingId: listing.id,
      photoUrl: listing.photoUrl,
      favouriteCount: listing.favouriteCount,
      active,
      lastSeenAt: active ? checkedAt : null,
      lastCheckedAt: checkedAt,
    },
  };
}

function profileMeta(value: Record<string, unknown> | null | undefined) {
  const candidate = value?.vintedProfileListing;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

async function upsertRows(rows: Record<string, unknown>[]) {
  for (let offset = 0; offset < rows.length; offset += 100) {
    await supabaseRequest("listing_drafts?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(offset, offset + 100)),
    });
  }
}

export async function POST() {
  try {
    const user = await requireOwner();
    await enforceRateLimit(user.id, "vinted_profile_refresh", 8, 300);
    const accounts = savedVintedAccounts(user.user_metadata);
    if (!accounts.length) return NextResponse.json({ error: "Add at least one Vinted account before refreshing listings." }, { status: 400 });

    const checkedAt = new Date().toISOString();
    const existing = await supabaseRequestAll<ExistingRow>(
      `listing_drafts?owner_id=eq.${user.id}&source_item_id=not.is.null&select=id,source_item_id,source_url,ai_result_json&order=created_at.asc`,
    );
    const importedExisting = existing.filter(row => row.ai_result_json?.source === "vinted_profile");
    const results = await Promise.allSettled(accounts.map(async account => ({ account, listings: await fetchAllVintedProfileListings(account) })));
    const rows: Record<string, unknown>[] = [];
    const summaries: Array<{ accountNumber: number; found: number; added: number; updated: number; noLongerFound: number; error?: string }> = [];

    for (let index = 0; index < results.length; index += 1) {
      const account = accounts[index];
      const result = results[index];
      if (result.status === "rejected") {
        summaries.push({ accountNumber: account.number, found: 0, added: 0, updated: 0, noLongerFound: 0, error: result.reason instanceof Error ? result.reason.message : "This profile could not be refreshed." });
        continue;
      }
      const seen = new Set(result.value.listings.map(listing => listing.id));
      const accountExisting = importedExisting.filter(row => {
        const meta = profileMeta(row.ai_result_json);
        return String(meta?.profileId ?? "") === account.profileId
          || (!meta?.profileId && Number(meta?.accountNumber) === account.number);
      });
      const existingByItemId = new Map(accountExisting.filter(row => row.source_item_id).map(row => [row.source_item_id as string, row.id]));
      const existingIds = new Set(accountExisting.map(row => row.source_item_id).filter((value): value is string => Boolean(value)));
      for (const listing of result.value.listings) {
        rows.push({
          id: existingByItemId.get(listing.id) ?? importedId(user.id, account.profileId, listing.id), owner_id: user.id,
          title: listing.title, generated_title: listing.title,
          suggested_price_pence: listing.pricePence, confirmed_price_pence: listing.pricePence,
          status: "ready", overall_confidence: "high",
          source_type: "photos", source_url: listing.url, source_item_id: listing.id,
          ai_result_json: snapshot(account, listing, checkedAt), updated_at: checkedAt,
        });
      }
      let missing = 0;
      for (const row of accountExisting) {
        if (!row.source_item_id || seen.has(row.source_item_id)) continue;
        const meta = profileMeta(row.ai_result_json);
        if (meta?.active === false) continue;
        missing += 1;
        await supabaseRequest(`listing_drafts?id=eq.${row.id}&owner_id=eq.${user.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ ai_result_json: { ...row.ai_result_json, vintedProfileListing: { ...meta, active: false, lastCheckedAt: checkedAt } }, updated_at: checkedAt }),
        });
      }
      summaries.push({
        accountNumber: account.number,
        found: result.value.listings.length,
        added: result.value.listings.filter(listing => !existingIds.has(listing.id)).length,
        updated: result.value.listings.filter(listing => existingIds.has(listing.id)).length,
        noLongerFound: missing,
      });
    }

    if (rows.length) await upsertRows(rows);
    const failed = summaries.filter(summary => summary.error);
    const totals = summaries.reduce((value, summary) => ({
      found: value.found + summary.found,
      added: value.added + summary.added,
      updated: value.updated + summary.updated,
      noLongerFound: value.noLongerFound + summary.noLongerFound,
    }), { found: 0, added: 0, updated: 0, noLongerFound: 0 });
    return NextResponse.json({ ok: failed.length === 0, ...totals, accounts: summaries, refreshedAt: checkedAt });
  } catch (error) { return safeApiError(error, "The Vinted listings could not be refreshed."); }
}
