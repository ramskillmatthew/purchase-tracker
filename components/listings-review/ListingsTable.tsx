"use client";

import { memo, useEffect, useRef } from "react";
import type { ListingReviewStatus } from "@/lib/listing-studio/listing-review";
import {
  WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_TONE, READINESS_TONE_READY, READINESS_TONE_NEEDS_REVIEW,
  computeWorkflowSecondaryLine, type ExtensionWorkflowStatus,
} from "@/lib/listing-studio/extension-workflow-status";
import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";
import { WorkflowStatus } from "./WorkflowStatus";
import OverflowMenu, { type OverflowMenuItem } from "@/components/listing-studio/OverflowMenu";

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
};

// Readiness reuses the same emerald/amber the workflow statuses use for
// "no problem"/"needs attention" — one shared palette across every status
// this page ever shows (see lib/listing-studio/extension-workflow-status.ts).
const READINESS_LABELS: Record<ListingReviewStatus, string> = { ready: "Ready", needs_review: "Need review", edited: "Ready" };
const READINESS_TONE: Record<ListingReviewStatus, string> = { ready: READINESS_TONE_READY, needs_review: READINESS_TONE_NEEDS_REVIEW, edited: READINESS_TONE_READY };

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
  if (handlers.onSendToExtension && row.status !== "needs_review" && (row.workflowStatus === null || row.workflowStatus === "failed")) {
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
 */
function ListingsTable({ rows, selectedListingId, bulkSelectedIds, onSelectListing, onToggleBulkSelect, onToggleSelectAll, onPreview, onEditFields, onSendToExtension }: {
  rows: ListingTableRow[];
  selectedListingId: string | null;
  bulkSelectedIds: Set<string>;
  onSelectListing: (id: string) => void;
  onToggleBulkSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onPreview: (id: string) => void;
  onEditFields: (id: string) => void;
  onSendToExtension: (id: string) => void;
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
            <th>Workflow</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const displayLabel = row.workflowStatus ? WORKFLOW_STATUS_LABELS[row.workflowStatus] : READINESS_LABELS[row.status];
            const displayTone = row.workflowStatus ? WORKFLOW_STATUS_TONE[row.workflowStatus] : READINESS_TONE[row.status];
            const secondaryLine = computeWorkflowSecondaryLine({
              workflowStatus: row.workflowStatus, queuePosition: row.queuePosition, currentStep: row.currentStep,
              detail: row.detail, vintedDraftId: row.vintedDraftId, errorMessage: row.errorMessage,
            });
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
              <td className="lr-money-cell">{row.sellingPricePence !== null ? formatPenceAsGBP(row.sellingPricePence) : "—"}</td>
              <td className={`lr-money-cell${row.profitPence !== null && row.profitPence > 0 ? " lr-profit-positive" : ""}`}>{row.profitPence !== null ? formatPenceAsGBP(row.profitPence) : "—"}</td>
              <td>
                <WorkflowStatus label={displayLabel} tone={displayTone} pulse={row.workflowStatus === "in_progress"} secondaryLine={secondaryLine} />
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
        const displayLabel = row.workflowStatus ? WORKFLOW_STATUS_LABELS[row.workflowStatus] : READINESS_LABELS[row.status];
        const displayTone = row.workflowStatus ? WORKFLOW_STATUS_TONE[row.workflowStatus] : READINESS_TONE[row.status];
        const secondaryLine = computeWorkflowSecondaryLine({
          workflowStatus: row.workflowStatus, queuePosition: row.queuePosition, currentStep: row.currentStep,
          detail: row.detail, vintedDraftId: row.vintedDraftId, errorMessage: row.errorMessage,
        });
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
              <span>{row.sellingPricePence !== null ? formatPenceAsGBP(row.sellingPricePence) : "—"}</span>
              <span className={row.profitPence !== null && row.profitPence > 0 ? "lr-profit-positive" : undefined}>{row.profitPence !== null ? formatPenceAsGBP(row.profitPence) : "—"}</span>
            </div>
            <WorkflowStatus label={displayLabel} tone={displayTone} pulse={row.workflowStatus === "in_progress"} secondaryLine={secondaryLine} />
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
