"use client";

import { memo } from "react";
import type { ListingReviewStatus } from "@/lib/listing-studio/listing-review";
import { VINTED_AUDIENCE_LABELS, type VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import { deriveDraftAudience } from "@/lib/listing-studio/vinted-category-selection";

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
};

/**
 * Milestone 5 — the persistent right panel (never a modal): stays mounted
 * and visible while the user clicks between different rows in
 * ListingsTable, only its `listing` prop changes. "Mark ready" is only
 * ever actionable on an Edited listing — it has no effect on Needs Review
 * (missing fields always win, see listing-review.ts's own comment) and
 * nothing to do on an already-Ready one.
 */
function ListingDetailsPanel({ listing, markingReady, assigningCategory, reassessingAudience, onOpenCarousel, onPreview, onEditFields, onAssignCategory, onReassessAudience, onMarkReady }: {
  listing: ListingDetails | null;
  markingReady: boolean;
  assigningCategory: boolean;
  reassessingAudience: boolean;
  onOpenCarousel: (listingId: string) => void;
  onPreview: (listingId: string) => void;
  onEditFields: (listingId: string) => void;
  onAssignCategory: (listingId: string) => void;
  onReassessAudience: (listingId: string) => void;
  onMarkReady: (listingId: string) => void;
}) {
  if (!listing) {
    return <aside className="listings-review-panel listings-review-panel-empty" aria-label="Listing details">
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

  return <aside className="listings-review-panel" aria-label="Listing details">
    <button
      type="button"
      className="listings-review-panel-image-button"
      onClick={() => onOpenCarousel(listing.id)}
      disabled={!listing.coverPhotoId}
      aria-label="View all photos for this listing"
    >
      {listing.coverPhotoId
        // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img>
        ? <img className="listings-review-panel-image" src={`/api/listing-studio/images/${listing.coverPhotoId}/view`} alt="" />
        : <div className="listings-review-panel-image listings-review-panel-image-empty" aria-hidden="true">No photo</div>}
    </button>

    {listing.warnings.length > 0 && <ul className="listings-review-warnings" role="list" aria-label="Warnings">
      {listing.warnings.map(warning => <li key={warning} className="listings-review-warning">{warning}</li>)}
    </ul>}

    <h2 className="listings-review-panel-title">{listing.generatedTitle || "Untitled listing"}</h2>
    <p className="listings-review-panel-description">{listing.generatedDescription || "No description generated yet."}</p>

    <dl className="listings-review-panel-fields">
      <div><dt>Brand</dt><dd>{listing.brand || "Not set"}</dd></div>
      <div><dt>Model</dt><dd>{listing.model || "Not set"}</dd></div>
      <div><dt>Product type</dt><dd>{listing.productType || "Not set"}</dd></div>
      <div><dt>Colour{listing.colours.length > 1 ? "s" : ""}</dt><dd>{listing.colours.length > 0 ? listing.colours.join(" & ") : "Not set"}</dd></div>
      <div><dt>Material</dt><dd>{listing.material || "Not set"}</dd></div>
      <div><dt>UK size</dt><dd>{listing.ukSize || "Not set"}</dd></div>
      <div><dt>SKU</dt><dd>{listing.sku || "Not set"}</dd></div>
      <div><dt>Condition</dt><dd>{listing.condition || "Not set"}</dd></div>
      <div><dt>Vinted audience</dt><dd>{listing.vintedAudience ? VINTED_AUDIENCE_LABELS[listing.vintedAudience] : "Not set"}</dd></div>
      <div><dt>Vinted category</dt><dd>{listing.vintedCategoryPath || "Not set"}</dd></div>
    </dl>

    {needsAudienceReview && listing.vintedAudienceEvidence && listing.vintedAudienceEvidence.length > 0 && <div className="listings-review-panel-audience-evidence">
      <p className="listings-review-panel-audience-evidence-label">Audience evidence considered so far</p>
      <ul role="list">
        {listing.vintedAudienceEvidence.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>}

    <div className="listings-review-panel-actions">
      <button type="button" className="button-secondary" onClick={() => onPreview(listing.id)}>Preview listing</button>
      <button type="button" className="button-secondary" onClick={() => onEditFields(listing.id)}>Edit fields</button>
      <button type="button" className="button-secondary" disabled={assigningCategory} onClick={() => onAssignCategory(listing.id)}>
        {assigningCategory ? "Assigning…" : "Assign category"}
      </button>
      {canReassessWithPhotos && <button type="button" className="button-secondary" disabled={reassessingAudience} onClick={() => onReassessAudience(listing.id)}>
        {reassessingAudience ? "Reassessing…" : "Reassess audience"}
      </button>}
      <button type="button" className="button" disabled={markingReady || listing.status !== "edited"} onClick={() => onMarkReady(listing.id)}>
        {markingReady ? "Marking ready…" : "Mark ready"}
      </button>
    </div>
  </aside>;
}

export default memo(ListingDetailsPanel);
