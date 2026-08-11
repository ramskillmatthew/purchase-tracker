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
import { WorkflowStatus } from "./WorkflowStatus";
import OverflowMenu from "@/components/listing-studio/OverflowMenu";
import SellingPriceField from "./SellingPriceField";

// Same readiness labels/tones ListingsTable.tsx uses for its own fallback —
// kept in sync deliberately (not imported, since it's a small literal
// lookup, not a shared function) so the inspector's status always matches
// the row's own, never a second status language.
const READINESS_LABELS: Record<ListingReviewStatus, string> = { ready: "Ready", needs_review: "Need review", edited: "Ready" };
const READINESS_TONE: Record<ListingReviewStatus, string> = { ready: READINESS_TONE_READY, needs_review: READINESS_TONE_NEEDS_REVIEW, edited: READINESS_TONE_READY };

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
}) {
  // The thumbnail strip's own "which photo is the main image right now"
  // state — reset whenever the selected listing itself changes, never
  // carried over from a previously-viewed listing's photo selection.
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  useEffect(() => { setActivePhotoId(null); }, [listing?.id]);

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
  const canSend = listing.status !== "needs_review" && (listing.workflowStatus === null || listing.workflowStatus === "failed");
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
    <WorkflowStatus label={displayLabel} tone={displayTone} pulse={listing.workflowStatus === "in_progress"} secondaryLine={secondaryLine} />

    <div className="lr-inspector-money">
      <span><span className="lr-inspector-money-label">Cost</span>{listing.costPence !== null ? formatPenceAsGBP(listing.costPence) : "—"}</span>
      <span><span className="lr-inspector-money-label">Price</span>{listing.sellingPricePence !== null ? formatPenceAsGBP(listing.sellingPricePence) : "—"}</span>
      <span className={listing.profitPence !== null && listing.profitPence > 0 ? "lr-profit-positive" : undefined}>
        <span className="lr-inspector-money-label">Profit</span>{listing.profitPence !== null ? formatPenceAsGBP(listing.profitPence) : "—"}
      </span>
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
        rather than truncating real category information away. */}
    <dl className="lr-inspector-category">
      <dt>Category</dt>
      <dd>{listing.vintedCategoryPath || listing.productType || "Not set"}</dd>
    </dl>

    {needsAudienceReview && listing.vintedAudienceEvidence && listing.vintedAudienceEvidence.length > 0 && <div className="lr-inspector-audience-evidence">
      <p className="lr-inspector-audience-evidence-label">Audience evidence considered so far</p>
      <ul role="list">
        {listing.vintedAudienceEvidence.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>}

    {/* Purchase-price lookup + manual Vinted selling price — kept close to
        SKU/selling price per that milestone's own placement requirement.
        The purchase price is read-only and never copied into the selling-
        price field below. */}
    <div className="lr-inspector-purchase">
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
    </div>

    <div className="lr-inspector-actions">
      <button type="button" className="button-secondary" onClick={() => onEditFields(listing.id)}>Edit</button>
      <button type="button" className="button-secondary" onClick={() => onPreview(listing.id)}>Preview</button>
      {/* Assign category/Reassess audience/Mark ready/Send-Resend all
          remain fully working — relocated here (rather than the primary
          row) to match the reference's exact "Edit, Preview" action row
          without removing any existing functionality. */}
      <OverflowMenu label="More actions for this listing" items={[
        { label: assigningCategory ? "Assigning…" : "Assign category", onClick: () => onAssignCategory(listing.id), disabled: assigningCategory },
        ...(canReassessWithPhotos ? [{ label: reassessingAudience ? "Reassessing…" : "Reassess audience", onClick: () => onReassessAudience(listing.id), disabled: reassessingAudience }] : []),
        { label: markingReady ? "Marking ready…" : "Mark ready", onClick: () => onMarkReady(listing.id), disabled: markingReady || listing.status !== "edited" },
        ...(canSend ? [{ label: listing.workflowStatus === "failed" ? "Resend to extension" : "Send to extension", onClick: () => onSendToExtension(listing.id) }] : []),
      ]} />
    </div>
  </aside>;
}

export default memo(ListingDetailsPanel);
