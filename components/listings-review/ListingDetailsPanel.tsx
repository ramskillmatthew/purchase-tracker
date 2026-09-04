"use client";

import { memo, useEffect, useState } from "react";
import type { ListingReviewStatus } from "@/lib/listing-studio/listing-review";
import { VINTED_AUDIENCE_LABELS, type VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import { deriveDraftAudience } from "@/lib/listing-studio/vinted-category-selection";
import { describePurchaseMatch, type SkuPurchaseMatch } from "@/lib/listing-studio/purchase-match";
import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";
import {
  WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_TONE, READINESS_TONE_READY, READINESS_TONE_NEEDS_REVIEW,
  computeWorkflowSecondaryLine, type ExtensionWorkflowStatus,
} from "@/lib/listing-studio/extension-workflow-status";
// PHASE 4 (Listings Review UI wiring) — the eBay tab now reflects the Sell
// Feed API pipeline (the one that creates a genuine Seller Hub draft),
// never the retired Inventory API pipeline's own vocabulary.
import {
  EBAY_FEED_ITEM_STATUS_LABELS, EBAY_FEED_ITEM_STATUS_TONE, computeEbayFeedWorkflowSecondaryLine, isEbayFeedItemInProgress,
  SELLER_HUB_DRAFTS_URL, NEEDS_RECONCILIATION_LABEL, NEEDS_RECONCILIATION_SECONDARY_LINE,
  type EbayFeedItemStatus, type EbayFeedBatchBlockingState,
} from "@/lib/listing-studio/ebay-feed/feed-workflow-status";
import { WorkflowStatus } from "./WorkflowStatus";
import OverflowMenu from "@/components/listing-studio/OverflowMenu";
import SellingPriceField from "./SellingPriceField";
import EbaySellingPriceField from "./EbaySellingPriceField";
import EbayPolicySelectors, { type EbayPolicyOption, type EbayLocationOption, type EbayPolicySelection } from "./EbayPolicySelectors";

// Same readiness labels/tones ListingsTable.tsx uses for its own fallback —
// kept in sync deliberately (not imported, since it's a small literal
// lookup, not a shared function) so the inspector's status always matches
// the row's own, never a second status language.
const READINESS_LABELS: Record<ListingReviewStatus, string> = { ready: "Ready", needs_review: "Need review", edited: "Ready" };
const READINESS_TONE: Record<ListingReviewStatus, string> = { ready: READINESS_TONE_READY, needs_review: READINESS_TONE_NEEDS_REVIEW, edited: READINESS_TONE_READY };

/** Stage 6 (eBay draft batches) — the eBay tab's own workflow-status line,
 * reusing the exact same WorkflowStatus dot component ListingsTable.tsx's
 * own resolveWorkflowDisplay uses for its eBay column, so the inspector
 * can never show a different status language than the row it's showing
 * details for. "Content ready"/"Needs review" (content readiness, before
 * any draft attempt) reuses the same green/amber readiness tones. */
function EbayWorkflowStatusBlock({ ebay }: { ebay: EbayTabData }) {
  // CORRECTIVE PASS (third real-submission audit) — a stale, inconsistent
  // item (parent already terminal-failed, this row never updated to
  // match) must never display as ordinary "Queued"/"Uploaded"/etc, and
  // must never tell the user to wait. Checked before the ordinary
  // workflowStatus-derived label below.
  if (ebay.feedBatchState.kind === "needs_reconciliation") {
    return <>
      <WorkflowStatus label={NEEDS_RECONCILIATION_LABEL} tone={EBAY_FEED_ITEM_STATUS_TONE.failed} pulse={false} secondaryLine={NEEDS_RECONCILIATION_SECONDARY_LINE} />
      {ebay.legacyOfferId && (
        <p className="lr-ebay-legacy-note">Legacy unpublished API offer — not visible in Seller Hub</p>
      )}
    </>;
  }
  const label = ebay.workflowStatus ? EBAY_FEED_ITEM_STATUS_LABELS[ebay.workflowStatus] : (ebay.contentReady ? "Content ready" : "Needs review");
  const tone = ebay.workflowStatus ? EBAY_FEED_ITEM_STATUS_TONE[ebay.workflowStatus] : (ebay.contentReady ? READINESS_TONE_READY : READINESS_TONE_NEEDS_REVIEW);
  const secondaryLine = ebay.workflowStatus
    ? computeEbayFeedWorkflowSecondaryLine({ itemStatus: ebay.workflowStatus, queuePosition: ebay.queuePosition, errorMessage: ebay.errorMessage })
    : (ebay.contentReady ? "All required information is complete." : null);
  return <>
    <WorkflowStatus label={label} tone={tone} pulse={isEbayFeedItemInProgress(ebay.workflowStatus)} secondaryLine={secondaryLine} />
    {ebay.workflowStatus === "succeeded" && (
      <a className="lr-ebay-seller-hub-link" href={SELLER_HUB_DRAFTS_URL} target="_blank" rel="noreferrer">Open Seller Hub Drafts ↗</a>
    )}
    {ebay.legacyOfferId && (
      <p className="lr-ebay-legacy-note">Legacy unpublished API offer — not visible in Seller Hub</p>
    )}
  </>;
}

/**
 * PHASE 4 (Listings Review UI wiring) — "View error" only; there is still
 * no PER-ITEM retry button here (this pipeline's unit of work is a whole
 * batch/CSV upload, not one row — see
 * lib/listing-studio/ebay-feed/feed-batches.ts's own header on why a
 * "resubmit just this row" operation doesn't exist).
 *
 * CORRECTIVE PASS (second real submission — Phase 6/7) — the hint text
 * below used to say "just re-select it and click Create Seller Hub draft
 * again" on the (mistaken) assumption that a failed listing simply became
 * eligible again. It doesn't: a listing whose most recent Seller Hub
 * batch failed is now deliberately BLOCKED from a plain "Create" (see
 * evaluateEbayFeedDraftEligibility's own feedBatchState check) specifically
 * so it can never silently reappear as an unexplained fresh attempt with
 * no context (this corrective task's own explicit requirement). The real
 * retry action lives in Live Activity, on this listing's own failed batch
 * — see DraftActivityPanel.tsx's own "Retry Seller Hub draft" control —
 * which retries the SAME batch (preserving its history and attempt
 * count), never creates an unexplained new one.
 */
function EbayFailedDraftActions({ ebay }: { ebay: EbayTabData }) {
  const [expanded, setExpanded] = useState(false);
  if (ebay.workflowStatus !== "failed") return null;
  return <div className="lr-ebay-failed-actions">
    <div className="lr-ebay-failed-buttons">
      <button type="button" className="button-secondary" onClick={() => setExpanded(current => !current)} aria-expanded={expanded}>
        {expanded ? "Hide error" : "View error"}
      </button>
    </div>
    {expanded && <div className="lr-ebay-failed-detail">
      <p className="lr-ebay-failed-message">{ebay.errorMessage || "No further detail was recorded for this failure."}</p>
      <p className="lr-ebay-failed-hint">Open Live Activity and use &quot;Retry Seller Hub draft&quot; on this listing&apos;s failed batch to try again.</p>
    </div>}
  </div>;
}

export type ListingDetails = {
  id: string;
  generatedTitle: string;
  generatedDescription: string;
  brand: string | null;
  model: string | null;
  productType: string | null;
  // Milestone 6 (Vinted-aware colours/materials): up to 2 exact Vinted
  // colour-list values (never free text) plus a single exact Vinted
  // material-list value or null.
  colours: string[];
  material: string | null;
  ukSize: string | null;
  sku: string | null;
  condition: string | null;
  status: ListingReviewStatus;
  warnings: string[];
  coverPhotoId: string | null;
  // Every photo id (cover first), for the thumbnail strip.
  photoIds: string[];
  // Milestone 7 (Vinted category catalogue sync) — display-only; the id
  // itself is never edited here, only via the Edit fields dialog's picker.
  vintedCategoryPath: string | null;
  vintedCategoryStatus: string | null;
  // Follow-up correction (2026-08-04) — display-only, same reasoning.
  vintedAudience: VintedAudienceValue | null;
  vintedAudienceSource: "ai" | "manual" | null;
  // Follow-up correction (2026-08-05) — only ever rendered when the
  // audience still needs manual review (see deriveDraftAudience below),
  // never alongside a confidently-resolved audience.
  vintedAudienceEvidence: string[] | null;
  // Milestone 6 (purchase-price lookup and manual Vinted selling price).
  sellingPricePence: number | null;
  purchaseMatch: SkuPurchaseMatch;
  // Cost/profit computed once by the parent (lib/listing-studio/
  // purchase-match.ts), and the same real extension-workflow status the
  // table's own Workflow column shows (never re-derived here).
  costPence: number | null;
  profitPence: number | null;
  workflowStatus: ExtensionWorkflowStatus | null;
  queuePosition: number | null;
  currentStep: string | null;
  detail: string | null;
  vintedDraftId: string | null;
  errorMessage: string | null;
  // Corrective pass (canonical unified row model) — false for an eBay-only
  // product (never generated for Vinted at all). The Vinted tab is only
  // ever rendered when this is true — symmetric with `ebay` below.
  hasVintedPreparation: boolean;
  // Stage 6 (eBay draft batches) — null when no eBay preparation exists
  // for this listing (see the product spec's own "Never fabricate an eBay
  // tab from a Vinted preparation" rule); the eBay tab is only ever
  // rendered when this is non-null.
  ebay: EbayTabData | null;
};

export type EbayTabData = {
  marketplaceDraftId: string;
  categoryId: string | null;
  contentReady: boolean;
  sellingPricePence: number | null;
  costPence: number | null;
  profitPence: number | null;
  quantity: number | null;
  conditionValue: string | null;
  selection: EbayPolicySelection;
  // PHASE 3/4 — the RETIRED Inventory API pipeline's own offer id, kept
  // ONLY as a historical, read-only fact (never displayed as if it were a
  // Seller Hub draft) — see lib/listing-studio/ebay-workflow-status.ts's
  // own corrective-pass comment. Wholly independent of workflowStatus
  // below, which describes the ACTIVE Sell Feed API pipeline.
  legacyOfferId: string | null;
  // Set once the Sell Feed API pipeline has genuinely confirmed a Seller
  // Hub draft exists for this listing — see
  // supabase-ebay-feed-drafts.sql's own column comment.
  feedDraftCreatedAt: string | null;
  workflowStatus: EbayFeedItemStatus | null;
  queuePosition: number | null;
  errorMessage: string | null;
  // CORRECTIVE PASS (second real submission — duplicate-submission
  // defect, Phase 6) — server-computed via
  // lib/listing-studio/ebay-feed/feed-workflow-status.ts's own
  // computeEbayFeedBatchBlockingState, the single source of truth this
  // page's own eligibility check (evaluateEbayFeedDraftEligibility) reads
  // directly, so the client never re-derives "is this listing already in
  // an active or failed batch" from raw status fields itself.
  feedBatchState: EbayFeedBatchBlockingState;
};

/**
 * The compact "Selected listing" inspector (reference image 4) — a
 * persistent right-rail panel, never a modal: stays mounted while the user
 * clicks between different rows in ListingsTable, only its `listing` prop
 * changes. Deliberately compact: a medium 16:9 image (not a full-height
 * hero), a small thumbnail strip, one financial summary row, a trimmed
 * 2-column metadata grid (Brand/Category/Condition/Colours — the reference's
 * own exact fields), and exactly two primary actions (Edit, Preview,
 * reusing the existing dialogs verbatim) plus a small overflow menu for the
 * less-common actions (Assign category/Reassess audience/Mark ready/Send-
 * Resend to extension) — every one of those remains fully working, just
 * relocated out of the primary row to match the reference's exact 2-button
 * action row without deleting any existing functionality.
 */
function ListingDetailsPanel({
  listing, position, markingReady, assigningCategory, reassessingAudience,
  onOpenCarousel, onPreview, onEditFields, onAssignCategory, onReassessAudience, onMarkReady, onSellingPriceSaved,
  onClose, onPrevious, onNext, onSendToExtension,
  ebayPolicies, ebayLocations, onEbaySettingsSaved, activeWorkflowChannel,
}: {
  listing: ListingDetails | null;
  // null when nothing is selected, OR when the selected listing has been
  // filtered out of the currently visible set — never shows a misleading
  // "0 of N".
  position: { index: number; total: number } | null;
  markingReady: boolean;
  assigningCategory: boolean;
  reassessingAudience: boolean;
  onOpenCarousel: (listingId: string, photoId?: string) => void;
  onPreview: (listingId: string) => void;
  onEditFields: (listingId: string) => void;
  onAssignCategory: (listingId: string) => void;
  onReassessAudience: (listingId: string) => void;
  onMarkReady: (listingId: string) => void;
  onSellingPriceSaved: (listingId: string, pence: number) => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSendToExtension: (listingId: string) => void;
  // Stage 6 (eBay draft batches) — the connected account's own currently-
  // synced policies/locations, fetched once by the parent workspace (never
  // refetched per listing).
  ebayPolicies: EbayPolicyOption[];
  ebayLocations: EbayLocationOption[];
  onEbaySettingsSaved: (listingId: string, patch: { sellingPricePence?: number } & Partial<EbayPolicySelection>) => void;
  // Corrective pass — the table's own Workflow-column active channel
  // (Vinted/eBay toggle). Used ONLY to pick which tab to prefer the FIRST
  // time a listing is selected while it has both channels available —
  // switching this later never forces the inspector's own tab to jump
  // out from under the user (see the effect below's own comment).
  activeWorkflowChannel: "VINTED" | "EBAY_UK";
}) {
  // The thumbnail strip's own "which photo is the main image right now"
  // state — reset whenever the selected listing itself changes, never
  // carried over from a previously-viewed listing's photo selection.
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  useEffect(() => { setActivePhotoId(null); }, [listing?.id]);

  // Corrective pass — which marketplace tab is showing. A row can now
  // genuinely have ONLY Vinted, ONLY eBay, or both (see the listings-
  // review route's own unified-row-model header comment) — this is no
  // longer "always default to Vinted". On every listing change:
  //  1. If the CURRENTLY selected tab is still valid for the new listing
  //     (moving between two rows that both have, say, an eBay
  //     preparation), keep it — "preserve the selected tab where
  //     sensible when moving between compatible rows".
  //  2. Otherwise prefer whichever channel the table's own active
  //     Workflow toggle is currently showing, IF this listing has that
  //     channel — "prefer the currently selected workflow channel when
  //     initially selecting the details tab if that channel exists".
  //  3. Otherwise fall back to whichever single channel this listing
  //     actually has.
  const [activeTab, setActiveTab] = useState<"VINTED" | "EBAY_UK">("VINTED");
  useEffect(() => {
    if (!listing) return;
    setActiveTab(current => {
      if (current === "VINTED" && listing.hasVintedPreparation) return "VINTED";
      if (current === "EBAY_UK" && listing.ebay) return "EBAY_UK";
      if (activeWorkflowChannel === "EBAY_UK" && listing.ebay) return "EBAY_UK";
      if (activeWorkflowChannel === "VINTED" && listing.hasVintedPreparation) return "VINTED";
      if (listing.hasVintedPreparation) return "VINTED";
      if (listing.ebay) return "EBAY_UK";
      return "VINTED"; // defensive — a row with neither channel should not normally reach here
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on listing.id only: activeWorkflowChannel is read but must NOT itself retrigger this effect (that would yank the tab out from under the user just because they toggled the table's own Workflow view while still looking at the same listing — see this effect's own doc comment, point 1).
  }, [listing?.id]);

  if (!listing) {
    return <aside className="lr-inspector lr-inspector-empty" aria-label="Selected listing">
      <p>Select a listing on the left to review it here.</p>
    </aside>;
  }

  // Follow-up correction (2026-08-05): evidence bullets are only ever
  // useful (and only ever shown) when the audience still needs manual
  // review — a confidently-resolved audience has no need to justify
  // itself in the UI. "Reassess audience" (the explicit, cost-warned
  // photo-based action) is offered exactly when the stored category
  // couldn't resolve specifically because of audience — never when a
  // manual audience choice protects this listing from AI changes.
  const needsAudienceReview = deriveDraftAudience(listing.vintedAudience) === "unknown";
  const canReassessWithPhotos = listing.vintedCategoryStatus === "audience_missing" && listing.vintedAudienceSource !== "manual";
  // Corrective pass — an eBay-only listing (hasVintedPreparation false)
  // must never offer Send to extension: its Vinted readiness fields are
  // naturally always "needs_review" anyway (no title/description/etc.
  // ever generated), but this makes the rule explicit and tested rather
  // than an accidental side effect — same reasoning as
  // ListingsTable.tsx's own rowMenuItems fix.
  const canSend = listing.hasVintedPreparation && listing.status !== "needs_review" && (listing.workflowStatus === null || listing.workflowStatus === "failed");
  const displayLabel = listing.workflowStatus ? WORKFLOW_STATUS_LABELS[listing.workflowStatus] : READINESS_LABELS[listing.status];
  const displayTone = listing.workflowStatus ? WORKFLOW_STATUS_TONE[listing.workflowStatus] : READINESS_TONE[listing.status];
  const secondaryLine = computeWorkflowSecondaryLine({
    workflowStatus: listing.workflowStatus, queuePosition: listing.queuePosition, currentStep: listing.currentStep,
    detail: listing.detail, vintedDraftId: listing.vintedDraftId, errorMessage: listing.errorMessage,
  });
  const hasPrevious = position !== null && position.index > 0;
  const hasNext = position !== null && position.index < position.total - 1;
  const mainPhotoId = activePhotoId ?? listing.coverPhotoId;
  const thumbnailIds = listing.photoIds.slice(0, 5);

  // Corrective pass — a render-time safety net for the tab-selection
  // effect above: React effects run AFTER the render they were triggered
  // by, so the very first render of a freshly selected listing could
  // still be showing a STALE `activeTab` value that isn't actually valid
  // for this listing (e.g. "EBAY_UK" left over from the previous
  // selection, on a listing that has no eBay preparation at all) for one
  // frame before the effect corrects it. Resolving it here too means the
  // rendered content is ALWAYS valid for the current listing, never just
  // eventually valid.
  const showVintedTab = listing.hasVintedPreparation;
  const showEbayTab = listing.ebay !== null;
  const resolvedTab: "VINTED" | "EBAY_UK" =
    (activeTab === "VINTED" && showVintedTab) || (activeTab === "EBAY_UK" && showEbayTab)
      ? activeTab
      : showVintedTab ? "VINTED" : showEbayTab ? "EBAY_UK" : "VINTED";

  return <aside className="lr-inspector" aria-label="Selected listing">
    <div className="lr-inspector-header">
      <h2>Selected listing</h2>
      <div className="lr-inspector-header-actions">
        {position && <span className="lr-inspector-position">{position.index + 1} of {position.total}</span>}
        <button type="button" className="lr-inspector-nav" disabled={!hasPrevious} onClick={onPrevious} aria-label="Previous listing">‹</button>
        <button type="button" className="lr-inspector-nav" disabled={!hasNext} onClick={onNext} aria-label="Next listing">›</button>
        <button type="button" className="lr-inspector-nav" onClick={onClose} aria-label="Close">×</button>
      </div>
    </div>

    <button
      type="button"
      className="lr-inspector-image-button"
      onClick={() => onOpenCarousel(listing.id, mainPhotoId ?? undefined)}
      disabled={!mainPhotoId}
      aria-label="View all photos for this listing"
    >
      {mainPhotoId
        // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img>
        ? <img className="lr-inspector-image" src={`/api/listing-studio/images/${mainPhotoId}/view`} alt="" />
        : <div className="lr-inspector-image lr-inspector-image-empty" aria-hidden="true">No photo</div>}
    </button>

    {thumbnailIds.length > 1 && <div className="lr-inspector-thumbs">
      {thumbnailIds.map(photoId => <button
        type="button"
        key={photoId}
        className={photoId === mainPhotoId ? "lr-inspector-thumb lr-inspector-thumb-active" : "lr-inspector-thumb"}
        onClick={() => setActivePhotoId(photoId)}
        aria-label="Show this photo as the main image"
        aria-pressed={photoId === mainPhotoId}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img> */}
        <img src={`/api/listing-studio/images/${photoId}/view`} alt="" />
      </button>)}
    </div>}

    {listing.warnings.length > 0 && <ul className="lr-inspector-warnings" role="list" aria-label="Warnings">
      {listing.warnings.map(warning => <li key={warning} className="lr-inspector-warning">{warning}</li>)}
    </ul>}

    <h3 className="lr-inspector-title">{listing.generatedTitle || "Untitled listing"}</h3>
    <p className="lr-inspector-sku">{listing.sku || "No SKU"} {listing.ukSize && `· UK ${listing.ukSize}`}</p>

    {/* Corrective pass — the marketplace tab strip is only ever rendered
        when there is genuinely something to switch between: BOTH a real
        Vinted preparation AND a real eBay preparation. A Vinted-only
        listing shows no strip at all (just its Vinted content directly —
        never a fake single-option tab), and likewise for an eBay-only
        listing. Switching tabs never touches the other marketplace's own
        stored data — each tab reads only its own fields. */}
    {showVintedTab && showEbayTab && <div className="lr-inspector-tabs" role="tablist" aria-label="Marketplace">
      <button type="button" role="tab" aria-selected={resolvedTab === "VINTED"} className={resolvedTab === "VINTED" ? "lr-inspector-tab active" : "lr-inspector-tab"} onClick={() => setActiveTab("VINTED")}>Vinted</button>
      <button type="button" role="tab" aria-selected={resolvedTab === "EBAY_UK"} className={resolvedTab === "EBAY_UK" ? "lr-inspector-tab active" : "lr-inspector-tab"} onClick={() => setActiveTab("EBAY_UK")}>eBay</button>
    </div>}

    {resolvedTab === "VINTED"
      ? <WorkflowStatus label={displayLabel} tone={displayTone} pulse={listing.workflowStatus === "in_progress"} secondaryLine={secondaryLine} />
      : listing.ebay && <EbayWorkflowStatusBlock ebay={listing.ebay} />}
    {resolvedTab === "EBAY_UK" && listing.ebay && <EbayFailedDraftActions ebay={listing.ebay} />}

    <div className="lr-inspector-money">
      <span><span className="lr-inspector-money-label">Cost</span>{(resolvedTab === "VINTED" ? listing.costPence : listing.ebay?.costPence ?? null) !== null ? formatPenceAsGBP((resolvedTab === "VINTED" ? listing.costPence : listing.ebay!.costPence)!) : "—"}</span>
      <span><span className="lr-inspector-money-label">Price</span>{(resolvedTab === "VINTED" ? listing.sellingPricePence : listing.ebay?.sellingPricePence ?? null) !== null ? formatPenceAsGBP((resolvedTab === "VINTED" ? listing.sellingPricePence : listing.ebay!.sellingPricePence)!) : "—"}</span>
      {(() => {
        const profitPence = resolvedTab === "VINTED" ? listing.profitPence : listing.ebay?.profitPence ?? null;
        return <span className={profitPence !== null && profitPence > 0 ? "lr-profit-positive" : undefined}>
          <span className="lr-inspector-money-label">Profit</span>{profitPence !== null ? formatPenceAsGBP(profitPence) : "—"}
        </span>;
      })()}
    </div>

    <dl className="lr-inspector-fields">
      <div><dt>Brand</dt><dd>{listing.brand || "Not set"}</dd></div>
      <div><dt>Condition</dt><dd>{listing.condition || "Not set"}</dd></div>
      <div><dt>Colour{listing.colours.length > 1 ? "s" : ""}</dt><dd>{listing.colours.length > 0 ? listing.colours.join(" & ") : "Not set"}</dd></div>
    </dl>

    {/* Category gets its own full-width row beneath the 2-column grid —
        a full Vinted path ("Men > Shoes > Sports shoes > Running shoes")
        is routinely much longer than Brand/Condition/Colour(s), and
        sharing a narrow 1-of-2 grid column let a single long word force
        that column wider than its fair share (CSS grid items default to
        min-width: auto, not 0), pushing the whole card into horizontal
        overflow. Full width + explicit containment fixes this properly
        rather than truncating real category information away. Brand/
        Condition/Colour/Category are shared review data (sourced from the
        product's own structured fields, common ground for both
        marketplaces) — shown identically regardless of the active tab. */}
    <dl className="lr-inspector-category">
      <dt>Category</dt>
      <dd>{listing.vintedCategoryPath || listing.productType || "Not set"}</dd>
    </dl>

    {resolvedTab === "VINTED" && needsAudienceReview && listing.vintedAudienceEvidence && listing.vintedAudienceEvidence.length > 0 && <div className="lr-inspector-audience-evidence">
      <p className="lr-inspector-audience-evidence-label">Audience evidence considered so far</p>
      <ul role="list">
        {listing.vintedAudienceEvidence.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>}

    {/* Purchase-price lookup + manual selling price, per active tab — kept
        close to SKU/selling price per Milestone 6's own placement
        requirement. The purchase price is read-only and never copied into
        either selling-price field. Saving one marketplace's price/policies
        never overwrites the other's — each tab posts to its own route. */}
    {resolvedTab === "VINTED" ? <div className="lr-inspector-purchase">
      <p className="lr-inspector-purchase-line">{describePurchaseMatch(listing.purchaseMatch)}</p>
      {listing.purchaseMatch.status === "duplicate" && <ul className="lr-inspector-purchase-duplicates" role="list">
        {listing.purchaseMatch.matches.map((match, index) => <li key={index}>
          {match.orderDate ?? "Unknown date"} — {match.itemDescription} — {match.pricePence !== null ? `£${(match.pricePence / 100).toFixed(2)}` : "price unavailable"}
        </li>)}
      </ul>}
      <SellingPriceField
        key={listing.id}
        listingId={listing.id}
        sellingPricePence={listing.sellingPricePence}
        onSaved={pence => onSellingPriceSaved(listing.id, pence)}
      />
    </div> : listing.ebay && <div className="lr-inspector-purchase">
      <p className="lr-inspector-purchase-line">{describePurchaseMatch(listing.purchaseMatch)}</p>
      <EbaySellingPriceField
        key={listing.id}
        listingId={listing.id}
        sellingPricePence={listing.ebay.sellingPricePence}
        onSaved={pence => onEbaySettingsSaved(listing.id, { sellingPricePence: pence })}
      />
      <EbayPolicySelectors
        listingId={listing.id}
        policies={ebayPolicies}
        locations={ebayLocations}
        selection={listing.ebay.selection}
        onSaved={patch => onEbaySettingsSaved(listing.id, patch)}
      />
    </div>}

    <div className="lr-inspector-actions">
      <button type="button" className="button-secondary" onClick={() => onEditFields(listing.id)}>Edit</button>
      <button type="button" className="button-secondary" onClick={() => onPreview(listing.id)}>Preview</button>
      {/* Assign category/Reassess audience/Mark ready/Send-Resend all
          remain fully working — relocated here (rather than the primary
          row) to match the reference's exact "Edit, Preview" action row
          without removing any existing functionality. Corrective pass —
          Assign category/Reassess audience/Mark ready are all fundamentally
          VINTED concepts (they read/write vinted_category_id/
          vinted_audience/review_marked_ready_at) and are now gated behind
          hasVintedPreparation, exactly like Send to extension already was
          — an eBay-only listing offers none of them. */}
      <OverflowMenu label="More actions for this listing" items={[
        ...(listing.hasVintedPreparation ? [{ label: assigningCategory ? "Assigning…" : "Assign category", onClick: () => onAssignCategory(listing.id), disabled: assigningCategory }] : []),
        ...(listing.hasVintedPreparation && canReassessWithPhotos ? [{ label: reassessingAudience ? "Reassessing…" : "Reassess audience", onClick: () => onReassessAudience(listing.id), disabled: reassessingAudience }] : []),
        ...(listing.hasVintedPreparation ? [{ label: markingReady ? "Marking ready…" : "Mark ready", onClick: () => onMarkReady(listing.id), disabled: markingReady || listing.status !== "edited" }] : []),
        ...(canSend ? [{ label: listing.workflowStatus === "failed" ? "Resend to extension" : "Send to extension", onClick: () => onSendToExtension(listing.id) }] : []),
      ]} />
    </div>
  </aside>;
}

export default memo(ListingDetailsPanel);
