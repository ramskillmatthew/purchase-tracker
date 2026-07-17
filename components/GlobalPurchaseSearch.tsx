"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Purchase } from "@/lib/types";

type SearchablePurchase = Purchase & { searchText: string };

export default function GlobalPurchaseSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    fetch("/api/purchases")
      .then(response => response.ok ? response.json() : [])
      .then(setPurchases)
      .catch(() => setPurchases([]));
  }, [pathname]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!searchRef.current?.contains(event.target as Node)) setFocused(false);
    }
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setQuery("");
        inputRef.current?.blur();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleShortcut);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleShortcut);
    };
  }, []);

  const searchIndex = useMemo<SearchablePurchase[]>(() => purchases.map(purchase => ({
    ...purchase,
    searchText: `${purchase.item_description ?? ""}\u0000${purchase.sku ?? ""}\u0000${purchase.seller_name ?? ""}`.toLocaleLowerCase(),
  })), [purchases]);

  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return [];
    return searchIndex.filter(purchase => purchase.searchText.includes(term)).slice(0, 8);
  }, [query, searchIndex]);

  function openPurchase(id: string) {
    setQuery("");
    setFocused(false);
    router.push(`/purchases/${id}`);
  }

  return <div className="global-search-shell">
    <div className="global-search-inner" ref={searchRef}>
      <div className={`app-global-search ${focused ? "app-global-search-focused" : ""}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4.5 4.5" /></svg>
        <input ref={inputRef} type="search" value={query} onFocus={() => setFocused(true)} onChange={event => { setQuery(event.target.value); setFocused(true); }} onKeyDown={event => { if (event.key === "Enter" && results[0]) openPurchase(results[0].id); }} placeholder="Search title, SKU or seller..." aria-label="Search purchases by title, SKU or seller name" autoComplete="off" />
        {query ? <button type="button" onClick={() => { setQuery(""); inputRef.current?.focus(); }} aria-label="Clear search">×</button> : <kbd>Ctrl K</kbd>}
      </div>
      {focused && query.trim() && <div className="global-search-results" role="listbox">
        {results.length ? results.map((purchase, index) => <button key={purchase.id} type="button" onClick={() => openPurchase(purchase.id)} className="global-search-result" role="option" aria-selected={index === 0}>
          <span className="global-result-icon">{purchase.item_description?.slice(0, 1).toUpperCase() || "P"}</span>
          <span className="global-result-copy"><strong>{purchase.item_description}</strong><small>{purchase.seller_name || "No seller"} · SKU {purchase.sku || "—"}</small></span>
          {index === 0 && <span className="global-result-enter">Enter ↵</span>}
        </button>) : <div className="global-search-no-results"><strong>No matching purchases</strong><span>Search by item title, SKU or seller name.</span></div>}
      </div>}
    </div>
  </div>;
}
