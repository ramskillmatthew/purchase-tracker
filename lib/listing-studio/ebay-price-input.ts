/**
 * The ONE canonical £ <-> pence conversion the eBay price editor uses —
 * lives here (not inside EbayCategoryAndAspectsDialog.tsx) so it's a plain
 * .ts module the test suite can import directly (this project's vitest
 * config does not transform .tsx/JSX), and so nothing else in the app is
 * tempted to invent a second, independent parsing/formatting rule for the
 * same £-amount. See marketplace-drafts/[marketplace]/route.ts's own
 * `pricePence` field — this is the exact value that route persists.
 */

/** Parses a user-typed price string ("12.99", "£12.99", "12", "12,50") into
 * whole pence. Rejects blank, zero, negative, and anything that isn't a
 * plain decimal amount — never invents a value from a partial/garbled
 * string. Returns null (never throws) on anything invalid. */
export function parsePriceToPence(raw: string): number | null {
  const trimmed = raw.trim().replace(/^£/, "").replace(",", ".");
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const pence = Math.round(parseFloat(trimmed) * 100);
  if (!Number.isFinite(pence) || pence <= 0) return null;
  return pence;
}

/** Formats a canonical pence value for display/editing — never the other
 * way around (a formatted string is never stored; only the numeric pence
 * value is persisted). */
export function formatPenceForInput(pricePence: number | null): string {
  return pricePence == null ? "" : (pricePence / 100).toFixed(2);
}
