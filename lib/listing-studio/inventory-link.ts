import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { poundsToPence } from "@/lib/sales/money";

export type InventoryLinkCandidate = {
  id: string;
  sku: string;
  itemDescription: string;
  itemSize: string;
  pricePence: number;
  score: number;
};

type PurchaseRow = { id: string; sku: string; item_description: string; item_size: string; price_purchased: number | string; stock_status: string };

const STOP_WORDS = new Set(["a", "an", "and", "the", "for", "with", "new", "used", "condition", "size", "uk", "mens", "womens", "men", "women", "item"]);

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function tokens(value: string): Set<string> {
  return new Set(normalise(value).split(" ").filter(token => token.length > 1 && !STOP_WORDS.has(token)));
}

export function scoreInventoryCandidate(listingText: string, purchaseText: string): number {
  const listing = tokens(listingText);
  const purchase = tokens(purchaseText);
  if (!listing.size || !purchase.size) return 0;
  let intersection = 0;
  for (const token of purchase) if (listing.has(token)) intersection++;
  const coverage = intersection / purchase.size;
  const precision = intersection / listing.size;
  const exactBoost = normalise(listingText).includes(normalise(purchaseText)) || normalise(purchaseText).includes(normalise(listingText)) ? 0.22 : 0;
  return Math.min(1, coverage * 0.72 + precision * 0.28 + exactBoost);
}

export async function findInventoryLinkCandidates(ownerId: string, query: string, limit = 12): Promise<InventoryLinkCandidate[]> {
  const rows = await supabaseRequestAll<PurchaseRow>(
    `purchases?owner_id=eq.${encodeURIComponent(ownerId)}&stock_status=eq.in_stock&select=id,sku,item_description,item_size,price_purchased,stock_status&order=order_date.desc,id.desc`,
  );
  return rows
    .filter(row => row.sku?.trim())
    .map(row => ({
      id: row.id,
      sku: row.sku.trim(),
      itemDescription: row.item_description,
      itemSize: row.item_size ?? "",
      pricePence: poundsToPence(Number(row.price_purchased)),
      score: scoreInventoryCandidate(query, `${row.item_description} ${row.item_size ?? ""}`),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.itemDescription.localeCompare(b.itemDescription))
    .slice(0, limit);
}

/** Assigns the app's internal stock SKU only when one candidate is both
 * strong and clearly ahead of the runner-up. Ambiguous matches are left
 * for the manual picker instead of guessing the user's purchase cost. */
export async function autoLinkImportedListing(draftId: string, ownerId: string, listingText: string): Promise<InventoryLinkCandidate | null> {
  const candidates = await findInventoryLinkCandidates(ownerId, listingText, 2);
  const best = candidates[0];
  const runnerUp = candidates[1];
  if (!best || best.score < 0.68 || (runnerUp && best.score - runnerUp.score < 0.14)) return null;
  await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${ownerId}&source_type=eq.ebay_uk`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ sku: best.sku, updated_at: new Date().toISOString() }),
  });
  return best;
}
