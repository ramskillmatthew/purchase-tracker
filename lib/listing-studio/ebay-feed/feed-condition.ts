/**
 * Condition ID discrepancy — RESOLVED, from the real template, not
 * assumed. The earlier architecture report guessed the Feed CSV's
 * "Condition ID" column would want the old numeric Trading-API-style ID
 * (e.g. 4000 for "Very Good"). The real downloaded template's own sample
 * row disproves that directly: its Condition ID cell contains the literal
 * string `NEW` — not a number. See
 * lib/listing-studio/ebay-feed/template-contract.ts's SAMPLE_ROW.
 *
 * This means the Feed CSV's "Condition ID" column, despite its name,
 * expects the SAME string-enum vocabulary as the Inventory API's
 * `condition` field (NEW, USED_VERY_GOOD, etc.) — not the numeric
 * condition-ID system. This module is therefore a thin, deliberately
 * SEPARATE wrapper around lib/listing-studio/ebay-condition.ts's already-
 * correct, already-safety-audited translator, rather than a new mapping
 * table — reusing the exact same fail-closed behaviour (never
 * optimistically upgrades an ambiguous label, never defaults to a
 * favourable grade) proven there.
 *
 * Kept as a genuinely separate module (not a re-export) on purpose: if a
 * future template version, or a different eBay marketplace's template,
 * turns out to want a different representation for this column, this is
 * the one place that changes — the Inventory API's own translator must
 * never be touched to accommodate a Feed-template-specific quirk, and
 * vice versa.
 *
 * Real-world caveat, disclosed honestly rather than hidden: community
 * reports describe the Condition ID column not always reliably applying
 * on the resulting draft (a documented-by-sellers eBay-side quirk, not
 * something this application can control). This does not change what
 * value this application sends — the real template's own sample row is
 * the authoritative format to follow — but it does mean condition may
 * need to be re-confirmed by the user inside Seller Hub after a draft is
 * created, which is exactly what a draft (as opposed to a finished
 * listing) exists to allow.
 */

import { toEbayInventoryCondition, type EbayConditionTranslation } from "@/lib/listing-studio/ebay-condition";

/** Same translation, same fail-closed guarantees, as
 * toEbayInventoryCondition — this function exists so call sites reading
 * this module's name never have to reason about the Inventory API at all. */
export function toFeedTemplateConditionId(conditionValue: string | null | undefined): EbayConditionTranslation {
  return toEbayInventoryCondition(conditionValue);
}
