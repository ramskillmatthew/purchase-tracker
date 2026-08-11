import type { ReactNode } from "react";

export type KpiIconTone = "listings" | "ready" | "drafting" | "review";

/**
 * The ONE shared wrapper every KPI-card icon uses — a fixed-size circular
 * badge with a fixed-size SVG centred inside it via grid, never text/emoji.
 * Every consumer passes only the SVG's inner markup (paths/circles); the
 * outer <span>/<svg> attributes (size, viewBox, display) are identical
 * across all four cards, so none can drift out of alignment with another.
 *
 * REGRESSION (production-polish pass): a broad `.lr-kpi span` CSS rule
 * elsewhere on this page — meant only for the card's text label — had
 * higher specificity (class + element) than `.lr-kpi-icon` (a single
 * class) and unintentionally matched this icon's own <span> too, silently
 * overriding `display: grid` back to the default block flow. That broke
 * vertical centring (the SVG sat flush at the top of the circle) even
 * though `place-items: center` was correctly declared. Giving the tone its
 * own class directly on this element (rather than a `.lr-kpi-<tone> .lr-kpi-icon`
 * descendant selector) and giving the label its own dedicated class
 * removes any selector that could ever again match this element by
 * accident.
 */
export function KpiIcon({ tone, children }: { tone: KpiIconTone; children: ReactNode }) {
  return <span className={`lr-kpi-icon lr-kpi-icon-${tone}`} aria-hidden="true">
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">{children}</svg>
  </span>;
}
