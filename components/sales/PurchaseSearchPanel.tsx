"use client";
import { useEffect, useRef, useState } from "react";
import type { Purchase } from "@/lib/types";
import { formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import styles from "@/app/sales/sales.module.css";

/**
 * Shared product-search panel — used identically by both Quick Sale and
 * Order Sale (see app/sales/new/page.tsx). Searches only currently
 * sellable purchases (server-side — see /api/sales/available-purchases),
 * never the whole purchases table client-side. Debounced, keyboard-
 * navigable (Up/Down to highlight, Enter to add the highlighted result,
 * Escape to clear), and never shows or exposes the hidden purchase UUID.
 */
export default function PurchaseSearchPanel({ onAdd, onAddAll, selectedIds, autoFocus = true }: {
  onAdd: (purchase: Purchase) => void;
  onAddAll: (purchases: Purchase[]) => void;
  selectedIds: Set<string>;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Purchase[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  useEffect(() => {
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/sales/available-purchases?q=${encodeURIComponent(query.trim())}&limit=25`);
        if (id !== requestId.current) return;
        if (!response.ok) { setError("Could not search purchases."); setResults([]); return; }
        const body = await response.json() as { results: Purchase[]; total: number };
        setResults(body.results);
        setTotal(body.total);
        setHighlighted(0);
      } catch {
        if (id === requestId.current) { setError("Could not search purchases."); setResults([]); }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const addableResults = results.filter(purchase => !selectedIds.has(purchase.id));

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { setQuery(""); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlighted(current => Math.min(current + 1, addableResults.length - 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setHighlighted(current => Math.max(current - 1, 0)); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = addableResults[highlighted];
      if (target) onAdd(target);
    }
  }

  return <div className={styles.searchPanel}>
    <div className={styles.searchInputRow}>
      <input
        ref={inputRef}
        type="search"
        className="input"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search by description, SKU, or seller…"
        aria-label="Search available purchases"
        autoComplete="off"
      />
      {addableResults.length > 0 && <button type="button" className="button-secondary" onClick={() => onAddAll(addableResults)}>Add all available</button>}
    </div>
    {error && <p className={styles.resultHint} role="alert">{error}</p>}
    {!error && !loading && query.trim() && <p className={styles.resultHint} role="status">
      {total === 0 ? "No available purchases match that search." : `${total.toLocaleString("en-GB")} matching unit${total === 1 ? "" : "s"} available${total > results.length ? ` — showing the first ${results.length}` : ""}`}
    </p>}
    <div className={styles.resultList} role="listbox" aria-label="Search results">
      {results.map((purchase, index) => {
        const alreadyAdded = selectedIds.has(purchase.id);
        const addableIndex = addableResults.indexOf(purchase);
        return <div
          key={purchase.id}
          role="option"
          aria-selected={!alreadyAdded && addableIndex === highlighted}
          className={[styles.resultRow, !alreadyAdded && addableIndex === highlighted ? styles.resultRowHighlighted : "", alreadyAdded ? styles.resultRowAdded : ""].join(" ").trim()}
          onClick={() => { if (!alreadyAdded) onAdd(purchase); }}
        >
          <div className={styles.resultInfo}>
            <span className={styles.resultTitle}>{purchase.item_description}</span>
            <span className={styles.resultMeta}>
              <span>SKU {purchase.sku || "—"}</span>
              <span>{purchase.purchased_from}</span>
              <span>{purchase.order_date}</span>
              <span>{purchase.item_condition}</span>
              <span>{purchase.category}</span>
            </span>
          </div>
          <span className={styles.resultCost}>{formatPenceAsGBP(poundsToPence(Number(purchase.price_purchased)))}</span>
          <button type="button" className={styles.resultAddButton} disabled={alreadyAdded} onClick={event => { event.stopPropagation(); if (!alreadyAdded) onAdd(purchase); }}>
            {alreadyAdded ? "Added" : "Add"}
          </button>
        </div>;
      })}
      {!loading && !error && query.trim() && results.length === 0 && <p className={styles.resultHint}>Try a different search term.</p>}
    </div>
  </div>;
}
