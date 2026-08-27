import type { EbayAspect } from "@/lib/listing-studio/ebay-taxonomy-client";

/**
 * Stage 5 — turns eBay's own raw aspect metadata (get_item_aspects_for_category)
 * into the three display/readiness groups the product spec requires
 * (Required / Recommended / Optional). Uses EXACTLY the metadata eBay
 * returned — never assumes a field is a dropdown, never invents a
 * required/optional split of its own. `aspectConstraint.aspectUsage` is the
 * authoritative field when present; a small number of older/edge-case eBay
 * categories only ever return the boolean `aspectRequired` instead, so that
 * is the fallback, never the other way around.
 */
export type GroupedAspect = {
  name: string;
  usage: "REQUIRED" | "RECOMMENDED" | "OPTIONAL";
  mode: "FREE_TEXT" | "SELECTION_ONLY";
  cardinality: "SINGLE" | "MULTI";
  maxLength: number | null;
  allowedValues: string[];
};

export type GroupedAspects = { required: GroupedAspect[]; recommended: GroupedAspect[]; optional: GroupedAspect[] };

function usageFor(aspect: EbayAspect): GroupedAspect["usage"] {
  const constraint = aspect.aspectConstraint;
  if (constraint?.aspectUsage) return constraint.aspectUsage;
  if (constraint?.aspectRequired) return "REQUIRED";
  return "OPTIONAL";
}

function toGroupedAspect(aspect: EbayAspect): GroupedAspect {
  const constraint = aspect.aspectConstraint;
  return {
    name: aspect.localizedAspectName,
    usage: usageFor(aspect),
    // eBay's own default when aspectMode is absent from a response is
    // effectively free text (no constrained value list) — but if this
    // aspect DOES carry aspectValues, treat it as selection-only even if
    // aspectMode itself is missing, since a real allowed-value list is the
    // stronger, more concrete signal than an absent mode field.
    mode: constraint?.aspectMode ?? (aspect.aspectValues?.length ? "SELECTION_ONLY" : "FREE_TEXT"),
    cardinality: constraint?.itemToAspectCardinality ?? "SINGLE",
    maxLength: constraint?.aspectMaxLength ?? null,
    allowedValues: (aspect.aspectValues ?? []).map(v => v.localizedValue),
  };
}

export function groupEbayAspects(aspects: EbayAspect[]): GroupedAspects {
  const grouped: GroupedAspects = { required: [], recommended: [], optional: [] };
  for (const aspect of aspects) {
    const entry = toGroupedAspect(aspect);
    if (entry.usage === "REQUIRED") grouped.required.push(entry);
    else if (entry.usage === "RECOMMENDED") grouped.recommended.push(entry);
    else grouped.optional.push(entry);
  }
  return grouped;
}
