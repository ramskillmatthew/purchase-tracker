"use client";

import { useEffect, useRef, useState } from "react";

export type VintedCategoryPickerValue = { id: number | null; path: string | null };

type SearchResult = { id: number; label: string; fullPath: string };

/**
 * Milestone 7 (Vinted category catalogue sync) — the ONE way a listing's
 * category is ever manually set. Deliberately not a free-text field or a
 * dropdown of the whole catalogue: typing searches
 * app/api/listing-studio/vinted-categories/search/route.ts (active +
 * selectable categories only, bounded results), and only a real Vinted
 * category id + its current full path can ever be chosen — there is no
 * way to submit anything else. Selecting one sets `source: 'manual'` in
 * the parent's save call; this component itself never talks to the
 * `/fields` route directly.
 */
export default function VintedCategoryPicker({ value, disabled, onChange }: {
  value: VintedCategoryPickerValue;
  disabled?: boolean;
  onChange: (next: VintedCategoryPickerValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setResults([]); setSearchError(""); return; }
    setSearching(true);
    setSearchError("");
    const timeout = setTimeout(() => {
      fetch(`/api/listing-studio/vinted-categories/search?query=${encodeURIComponent(term)}`)
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) { setResults([]); setSearchError(body.error || "Could not search categories."); return; }
          setResults(body.results ?? []);
        })
        .catch(() => { setResults([]); setSearchError("Network error — could not search categories."); })
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [query]);

  function choose(result: SearchResult) {
    onChange({ id: result.id, path: result.fullPath });
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  function clear() {
    onChange({ id: null, path: null });
    setQuery("");
    setResults([]);
  }

  return <div className="vinted-category-picker" ref={containerRef}>
    {value.id !== null
      ? <div className="vinted-category-picker-chosen">
          <span className="vinted-category-picker-path">{value.path || `Category #${value.id}`}</span>
          <button type="button" className="button-secondary" disabled={disabled} onClick={clear}>Clear</button>
        </div>
      : <>
          <input
            className="input"
            type="text"
            value={query}
            placeholder="Search Vinted categories…"
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          />
          {open && query.trim().length >= 2 && <div className="vinted-category-picker-dropdown" role="listbox">
            {searching && <div className="vinted-category-picker-status">Searching…</div>}
            {!searching && searchError && <div className="vinted-category-picker-status">{searchError}</div>}
            {!searching && !searchError && results.length === 0 && <div className="vinted-category-picker-status">No matching categories.</div>}
            {!searching && results.map((result) => (
              <button key={result.id} type="button" className="vinted-category-picker-option" role="option" aria-selected={false} onClick={() => choose(result)}>
                {result.fullPath}
              </button>
            ))}
          </div>}
          {open && query.trim().length > 0 && query.trim().length < 2 && <div className="vinted-category-picker-dropdown"><div className="vinted-category-picker-status">Type at least 2 characters to search.</div></div>}
        </>}
  </div>;
}
