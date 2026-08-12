import type { Purchase, StockStatus } from "./types";

/**
 * Canonical "has this stock purchase arrived?" check. `arrived` is a
 * nullable boolean — older rows (created before this field existed) were
 * never explicitly set and are stored as `null`. There is no UI path left
 * that can produce or query a real third state, so `null`/`undefined` are
 * always treated as "not arrived", never as a distinct blank state.
 */
export function isArrived(purchase: Pick<Purchase, "arrived">): boolean {
  return purchase.arrived === true;
}

export type ArrivalFilter = "all" | "not-arrived" | "arrived";

export const arrivalFilters: { value: ArrivalFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "not-arrived", label: "Not arrived" },
  { value: "arrived", label: "Arrived" },
];

// Used to read the ?arrived= query param the Home page's "Awaiting arrival"
// card links to — any unrecognised or missing value safely falls back to
// "all" rather than throwing or silently hiding every row.
export function parseArrivalFilter(value: string | null | undefined): ArrivalFilter {
  return value === "not-arrived" || value === "arrived" ? value : "all";
}

export function matchesArrivalFilter(purchase: Pick<Purchase, "arrived">, filter: ArrivalFilter): boolean {
  if (filter === "all") return true;
  return filter === "arrived" ? isArrived(purchase) : isAwaitingArrival(purchase);
}

/**
 * The single source of truth for "does this stock purchase belong in the
 * outstanding-arrivals backlog?" — both `countAwaitingArrival` and
 * `calculateAwaitingArrivalValue` are built on this so the count and the
 * £ total can never drift apart by using slightly different rules. Callers
 * only ever pass this the `purchases` array (never `expenses`), so there is
 * no separate "stock vs. expense" check here — the two record types are
 * already distinct arrays/types throughout this app.
 */
export function isAwaitingArrival(purchase: Pick<Purchase, "arrived">): boolean {
  return !isArrived(purchase);
}

// Total outstanding stock purchases — never period-scoped, since the Home
// page card always represents the current real-world backlog regardless of
// whichever "Compare period" is selected.
export function countAwaitingArrival(purchases: Pick<Purchase, "arrived">[]): number {
  return purchases.reduce((total, purchase) => total + (isAwaitingArrival(purchase) ? 1 : 0), 0);
}

// A purchase's `price_purchased` is typed as `number`, but — like the
// `Number(row.price_purchased)` calls already scattered across the
// Purchases/Expenses pages — is defended against arriving as a numeric
// string (e.g. from a slightly-off PostgREST/driver response) without ever
// letting a bad value slip through as a silent NaN or string-concatenation
// bug. Blank/whitespace-only strings are rejected explicitly because
// `Number("")` is `0`, not `NaN` — the one case native coercion gets wrong
// for this purpose.
function toFinitePrice(price: unknown): number | null {
  if (price === null || price === undefined) return null;
  if (typeof price === "string" && price.trim() === "") return null;
  const value = Number(price);
  return Number.isFinite(value) ? value : null;
}

/**
 * Combined purchase value of the same backlog `countAwaitingArrival`
 * counts — built on the identical `isAwaitingArrival` check, so a purchase
 * can never be counted by one helper and priced by the other. Invalid
 * prices (null/blank/NaN/non-numeric) contribute nothing rather than
 * throwing or poisoning the total with NaN. Sums raw values and only
 * rounds at display time (via the caller's currency formatter) — never
 * rounds each purchase first.
 */
export function calculateAwaitingArrivalValue(purchases: Pick<Purchase, "arrived" | "price_purchased">[]): number {
  return purchases.reduce((total, purchase) => {
    if (!isAwaitingArrival(purchase)) return total;
    const price = toFinitePrice(purchase.price_purchased);
    return price === null ? total : total + price;
  }, 0);
}

/**
 * Splits pasted/typed SKU text into a deduplicated list for the bulk
 * arrivals feature — one entry per non-blank line, trimmed, de-duplicated
 * case-insensitively (matching mirrors the case-insensitive exact match
 * app/api/purchases/bulk-arrivals/route.ts performs, so the "N SKUs
 * entered" count shown to the user always matches what the server will
 * actually process). The first-seen casing of each SKU is preserved in the
 * output. Handles \r\n, \r, and \n line endings alike. The API route calls
 * this exact same function again on the raw array it receives — it never
 * trusts that the client already deduplicated correctly.
 */
export function parseSkuLines(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function awaitingArrivalMessage(count: number): string {
  return count === 1 ? "1 awaiting arrival" : `${count.toLocaleString("en-GB")} awaiting arrival`;
}

// The Home page card's main line — "1 item" / "12 items" — distinct from
// awaitingArrivalMessage's fuller phrase (used for the card's aria-label).
export function awaitingArrivalItemsLabel(count: number): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? "item" : "items"}`;
}

// ============================================================================
// Stock status — a genuinely different question from arrival. `arrived`
// answers "has this physically turned up?"; `stock_status` answers "is
// this still part of my inventory at all?" The two are deliberately kept
// independent throughout this module: changing one never reads or implies
// the other. See supabase-add-stock-status.sql for the column itself and
// the one-time historical backfill.
// ============================================================================

/** True only for the explicit 'in_stock' status — mirrors isArrived's own "no third state" discipline. */
export function isInStock(purchase: Pick<Purchase, "stock_status">): boolean {
  return purchase.stock_status === "in_stock";
}

export function isNoLongerInStock(purchase: Pick<Purchase, "stock_status">): boolean {
  return purchase.stock_status === "no_longer_in_stock";
}

/**
 * "In stock awaiting arrival" — the Home card's own eligibility rule.
 * Built from isInStock + isArrived (never a separate/duplicated arrival
 * check), so a no_longer_in_stock purchase can never appear here even if
 * its `arrived` value happens to be false or null — leaving stock is what
 * removes it, regardless of what arrived says.
 */
export function isInStockAwaitingArrival(purchase: Pick<Purchase, "stock_status" | "arrived">): boolean {
  return isInStock(purchase) && !isArrived(purchase);
}

/** "In stock and physically here" — the mirror image of isInStockAwaitingArrival; every in_stock purchase is in exactly one of the two. */
export function isInStockPhysicallyHere(purchase: Pick<Purchase, "stock_status" | "arrived">): boolean {
  return isInStock(purchase) && isArrived(purchase);
}

// The Home "In stock awaiting arrival" card's own count/value pair — built
// on the identical isInStockAwaitingArrival predicate, so (matching
// countAwaitingArrival/calculateAwaitingArrivalValue's own discipline) the
// two can never disagree about which rows are eligible. A
// no_longer_in_stock purchase is excluded here even when its `arrived`
// value is false or null — leaving stock removes it from this card
// immediately, regardless of arrival.
export function countInStockAwaitingArrival(purchases: Pick<Purchase, "stock_status" | "arrived">[]): number {
  return purchases.reduce((total, purchase) => total + (isInStockAwaitingArrival(purchase) ? 1 : 0), 0);
}

export function calculateInStockAwaitingArrivalValue(purchases: Pick<Purchase, "stock_status" | "arrived" | "price_purchased">[]): number {
  return purchases.reduce((total, purchase) => {
    if (!isInStockAwaitingArrival(purchase)) return total;
    const price = toFinitePrice(purchase.price_purchased);
    return price === null ? total : total + price;
  }, 0);
}

export type StockFilter = "all" | "in-stock" | "waiting-on-arrival" | "physically-here" | "no-longer-in-stock";

// "All" first and default, exactly like arrivalFilters — the Purchases
// page must keep opening unfiltered. These five options REPLACE the old
// arrival-only switch on that page (never rendered alongside it) so a
// user can never combine an independent arrival filter with an
// independent stock filter into a contradictory or confusing state.
export const stockFilters: { value: StockFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in-stock", label: "In stock" },
  { value: "waiting-on-arrival", label: "Waiting on arrival" },
  { value: "physically-here", label: "Physically here" },
  { value: "no-longer-in-stock", label: "No longer in stock" },
];

// Reads the ?stock= query param the Home cards deep-link to (in-stock /
// waiting-on-arrival) and that the Purchases page's own filter switch
// writes back — any unrecognised or missing value safely falls back to
// "all", matching parseArrivalFilter's own behaviour.
export function parseStockFilter(value: string | null | undefined): StockFilter {
  return value === "in-stock" || value === "waiting-on-arrival" || value === "physically-here" || value === "no-longer-in-stock"
    ? value
    : "all";
}

export function matchesStockFilter(purchase: Pick<Purchase, "stock_status" | "arrived">, filter: StockFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "in-stock": return isInStock(purchase);
    case "waiting-on-arrival": return isInStockAwaitingArrival(purchase);
    case "physically-here": return isInStockPhysicallyHere(purchase);
    case "no-longer-in-stock": return isNoLongerInStock(purchase);
  }
}

// Total current in-stock items — like countAwaitingArrival, never scoped
// to any date period: "how much stock do I currently have" is always a
// present-moment fact, not one that changes when Home's Compare period
// switch changes.
export function countInStock(purchases: Pick<Purchase, "stock_status">[]): number {
  return purchases.reduce((total, purchase) => total + (isInStock(purchase) ? 1 : 0), 0);
}

/**
 * Combined value of the exact same in-stock collection countInStock
 * counts — built on the identical isInStock check, so the count and the £
 * total can never disagree about which rows are included. Purchase price
 * only (never postage/fees/estimated resale value); each row contributes
 * once; invalid/missing prices contribute nothing rather than throwing or
 * poisoning the total with NaN; sums raw values and only rounds at
 * display time (via the caller's currency formatter), matching
 * calculateAwaitingArrivalValue's own discipline exactly.
 */
export function calculateInStockValue(purchases: Pick<Purchase, "stock_status" | "price_purchased">[]): number {
  return purchases.reduce((total, purchase) => {
    if (!isInStock(purchase)) return total;
    const price = toFinitePrice(purchase.price_purchased);
    return price === null ? total : total + price;
  }, 0);
}

// The Home "Stock value" card's supporting line — "1 item in stock" /
// "427 items in stock".
export function inStockItemsLabel(count: number): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? "item" : "items"} in stock`;
}

// The Home "In stock awaiting arrival" card's main line — "1 item" / "12
// items" — mirrors awaitingArrivalItemsLabel's exact wording, just fed by
// the stock-aware count instead of the arrival-only one.
export function inStockAwaitingArrivalItemsLabel(count: number): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? "item" : "items"}`;
}

/** The stock-status row toggle's own PATCH target — the opposite of whatever the purchase's current stock_status is. */
export function nextStockStatus(current: StockStatus): StockStatus {
  return current === "in_stock" ? "no_longer_in_stock" : "in_stock";
}
