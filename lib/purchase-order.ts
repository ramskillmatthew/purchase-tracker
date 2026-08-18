import type { Purchase } from "./types";

/**
 * The single authoritative "how are purchases displayed" rule — used
 * identically everywhere a list of purchases needs its default order: GET
 * /api/purchases itself, the Purchases page's own default view, and the
 * Home dashboard's "recent purchases" card. GET /api/purchases already
 * fetches the ENTIRE table via supabaseRequestAll (never a paginated
 * slice), so sorting happens once, server-side, over the complete dataset
 * before any client-side pagination ever slices it — the same rule
 * therefore holds correctly across page boundaries, regardless of how
 * purchases were originally entered (Add Purchase, Bulk Input, spreadsheet
 * import), in what order Bulk Input rows were pasted, or how many separate
 * import batches contributed rows.
 *
 *   1. order_date descending (newest first).
 *   2. Numeric SKU descending, compared as an arbitrary-precision integer
 *      (BigInt — never a JS `number`, which silently loses precision above
 *      2^53) — never ordinary text comparison, which would incorrectly
 *      rank "999" above "1000". A non-numeric or blank SKU is never
 *      rejected: it's simply ranked after every numeric SKU within the
 *      same order date, then broken by case-insensitive text, descending.
 *   3. created_at descending.
 *   4. id descending — a genuinely unique final tie-breaker, so the order
 *      stays fully deterministic even for rows identical in every other
 *      sortable field (e.g. two rows from the same Bulk Input batch,
 *      sharing both order_date and created_at).
 */
export function comparePurchasesForDisplay(a: Purchase, b: Purchase): number {
  const dateCompare = compareStringsDescending(a.order_date, b.order_date);
  if (dateCompare !== 0) return dateCompare;
  const skuCompare = compareSkuDescending(a.sku, b.sku);
  if (skuCompare !== 0) return skuCompare;
  const createdCompare = compareStringsDescending(a.created_at, b.created_at);
  if (createdCompare !== 0) return createdCompare;
  return compareStringsDescending(a.id, b.id);
}

/** Sorts a copy — never mutates the array passed in. */
export function sortPurchasesForDisplay<T extends Purchase>(purchases: T[]): T[] {
  return [...purchases].sort(comparePurchasesForDisplay);
}

function compareStringsDescending(a: string, b: string): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

type SkuSortKey = { numeric: bigint | null; text: string };

function skuSortKey(sku: string | null | undefined): SkuSortKey {
  const trimmed = (sku ?? "").trim();
  if (trimmed !== "" && /^\d+$/.test(trimmed)) return { numeric: BigInt(trimmed), text: trimmed };
  return { numeric: null, text: trimmed };
}

/**
 * Numeric SKUs always rank before non-numeric/blank ones, and are compared
 * as arbitrary-precision integers via BigInt — never a JS `number`, so an
 * arbitrarily large SKU never loses precision. Two non-numeric (or blank)
 * SKUs fall back to case-insensitive text, descending — a plain,
 * deterministic rule, never a guess. Never throws or rejects any input:
 * every string is treated as a valid SKU here, exactly as the rest of the
 * app already does.
 */
export function compareSkuDescending(skuA: string | null | undefined, skuB: string | null | undefined): number {
  const a = skuSortKey(skuA);
  const b = skuSortKey(skuB);
  if (a.numeric !== null && b.numeric !== null) {
    if (a.numeric === b.numeric) return 0;
    return a.numeric > b.numeric ? -1 : 1;
  }
  if (a.numeric !== null) return -1;
  if (b.numeric !== null) return 1;
  const at = a.text.toLowerCase();
  const bt = b.text.toLowerCase();
  if (at === bt) return 0;
  return at > bt ? -1 : 1;
}
