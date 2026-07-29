import type { Purchase } from "./types";

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
