"use client";

import { memo, useEffect, useRef } from "react";
import type { ListingReviewStatus } from "@/lib/listing-studio/listing-review";
import {
  WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_TONE, READINESS_TONE_READY, READINESS_TONE_NEEDS_REVIEW,
  computeWorkflowSecondaryLine, type ExtensionWorkflowStatus,
} from "@/lib/listing-studio/extension-workflow-status";
// PHASE 4 (Listings Review UI wiring) — the eBay workflow column now
// reflects the Sell Feed API pipeline (the one that creates a genuine
// Seller Hub draft), never the retired Inventory API pipeline's own
// vocabulary (lib/listing-studio/ebay-workflow-status.ts, kept only for
// that retired pipeline's own historical batch display elsewhere).
import {
  EBAY_FEED_ITEM_STATUS_LABELS, EBAY_FEED_ITEM_STATUS_TONE, computeEbayFeedWorkflowSecondaryLine, isEbayFeedItemInProgress,
  type EbayFeedItemStatus,
} from "@/lib/listing-studio/ebay-feed/feed-workflow-status";
import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";
import { WorkflowStatus } from "./WorkflowStatus";
import OverflowMenu, { type OverflowMenuItem } from "@/components/listing-studio/OverflowMenu";

export type ListingMarketplaceView = "VINTED" | "EBAY_UK";

export type ListingTableRow = {
  id: string;
  generatedTitle: string;
  sku: string | null;
  ukSize: string | null;
  status: ListingReviewStatus;
  workflowStatus: ExtensionWorkflowStatus | null;
  queuePosition: number | null;
  currentStep: string | null;
  detail: string | null;
  vintedDraftId: string | null;
  errorMessage: string | null;
  costPence: number | null;
  sellingPricePence: number | null;
  profitPence: number | null;
  coverPhotoId: string | null;
  // Corrective pass (canonical unified row model) — a row on this page no
  // longer always has real Vinted content: an eBay-only product (never
  // generated for Vinted — see the listings-review route's own header
  // comment for the proven bug this closes) is now visible too, with
  // hasVintedPreparation === false for it. Symmetric with
  // hasEbayPreparation below: "not prepared" is a restrained,
  // non-actionable state on EITHER channel, never treated as an error.
  hasVintedPreparation: boolean;
  // Stage 6 (eBay draft batches) — independent of every Vinted field
  // above. hasEbayPreparation false means "not prepared" — a restrained,
  // non-actionable state, never treated as an error (see the product
  // spec's own "Visibility rules" for the workflow toggle).
  hasEbayPreparation: boolean;
  ebayContentReady: boolean;
  ebayWorkflowStatus: EbayFeedItemStatus | null;
  ebayQueuePosition: number | null;
  ebayErrorMessage: string | null;
  ebaySellingPricePence: number | null;
  ebayProfitPence: number | null;
};

// Readiness reuses the same emerald/amber the workflow statuses use for
// "no problem"/"needs attention" — one shared palette across every status
// this page ever shows (see lib/listing-studio/extension-workflow-status.ts).
const READINESS_LABELS: Record<ListingReviewStatus, string> = { ready: "Ready", needs_review: "Need review", edited: "Ready" };
const READINESS_TONE: Record<ListingReviewStatus, string> = { ready: READINESS_TONE_READY, needs_review: READINESS_TONE_NEEDS_REVIEW, edited: READINESS_TONE_READY };
const NOT_PREPARED_TONE = "#7E8798"; // same neutral grey Vinted's own "in_queue" tone uses — never a new colour

/** The one place a row's displayed workflow cell (label/tone/pulse/
 * secondary line) is computed for whichever marketplace is currently
 * selected — used identically by the desktop table and the mobile card
 * list below, so neither can ever show a different answer for the same
 * row. Completing/failing one marketplace never touches the other's own
 * independently-stored fields on this same row object. */
function resolveWorkflowDisplay(row: ListingTableRow, activeMarketplace: ListingMarketplaceView) {
  if (activeMarketplace === "VINTED") {
    // Corrective pass — symmetric with the eBay branch below: a row with
    // no real Vinted content (an eBay-only product) must never show a
    // misleading readiness-derived label like "Need review" here.
    if (!row.hasVintedPreparation) {
      return { label: "Not prepared", tone: NOT_PREPARED_TONE, pulse: false, secondaryLine: null, pricePence: row.sellingPricePence, profitPence: row.profitPence };
    }
    return {
      label: row.workflowStatus ? WORKFLOW_STATUS_LABELS[row.workflowStatus] : READINESS_LABELS[row.status],
      tone: row.workflowStatus ? WORKFLOW_STATUS_TONE[row.workflowStatus] : READINESS_TONE[row.status],
      pulse: row.workflowStatus === "in_progress",
      secondaryLine: computeWorkflowSecondaryLine({
        workflowStatus: row.workflowStatus, queuePosition: row.queuePosition, currentStep: row.currentStep,
        detail: row.detail, vintedDraftId: row.vintedDraftId, errorMessage: row.errorMessage,
      }),
      pricePence: row.sellingPricePence, profitPence: row.profitPence,
    };
  }
  if (!row.hasEbayPreparation) {
    return { label: "Not prepared", tone: NOT_PREPARED_TONE, pulse: false, secondaryLine: null, pricePence: row.ebaySellingPricePence, profitPence: row.ebayProfitPence };
  }
  const label = row.ebayWorkflowStatus ? EBAY_FEED_ITEM_STATUS_LABELS[row.ebayWorkflowStatus] : (row.ebayContentReady ? "Ready" : "Needs review");
  const tone = row.ebayWorkflowStatus ? EBAY_FEED_ITEM_STATUS_TONE[row.ebayWorkflowStatus] : (row.ebayContentReady ? READINESS_TONE_READY : READINESS_TONE_NEEDS_REVIEW);
  return {
    label, tone, pulse: isEbayFeedItemInProgress(row.ebayWorkflowStatus),
    secondaryLine: computeEbayFeedWorkflowSecondaryLine({ itemStatus: row.ebayWorkflowStatus, queuePosition: row.ebayQueuePosition, errorMessage: row.ebayErrorMessage }),
    pricePence: row.ebaySellingPricePence, profitPence: row.ebayProfitPence,
  };
}

function rowMenuItems(row: ListingTableRow, handlers: {
  onPreview: (id: string) => void;
  onEditFields: (id: string) => void;
  onSendToExtension?: (id: string) => void;
}): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = [
    { label: "Preview listing", onClick: () => handlers.onPreview(row.id) },
    { label: "Edit fields", onClick: () => handlers.onEditFields(row.id) },
  ];
  // Reuses the exact existing send-to-extension flow with a one-listing
  // selection — never a second batch-creation/retry mechanism.
  // Corrective pass — explicit hasVintedPreparation check: an eBay-only
  // row's Vinted readiness fields are naturally always "needs_review"
  // (missing title/description/etc.), which already excludes it here as
  // a side effect, but this makes "an eBay-only item is not eligible for
  // Send to extension" a deliberate, tested rule rather than an accident.
  if (handlers.onSendToExtension && row.hasVintedPreparation && row.status !== "needs_review" && (row.workflowStatus === null || row.workflowStatus === "failed")) {
    items.push({ label: row.workflowStatus === "failed" ? "Resend to extension" : "Send to extension", onClick: () => handlers.onSendToExtension!(row.id) });
  }
  return items;
}

/**
 * The left-hand listings table — dense rows matching the approved
 * reference (density/thumbnails/column alignment/selected-row background/
 * workflow dots/row overflow menu). Deliberately memo()'d and given only
 * the already-filtered/searched row list (computed once by the parent via
 * useMemo) so a keystroke in the search box re-renders exactly this table
 * once — never re-deriving status/warnings/cost/profit per row on every
 * keystroke (all computed once per listing in the parent).
 *
 * Stage 6 (eBay draft batches) — `activeMarketplace` and the small
 * Vinted/eBay text toggle beside the Workflow column heading are the ONLY
 * new things this table renders; every existing column/row/action is
 * completely unchanged in appearance. `marketplaceToggleOptions` lists
 * which marketplace options to offer (never a pointless two-option toggle
 * when every visible row only has one marketplace prepared).
 */
function ListingsTable({
  rows, selectedListingId, bulkSelectedIds, onSelectListing, onToggleBulkSelect, onToggleSelectAll, onPreview, onEditFields, onSendToExtension,
  activeMarketplace, marketplaceToggleOptions, onMarketplaceChange,
}: {
  rows: ListingTableRow[];
  selectedListingId: string | null;
  bulkSelectedIds: Set<string>;
  onSelectListing: (id: string) => void;
  onToggleBulkSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onPreview: (id: string) => void;
  onEditFields: (id: string) => void;
  onSendToExtension: (id: string) => void;
  activeMarketplace: ListingMarketplaceView;
  marketplaceToggleOptions: ListingMarketplaceView[];
  onMarketplaceChange: (marketplace: ListingMarketplaceView) => void;
}) {
  const selectedCount = rows.filter(row => bulkSelectedIds.has(row.id)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;
  const someSelected = selectedCount > 0 && !allSelected;

  // No declarative HTML attribute exists for the indeterminate checkbox
  // state — it's exposed only as a DOM property, set imperatively.
  // Recomputed from the currently VISIBLE (filtered) rows every render, so
  // filtering can never leave a stale/wrong selection count on display.
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const workflowHeader = <>
    Workflow
    {marketplaceToggleOptions.length > 1 && <span className="lr-marketplace-toggle" role="group" aria-label="Workflow marketplace">
      {marketplaceToggleOptions.map(marketplace => <button
        key={marketplace} type="button"
        className={marketplace === activeMarketplace ? "lr-marketplace-toggle-btn active" : "lr-marketplace-toggle-btn"}
        onClick={event => { event.stopPropagation(); onMarketplaceChange(marketplace); }}
        aria-pressed={marketplace === activeMarketplace}
      >
        {marketplace === "VINTED" ? "Vinted" : "eBay"}
      </button>)}
    </span>}
  </>;

  if (rows.length === 0) {
    return <div className="lr-table-scroll lr-table-empty">
      <strong>No listings match.</strong><span>Try a different search or filter.</span>
    </div>;
  }

  return <>
    {/* Desktop/tablet — a real dense table, hidden below the mobile
        breakpoint (app/globals.css) in favour of the card list below.
        table-layout: fixed with explicit per-column widths is what keeps
        every column — including Workflow and the row menu — visible
        without horizontal scroll at normal desktop widths; only the
        Listing column is left unconstrained so it absorbs remaining space.
        Cost/Price/Profit are each given a real, measured width so a
        four-figure amount (e.g. £1,234.56) never truncates or ellipsises. */}
    <div className="table-scroll lr-table-scroll">
      <table className="lr-table">
        <thead>
          <tr>
            <th><input ref={selectAllRef} type="checkbox" aria-label={someSelected ? `${selectedCount} of ${rows.length} listings selected` : "Select all listings"} checked={allSelected} onChange={onToggleSelectAll} /></th>
            <th>Photo</th>
            <th>Listing</th>
            <th>Size</th>
            <th>Cost</th>
            <th>Price</th>
            <th>Profit</th>
            <th>{workflowHeader}</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const display = resolveWorkflowDisplay(row, activeMarketplace);
            return <tr
              key={row.id}
              tabIndex={0}
              className={row.id === selectedListingId ? "lr-row lr-row-active" : "lr-row"}
              onClick={() => onSelectListing(row.id)}
              onKeyDown={event => { if (event.key === "Enter") onSelectListing(row.id); }}
            >
              <td className="lr-checkbox-cell" onClick={event => event.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${row.generatedTitle || "this listing"}`} checked={bulkSelectedIds.has(row.id)} onChange={() => onToggleBulkSelect(row.id)} />
              </td>
              <td>
                {row.coverPhotoId
                  // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img>
                  ? <img className="lr-cover-thumb" src={`/api/listing-studio/images/${row.coverPhotoId}/view`} alt="" />
                  : <div className="lr-cover-thumb lr-cover-thumb-empty" aria-hidden="true" />}
              </td>
              <td className="lr-title-cell">
                <span className="lr-title-text" title={row.generatedTitle || "Untitled listing"}>{row.generatedTitle || "Untitled listing"}</span>
                <span className="lr-title-sku">{row.sku || "No SKU"}</span>
              </td>
              <td>{row.ukSize || "—"}</td>
              <td className="lr-money-cell">{row.costPence !== null ? formatPenceAsGBP(row.costPence) : "—"}</td>
              <td className="lr-money-cell">{display.pricePence !== null ? formatPenceAsGBP(display.pricePence) : "—"}</td>
              <td className={`lr-money-cell${display.profitPence !== null && display.profitPence > 0 ? " lr-profit-positive" : ""}`}>{display.profitPence !== null ? formatPenceAsGBP(display.profitPence) : "—"}</td>
              <td>
                <WorkflowStatus label={display.label} tone={display.tone} pulse={display.pulse} secondaryLine={display.secondaryLine} />
              </td>
              <td className="lr-row-actions" onClick={event => event.stopPropagation()}>
                <OverflowMenu label={`More actions for ${row.generatedTitle || "this listing"}`} items={rowMenuItems(row, { onPreview, onEditFields, onSendToExtension })} />
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile — compact cards, hidden above the mobile breakpoint. Same
        rows/handlers as the table above; Workflow and the primary Send/
        selection affordances stay immediately visible, never buried. */}
    <ul className="lr-card-list">
      {rows.map(row => {
        const display = resolveWorkflowDisplay(row, activeMarketplace);
        return <li
          key={row.id}
          className={row.id === selectedListingId ? "lr-card lr-card-active" : "lr-card"}
          onClick={() => onSelectListing(row.id)}
        >
          <div className="lr-card-checkbox" onClick={event => event.stopPropagation()}>
            <input type="checkbox" aria-label={`Select ${row.generatedTitle || "this listing"}`} checked={bulkSelectedIds.has(row.id)} onChange={() => onToggleBulkSelect(row.id)} />
          </div>
          {row.coverPhotoId
            // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img>
            ? <img className="lr-cover-thumb" src={`/api/listing-studio/images/${row.coverPhotoId}/view`} alt="" />
            : <div className="lr-cover-thumb lr-cover-thumb-empty" aria-hidden="true" />}
          <div className="lr-card-body">
            <span className="lr-title-text">{row.generatedTitle || "Untitled listing"}</span>
            <span className="lr-title-sku">{row.sku || "No SKU"} {row.ukSize && `· UK ${row.ukSize}`}</span>
            <div className="lr-card-money">
              <span>{row.costPence !== null ? formatPenceAsGBP(row.costPence) : "—"}</span>
              <span>{display.pricePence !== null ? formatPenceAsGBP(display.pricePence) : "—"}</span>
              <span className={display.profitPence !== null && display.profitPence > 0 ? "lr-profit-positive" : undefined}>{display.profitPence !== null ? formatPenceAsGBP(display.profitPence) : "—"}</span>
            </div>
            <WorkflowStatus label={display.label} tone={display.tone} pulse={display.pulse} secondaryLine={display.secondaryLine} />
          </div>
          <div className="lr-card-actions" onClick={event => event.stopPropagation()}>
            <OverflowMenu label={`More actions for ${row.generatedTitle || "this listing"}`} items={rowMenuItems(row, { onPreview, onEditFields, onSendToExtension })} />
          </div>
        </li>;
      })}
    </ul>
  </>;
}

export default memo(ListingsTable);
