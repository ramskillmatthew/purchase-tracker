"use client";

import { memo } from "react";
import type { ListingReviewStatus } from "@/lib/listing-studio/listing-review";

export type ListingTableRow = {
  id: string;
  generatedTitle: string;
  brand: string | null;
  ukSize: string | null;
  sku: string | null;
  status: ListingReviewStatus;
  coverPhotoId: string | null;
};

const STATUS_LABELS: Record<ListingReviewStatus, string> = {
  ready: "Ready",
  needs_review: "Needs review",
  edited: "Edited",
};

/**
 * Milestone 5 — the left-hand listings table. Deliberately memo()'d and
 * given only the already-filtered/searched row list (computed once by the
 * parent via useMemo) so a keystroke in the search box, or toggling a
 * quick filter, re-renders exactly this table once with its new row set —
 * never the persistent detail panel, never re-deriving status/warnings
 * per row on every keystroke (that's computed once per listing when the
 * underlying data actually changes, not per render of this table).
 */
function ListingsTable({ rows, selectedListingId, bulkSelectedIds, onSelectListing, onToggleBulkSelect, onToggleSelectAll }: {
  rows: ListingTableRow[];
  selectedListingId: string | null;
  bulkSelectedIds: Set<string>;
  onSelectListing: (id: string) => void;
  onToggleBulkSelect: (id: string) => void;
  onToggleSelectAll: () => void;
}) {
  const allSelected = rows.length > 0 && rows.every(row => bulkSelectedIds.has(row.id));

  return <div className="table-scroll listings-review-table-scroll">
    <table className="listings-review-table">
      <thead>
        <tr>
          <th><input type="checkbox" aria-label="Select all listings" checked={allSelected} onChange={onToggleSelectAll} /></th>
          <th>Cover photo</th>
          <th>Generated title</th>
          <th>Brand</th>
          <th>UK size</th>
          <th>SKU</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0
          ? <tr className="grid-empty-row"><td colSpan={7}><div><strong>No listings match.</strong><span>Try a different search or filter.</span></div></td></tr>
          : rows.map(row => <tr
              key={row.id}
              tabIndex={0}
              className={row.id === selectedListingId ? "listings-review-row listings-review-row-active" : "listings-review-row"}
              onClick={() => onSelectListing(row.id)}
              onKeyDown={event => { if (event.key === "Enter") onSelectListing(row.id); }}
            >
              <td className="listings-review-checkbox-cell" onClick={event => event.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${row.generatedTitle || "this listing"}`} checked={bulkSelectedIds.has(row.id)} onChange={() => onToggleBulkSelect(row.id)} />
              </td>
              <td>
                {row.coverPhotoId
                  // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img>
                  ? <img className="listings-review-cover-thumb" src={`/api/listing-studio/images/${row.coverPhotoId}/view`} alt="" />
                  : <div className="listings-review-cover-thumb listings-review-cover-thumb-empty" aria-hidden="true" />}
              </td>
              <td className="listings-review-title-cell">{row.generatedTitle || "Untitled listing"}</td>
              <td>{row.brand || "—"}</td>
              <td>{row.ukSize || "—"}</td>
              <td>{row.sku || "—"}</td>
              <td><span className={`listings-review-status-badge listings-review-status-${row.status}`}>{STATUS_LABELS[row.status]}</span></td>
            </tr>)}
      </tbody>
    </table>
  </div>;
}

export default memo(ListingsTable);
