export const LISTING_DASHBOARD_HIDDEN_IDS_KEY = "listing_dashboard_hidden_ids";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function savedHiddenListingIds(metadata: Record<string, unknown> | null | undefined) {
  const raw = metadata?.[LISTING_DASHBOARD_HIDDEN_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((value): value is string => typeof value === "string" && UUID.test(value)))].slice(-2000);
}

