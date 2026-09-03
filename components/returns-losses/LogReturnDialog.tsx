"use client";

import { useEffect, useMemo, useState } from "react";
import type { SaleSearchResponse, SaleMatchResult } from "@/lib/returns/api-contract";
import { money, displayDate } from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

const STEPS = ["Match sale", "Select units", "Return details", "Review"] as const;

export default function LogReturnDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<SaleSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [sale, setSale] = useState<SaleMatchResult | null>(null);
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [startedOn, setStartedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [precision, setPrecision] = useState<"exact" | "month">("exact");
  const [notes, setNotes] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPage(1), [debounced]);

  useEffect(() => {
    if (step !== 0) return;
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);
    const qs = new URLSearchParams({ page: String(page), pageSize: "10" });
    if (debounced) qs.set("q", debounced);
    fetch(`/api/returns/sale-search?${qs.toString()}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || "Could not search sales.");
        setResults(body as SaleSearchResponse);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") setSearchError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [step, debounced, page]);

  const selectedUnits = useMemo(
    () => (sale ? sale.items.filter((i) => unitIds.includes(i.saleItemId)) : []),
    [sale, unitIds],
  );
  const estRevenue = selectedUnits.reduce((s, u) => s + u.revenuePence, 0);
  const estProfit = selectedUnits.reduce((s, u) => s + u.profitPence, 0);

  function pickSale(s: SaleMatchResult) {
    setSale(s);
    setUnitIds(s.items.length === 1 ? [s.items[0].saleItemId] : []);
    setStep(1);
  }
  function toggleUnit(id: string) {
    setUnitIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function submit() {
    if (!sale) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesOrderId: sale.salesOrderId,
          quantity: unitIds.length,
          startedOn,
          startedPrecision: precision,
          notes: notes.trim() || undefined,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body?.error || "Could not log this return.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not log this return.");
      setSaving(false);
    }
  }

  const canNext =
    (step === 0 && !!sale) ||
    (step === 1 && unitIds.length > 0) ||
    (step === 2 && !!startedOn) ||
    step === 3;

  return (
    <Modal
      title="Log a return"
      onClose={onClose}
      wide
      busy={saving}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <span className={styles.footerButtons}>
            {step > 0 ? (
              <button type="button" className="button-secondary" onClick={() => setStep((s) => s - 1)} disabled={saving}>
                Back
              </button>
            ) : null}
            {step < STEPS.length - 1 ? (
              <button type="button" className="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                Next
              </button>
            ) : (
              <button type="button" className="button" disabled={saving || unitIds.length === 0} onClick={submit}>
                {saving ? "Logging…" : "Log return"}
              </button>
            )}
          </span>
        </>
      }
    >
      <div className={styles.steps}>
        {STEPS.map((label, i) => (
          <span key={label} className={`${styles.step} ${i === step ? styles.current : ""} ${i < step ? styles.done : ""}`}>
            <span className={styles.stepDot}>{i < step ? "✓" : i + 1}</span>
            {label}
            {i < STEPS.length - 1 ? <span className={styles.stepLine} /> : null}
          </span>
        ))}
      </div>

      {step === 0 ? (
        <>
          <label className="field">
            <span className="label">Find the sale</span>
            <input
              className="input"
              type="search"
              placeholder="SKU, item description, platform or sale id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {searchError ? <p className="task-modal-error">{searchError}</p> : null}
          <div className={styles.searchResults}>
            {searching && !results ? <p className={styles.footerNote} style={{ padding: 12 }}>Searching…</p> : null}
            {results && results.results.length === 0 ? (
              <p className={styles.footerNote} style={{ padding: 12 }}>No eligible completed sales found.</p>
            ) : null}
            {results?.results.map((r) => (
              <button
                type="button"
                key={r.salesOrderId}
                className={`${styles.resultRow} ${sale?.salesOrderId === r.salesOrderId ? styles.selected : ""}`}
                onClick={() => pickSale(r)}
              >
                <span aria-hidden>→</span>
                <span className="title">
                  {r.items[0]?.title ?? "Sale"} <span className={styles.sku}>· {r.platform}</span>
                </span>
                <span className="meta">{displayDate(r.saleDate)}</span>
                <span className="meta">{r.eligibleReturnQuantity} eligible</span>
                <span className="meta">{money(r.revenuePence)}</span>
              </button>
            ))}
          </div>
          {results && results.totalPages > 1 ? (
            <div className={styles.footerNote}>
              <button
                type="button"
                className={styles.reset}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ‹ Prev
              </button>
              Page {results.page} / {results.totalPages}
              <button
                type="button"
                className={styles.reset}
                disabled={page >= results.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next ›
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {step === 1 && sale ? (
        <>
          <div className={styles.selectedPanel}>
            <dl>
              <dt>Sale</dt>
              <dd>
                {displayDate(sale.saleDate)} · {sale.platform} · {money(sale.revenuePence)}
              </dd>
              <dt>Choose the exact units being returned</dt>
              <dd>{unitIds.length} selected</dd>
            </dl>
          </div>
          <div className={styles.unitList}>
            {sale.items.map((it) => (
              <label key={it.saleItemId} className={styles.unitRow}>
                <input type="checkbox" checked={unitIds.includes(it.saleItemId)} onChange={() => toggleUnit(it.saleItemId)} />
                <span style={{ flex: 1 }}>
                  {it.title} <span className={styles.sku}>SKU {it.sku}</span>
                </span>
                <span>{money(it.revenuePence)}</span>
              </label>
            ))}
          </div>
          <p className={styles.footerNote}>
            The exact units are chosen now and stored on the return — never &ldquo;first N rows&rdquo; at completion time.
          </p>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <div className="task-modal-grid">
            <label className="field">
              <span className="label">Return started</span>
              <input className="input" type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Date precision</span>
              <select className="input" value={precision} onChange={(e) => setPrecision(e.target.value as "exact" | "month")}>
                <option value="exact">Exact day</option>
                <option value="month">Month only</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span className="label">Notes (optional)</span>
            <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <p className={styles.footerNote}>
            No money is reversed yet. Financial impact is calculated and recognised when you complete the return.
          </p>
        </>
      ) : null}

      {step === 3 && sale ? (
        <div className={styles.detailGrid}>
          <div className={styles.detailCard}>
            <h3>Return</h3>
            <div className={styles.detailRow}>
              <span>Sale</span>
              <strong>
                {displayDate(sale.saleDate)} · {sale.platform}
              </strong>
            </div>
            <div className={styles.detailRow}>
              <span>Units returning</span>
              <strong>{unitIds.length}</strong>
            </div>
            <div className={styles.detailRow}>
              <span>Started</span>
              <strong>{displayDate(startedOn, precision)}</strong>
            </div>
          </div>
          <div className={styles.detailCard}>
            <h3>For reference only</h3>
            <div className={styles.detailRow}>
              <span>Selected units&rsquo; revenue</span>
              <strong>{money(estRevenue)}</strong>
            </div>
            <div className={styles.detailRow}>
              <span>Selected units&rsquo; profit</span>
              <strong>{money(estProfit)}</strong>
            </div>
            <p className={styles.footerNote}>Authoritative reversal is computed at completion, not here.</p>
          </div>
        </div>
      ) : null}

      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
