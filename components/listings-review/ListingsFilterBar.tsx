"use client";

import { memo, useState, type CSSProperties } from "react";
import type { ListingQuickFilter } from "@/lib/listing-studio/listing-review";
import { WORKFLOW_STATUS_TONE, READINESS_TONE_READY, READINESS_TONE_NEEDS_REVIEW } from "@/lib/listing-studio/extension-workflow-status";

// The 4 top tabs, matching the approved reference exactly. "Sent" (in
// flight: sent/in queue/draft in progress), "Edited", and "Draft failed"
// are deliberately NOT top tabs (the reference shows exactly 4) but stay
// fully reachable — never hidden — via the Filters control instead.
export type TopTab = "all" | "ready" | "needs_review" | "drafted";

const TOP_TABS: { value: TopTab; label: string; tone?: string }[] = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready", tone: READINESS_TONE_READY },
  { value: "needs_review", label: "Need review", tone: READINESS_TONE_NEEDS_REVIEW },
  { value: "drafted", label: "Drafts", tone: WORKFLOW_STATUS_TONE.drafted },
];

const QUICK_FILTERS: { value: ListingQuickFilter; label: string }[] = [
  { value: "missing_sku", label: "Missing SKU" },
  { value: "missing_size", label: "Missing size" },
  { value: "missing_brand", label: "Missing brand" },
  { value: "missing_colour", label: "Missing colour" },
  { value: "missing_category", label: "Missing category" },
  { value: "missing_price", label: "Missing price" },
];

function FilterIcon() {
  return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M1 1.5h10L7.2 6v4l-2.4 1.2V6L1 1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>;
}

/**
 * Compact search + category filter + a "Filters" popover (the existing 6
 * missing-field quick filters, plus Sent/Edited/Draft-failed-only — kept
 * out of the top tab row per the reference's exact 4 tabs, but never
 * hidden) + the 4-tab row with real counts. Filtering itself stays
 * entirely client-side over already-loaded listings (computed by the
 * parent) — this component only ever reads/sets the parent's filter
 * state, never fetches anything itself.
 */
function ListingsFilterBar({
  searchQuery, onSearchQueryChange,
  topTab, onTopTabChange,
  totalCount, readyCount, needsReviewCount, draftsCount,
  categoryFilter, onCategoryFilterChange, categoryOptions,
  activeQuickFilters, onToggleQuickFilter,
  showEditedOnly, onToggleEditedOnly,
  showFailedOnly, onToggleFailedOnly,
  showSentOnly, onToggleSentOnly, sentCount, failedCount,
  filtersActive, onClearFilters,
}: {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  topTab: TopTab;
  onTopTabChange: (value: TopTab) => void;
  totalCount: number; readyCount: number; needsReviewCount: number; draftsCount: number;
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  categoryOptions: string[];
  activeQuickFilters: Set<ListingQuickFilter>;
  onToggleQuickFilter: (value: ListingQuickFilter) => void;
  showEditedOnly: boolean;
  onToggleEditedOnly: () => void;
  showFailedOnly: boolean;
  onToggleFailedOnly: () => void;
  showSentOnly: boolean;
  onToggleSentOnly: () => void;
  sentCount: number;
  failedCount: number;
  filtersActive: boolean;
  onClearFilters: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const tabCount: Record<TopTab, number> = { all: totalCount, ready: readyCount, needs_review: needsReviewCount, drafted: draftsCount };
  const extraFiltersActiveCount = activeQuickFilters.size + (showEditedOnly ? 1 : 0) + (showFailedOnly ? 1 : 0) + (showSentOnly ? 1 : 0);

  return <div className="lr-toolbar">
    <label className="field lr-search">
      <span className="label sr-only">Search</span>
      <input
        className="input"
        type="search"
        placeholder="Search titles or SKU…"
        value={searchQuery}
        onChange={event => onSearchQueryChange(event.target.value)}
        aria-label="Search listings"
      />
    </label>

    <label className="field lr-category-filter">
      <span className="label sr-only">Category</span>
      <select className="input" value={categoryFilter} onChange={event => onCategoryFilterChange(event.target.value)} aria-label="Filter by category">
        <option value="all">All categories</option>
        {categoryOptions.map(category => <option key={category} value={category}>{category}</option>)}
      </select>
    </label>

    <div className="lr-filters-control">
      <button type="button" className="button-secondary lr-filters-button" aria-haspopup="true" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(current => !current)}>
        <FilterIcon /> Filters{extraFiltersActiveCount > 0 && <span className="lr-filters-badge">{extraFiltersActiveCount}</span>}
      </button>
      {filtersOpen && <div className="lr-filters-popover" role="menu">
        <button type="button" role="menuitemcheckbox" aria-checked={showSentOnly} className={showSentOnly ? "lr-quick-filter lr-quick-filter-active" : "lr-quick-filter"} onClick={onToggleSentOnly}>
          Sent ({sentCount})
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked={showFailedOnly} className={showFailedOnly ? "lr-quick-filter lr-quick-filter-active" : "lr-quick-filter"} onClick={onToggleFailedOnly}>
          Draft failed ({failedCount})
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked={showEditedOnly} className={showEditedOnly ? "lr-quick-filter lr-quick-filter-active" : "lr-quick-filter"} onClick={onToggleEditedOnly}>
          Edited
        </button>
        {QUICK_FILTERS.map(filter => <button
          key={filter.value}
          type="button"
          role="menuitemcheckbox"
          aria-checked={activeQuickFilters.has(filter.value)}
          className={activeQuickFilters.has(filter.value) ? "lr-quick-filter lr-quick-filter-active" : "lr-quick-filter"}
          onClick={() => onToggleQuickFilter(filter.value)}
        >
          {filter.label}
        </button>)}
      </div>}
    </div>

    <div className="lr-tabs" role="tablist" aria-label="Filter by status">
      {TOP_TABS.map(tab => <button
        key={tab.value}
        type="button"
        role="tab"
        aria-selected={topTab === tab.value}
        className={topTab === tab.value ? "lr-tab lr-tab-active" : "lr-tab"}
        onClick={() => onTopTabChange(tab.value)}
      >
        {tab.tone && <i aria-hidden="true" className="lr-tab-dot" style={{ "--tone": tab.tone } as CSSProperties} />}
        {tab.label} <span className="lr-tab-count">{tabCount[tab.value]}</span>
      </button>)}
    </div>

    {filtersActive && <button type="button" className="lr-clear-filters" onClick={onClearFilters}>Clear filters</button>}
  </div>;
}

export default memo(ListingsFilterBar);
