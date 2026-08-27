/**
 * Stage 4 — a small, clearly-labelled DEVELOPMENT-ONLY fixture standing in
 * for real eBay Taxonomy API responses, used ONLY by
 * lib/listing-studio/ebay-category-service.ts, and ONLY when BOTH of these
 * hold: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET are absent, AND
 * process.env.NODE_ENV !== "production" (so a real Vercel Production
 * deployment — where NODE_ENV is always "production" — can NEVER activate
 * this, regardless of any credential misconfiguration; see that file's own
 * gate). Never imported by anything client-facing. This exists purely so
 * the category-suggestion UI/flow can be exercised locally before real
 * eBay Developer credentials are obtained — never a stand-in for genuine
 * eBay data in front of a real user.
 */
import type { EbayCategorySuggestion } from "@/lib/listing-studio/ebay-taxonomy-client";

export const FIXTURE_CATEGORY_TREE_ID = "0";
export const FIXTURE_CATEGORY_TREE_VERSION = "fixture-1";

const FIXTURE_SUGGESTIONS: Record<string, EbayCategorySuggestion[]> = {
  "pokémon tcg": [
    { category: { categoryId: "183454", categoryName: "CCG Sealed Boxes" }, categoryTreeNodeAncestors: [{ categoryId: "1", categoryName: "Collectables" }, { categoryId: "2536", categoryName: "Collectable Card Games" }], relevancy: "300.0" },
    { category: { categoryId: "183455", categoryName: "Individual Cards" }, categoryTreeNodeAncestors: [{ categoryId: "1", categoryName: "Collectables" }, { categoryId: "2536", categoryName: "Collectable Card Games" }], relevancy: "90.0" },
  ],
  trainers: [
    { category: { categoryId: "15709", categoryName: "Trainers" }, categoryTreeNodeAncestors: [{ categoryId: "11450", categoryName: "Clothes, Shoes & Accessories" }, { categoryId: "3034", categoryName: "Men's Shoes" }], relevancy: "280.0" },
  ],
  beauty: [
    { category: { categoryId: "31413", categoryName: "Gift Sets & Bundles" }, categoryTreeNodeAncestors: [{ categoryId: "26395", categoryName: "Health & Beauty" }, { categoryId: "31408", categoryName: "Skin Care" }], relevancy: "150.0" },
  ],
};

/** Returns fixture suggestions loosely keyed by whether the query mentions
 * one of a few obvious categories — deliberately simplistic, since this
 * exists only to exercise the UI locally, never to imitate real ranking
 * quality. Returns an empty array (an honest "no results"), never
 * fabricated data, for anything unrecognised. */
export function fixtureCategorySuggestions(query: string): EbayCategorySuggestion[] {
  const lower = query.toLowerCase();
  for (const [key, suggestions] of Object.entries(FIXTURE_SUGGESTIONS)) {
    if (lower.includes(key)) return suggestions;
  }
  return [];
}
