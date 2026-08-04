"use client";

import { memo } from "react";
import type { ListingQuickFilter, ListingReviewStatusFilter } from "@/lib/listing-studio/listing-review";

const STATUS_TABS: { value: ListingReviewStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "needs_review", label: "Needs review" },
  { value: "edited", label: "Edited" },
];

const QUICK_FILTERS: { value: ListingQuickFilter; label: string }[] = [
  { value: "missing_sku", label: "Missing SKU" },
  { value: "missing_size", label: "Missing size" },
  { value: "missing_brand", label: "Missing brand" },
  { value: "missing_colour", label: "Missing colour" },
  { value: "missing_category", label: "Missing category" },
  { value: "missing_price", label: "Missing price" },
];

/**
 * Milestone 5 — search + status tabs + quick filter chips. Quick filters
 * are independent toggles that AND together (checking more than one narrows
 * further, e.g. "Missing SKU" + "Missing Brand" shows only listings
 * missing both) rather than OR — the more literal reading of "filter".
 */
function ListingsFilterBar({ searchQuery, onSearchQueryChange, statusFilter, onStatusFilterChange, activeQuickFilters, onToggleQuickFilter }: {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  statusFilter: ListingReviewStatusFilter;
  onStatusFilterChange: (value: ListingReviewStatusFilter) => void;
  activeQuickFilters: Set<ListingQuickFilter>;
  onToggleQuickFilter: (value: ListingQuickFilter) => void;
}) {
  return <div className="listings-review-filter-bar">
    <label className="listings-review-search field">
      <span className="label">Search</span>
      <input
        className="input"
        type="search"
        placeholder="Search by title, SKU, brand, model, or colour"
        value={searchQuery}
        onChange={event => onSearchQueryChange(event.target.value)}
        aria-label="Search listings"
      />
    </label>

    <div className="period-switch listings-review-status-tabs" role="group" aria-label="Filter by status">
      {STATUS_TABS.map(tab => <button
        key={tab.value}
        type="button"
        className={statusFilter === tab.value ? "period-active" : ""}
        onClick={() => onStatusFilterChange(tab.value)}
      >
        {tab.label}
      </button>)}
    </div>

    <div className="listings-review-quick-filters" role="group" aria-label="Quick filters">
      {QUICK_FILTERS.map(filter => <button
        key={filter.value}
        type="button"
        className={activeQuickFilters.has(filter.value) ? "listings-review-quick-filter listings-review-quick-filter-active" : "listings-review-quick-filter"}
        aria-pressed={activeQuickFilters.has(filter.value)}
        onClick={() => onToggleQuickFilter(filter.value)}
      >
        {filter.label}
      </button>)}
    </div>
  </div>;
}

export default memo(ListingsFilterBar);
