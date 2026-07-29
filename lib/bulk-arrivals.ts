export type ArrivalRecord = { id: string; sku: string | null; arrived: boolean | null };

export type BulkArrivalsResult = {
  enteredCount: number;
  matchedPurchaseCount: number;
  updatedPurchaseCount: number;
  alreadyArrivedCount: number;
  notFoundSkus: string[];
  duplicateMatches: { sku: string; purchaseCount: number }[];
  updateIds: string[];
};

// A purchase created with quantity > 1 is expanded into that many separate
// rows sharing one SKU (see the POST handler in app/api/purchases/route.ts)
// — so more than one record per SKU is an expected, routine shape in this
// app's data, not data corruption. Every matching record is therefore
// marked arrived, and the count is reported via duplicateMatches so the UI
// can show it rather than hide it.
export const MAX_BULK_ARRIVAL_SKUS = 500;

/**
 * Pure exact-match aggregation core of the bulk arrivals feature — no
 * network calls, so every branch (not found, already arrived, duplicate
 * database matches, exact vs. partial matching) is directly unit-testable.
 *
 * `uniqueSkus` must already be trimmed/deduplicated (see parseSkuLines in
 * lib/purchases.ts). `records` must be the full, freshly-fetched purchases
 * list — the only caller, app/api/purchases/bulk-arrivals/route.ts,
 * re-fetches it on every request (preview AND update) rather than trusting
 * a client-supplied preview, so data changed between preview and
 * confirmation is always reflected in the final update.
 *
 * Matching is case-insensitive exact match on the trimmed SKU — never a
 * substring/partial match — mirroring the case-insensitive convention
 * components/GlobalPurchaseSearch.tsx already uses elsewhere in this app.
 */
export function resolveBulkArrivals(uniqueSkus: string[], records: ArrivalRecord[]): BulkArrivalsResult {
  const bySku = new Map<string, ArrivalRecord[]>();
  for (const record of records) {
    const key = record.sku?.trim().toLowerCase();
    if (!key) continue;
    const bucket = bySku.get(key);
    if (bucket) bucket.push(record); else bySku.set(key, [record]);
  }

  const notFoundSkus: string[] = [];
  const duplicateMatches: { sku: string; purchaseCount: number }[] = [];
  const updateIds: string[] = [];
  let matchedPurchaseCount = 0;
  let alreadyArrivedCount = 0;

  for (const sku of uniqueSkus) {
    const matches = bySku.get(sku.toLowerCase());
    if (!matches?.length) { notFoundSkus.push(sku); continue; }
    matchedPurchaseCount += matches.length;
    if (matches.length > 1) duplicateMatches.push({ sku, purchaseCount: matches.length });
    // Null/undefined `arrived` (older records that predate the field) is
    // never a distinct state — same rule as isArrived in lib/purchases.ts —
    // so it is always treated as not-arrived and included in the update.
    for (const record of matches) {
      if (record.arrived === true) alreadyArrivedCount++;
      else updateIds.push(record.id);
    }
  }

  return {
    enteredCount: uniqueSkus.length,
    matchedPurchaseCount,
    updatedPurchaseCount: updateIds.length,
    alreadyArrivedCount,
    notFoundSkus,
    duplicateMatches,
    updateIds,
  };
}
