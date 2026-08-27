import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { MarketplaceAspectValue, AutomationMode } from "@/lib/listing-studio/marketplace-types";

/**
 * Stage 5 — the ONE place automation-mode behaviour is decided, so it's
 * centralised and testable rather than scattered across UI components (per
 * the product spec's own "centralised and testable, not scattered as
 * unexplained magic numbers" requirement). Takes a matched value (already
 * produced by lib/listing-studio/ebay-aspect-matching.ts, deterministic or
 * AI-ranked) and decides whether it's applied silently, applied-with-a-
 * review-flag, or held back entirely pending confirmation.
 *
 * This never changes the VALUE or its confidence — matching already
 * decided those. It only ever sets appliedAutomatically/needsReview, and
 * for Strict mode's "always require confirmation" rule, this is also the
 * one place that can hold a value back from being silently trusted even
 * though matching found it.
 */
export function applyAutomationMode(aspect: GroupedAspect, value: MarketplaceAspectValue, automationMode: AutomationMode): MarketplaceAspectValue {
  if (value.value == null || value.confidence === "unknown") return { ...value, appliedAutomatically: false, needsReview: aspect.usage === "REQUIRED" };

  if (automationMode === "strict") {
    // "Generate suggestions but require confirmation before treating
    // AI-selected category and specifics as approved" — the value is
    // still shown/pre-filled, never withheld, but never silently trusted.
    return { ...value, appliedAutomatically: false, needsReview: true };
  }

  if (value.confidence === "high") {
    // Applied automatically in every mode — Fast, Balanced, and Strict all
    // apply high-confidence suggestions per the spec's own automation-mode
    // table, EXCEPT Strict's own blanket "always require confirmation"
    // rule above, which this branch is only reached having already passed.
    return { ...value, appliedAutomatically: true, needsReview: false };
  }

  if (value.confidence === "medium") {
    if (automationMode === "fast") return { ...value, appliedAutomatically: true, needsReview: true };
    // Balanced: "apply medium-confidence values with clear review state."
    return { ...value, appliedAutomatically: true, needsReview: true };
  }

  // Low confidence: never auto-applied in Fast or Balanced — "do not apply
  // if required; request confirmation" applies to every mode's own low tier,
  // not only Strict's blanket rule (which never reaches this branch anyway).
  return { ...value, appliedAutomatically: false, needsReview: true };
}
