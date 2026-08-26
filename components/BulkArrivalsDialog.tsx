"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseSkuLines } from "@/lib/purchases";

type BulkArrivalsResponse = {
  enteredCount: number;
  matchedPurchaseCount: number;
  updatedPurchaseCount: number;
  alreadyArrivedCount: number;
  notFoundSkus: string[];
  duplicateMatches: { sku: string; purchaseCount: number }[];
  updatedIds: string[];
};

type Step = "compose" | "confirm" | "result";

const PLACEHOLDER = "TA-1042\nTA-1045\nTA-1088\nTA-1091";

/**
 * Paste-a-SKU-list, preview-then-confirm bulk arrivals flow. Reuses the
 * app's existing modal shell (.dialog-backdrop/.import-dialog) and form
 * primitives (.field/.label/.input) rather than inventing new modal chrome.
 * Never touches the per-row arrival toggle (components/ArrivalToggle.tsx) —
 * this is a separate, additive path to the same `arrived` column.
 */
export default function BulkArrivalsDialog({ onClose, onApplied }: {
  onClose: () => void;
  onApplied: (updatedIds: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>("compose");
  const [preview, setPreview] = useState<BulkArrivalsResponse | null>(null);
  const [result, setResult] = useState<BulkArrivalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const submitting = useRef(false);

  const uniqueSkus = useMemo(() => parseSkuLines(text), [text]);

  // Escape only closes while nothing is in flight, so an active
  // preview/update request is never abandoned mid-air by an accidental key
  // press — mirrors the "Escape closes only when not processing" rule used
  // for the loading-aware backdrop click below.
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !loading) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, loading]);

  async function runPreview() {
    if (submitting.current || loading || !uniqueSkus.length) return;
    submitting.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/purchases/bulk-arrivals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", skus: uniqueSkus }),
      });
      const data = await response.json();
      if (!response.ok) { setError(data.error || "Could not preview these SKUs."); return; }
      setPreview(data);
      setStep("confirm");
    } catch { setError("Could not preview these SKUs. Please check your connection and try again."); }
    finally { setLoading(false); submitting.current = false; }
  }

  async function confirmUpdate() {
    if (submitting.current || loading) return;
    submitting.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/purchases/bulk-arrivals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The server recomputes matches fresh — this exact SKU list is sent
        // again rather than trusting the earlier preview response.
        body: JSON.stringify({ action: "update", skus: uniqueSkus }),
      });
      const data = await response.json();
      if (!response.ok) { setError(data.error || "Could not mark these purchases as arrived."); return; }
      setResult(data);
      setStep("result");
      onApplied(data.updatedIds ?? []);
    } catch { setError("Could not mark these purchases as arrived. Please check your connection and try again — retrying is safe."); }
    finally { setLoading(false); submitting.current = false; }
  }

  async function copyNotFound() {
    if (!result?.notFoundSkus.length && !preview?.notFoundSkus.length) return;
    const list = (step === "result" ? result : preview)?.notFoundSkus ?? [];
    try {
      await navigator.clipboard.writeText(list.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable — the list is still visible to copy manually */ }
  }

  function handleTextareaKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter always inserts a newline (default textarea behaviour) — only
    // the explicit Cmd/Ctrl+Enter shortcut triggers the preview step.
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && step === "compose") {
      event.preventDefault();
      runPreview();
    }
  }

  const summary = step === "result" ? result : preview;

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <div className="import-dialog bulk-arrivals-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-arrivals-title">
      <div className="import-dialog-heading">
        <div><h2 id="bulk-arrivals-title">Bulk mark arrivals</h2><p>Enter one SKU per line. Matching purchases will be marked as arrived.</p></div>
        <button type="button" className="dialog-close" onClick={onClose} disabled={loading} aria-label="Close">×</button>
      </div>

      {step === "compose" && <>
        <div className="field">
          <label className="label" htmlFor="bulk-arrivals-skus">SKUs</label>
          <textarea
            id="bulk-arrivals-skus"
            className="input"
            autoFocus
            value={text}
            onChange={event => setText(event.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder={PLACEHOLDER}
            aria-describedby="bulk-arrivals-count"
            spellCheck={false}
          />
          <span id="bulk-arrivals-count" className="bulk-arrivals-count" aria-live="polite">{uniqueSkus.length} SKU{uniqueSkus.length === 1 ? "" : "s"} entered</span>
        </div>
        {error && <p className="import-select-error" role="alert">{error}</p>}
        <div className="import-dialog-actions">
          <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
          <button type="button" className="button" disabled={!uniqueSkus.length || loading} onClick={runPreview}>{loading ? "Checking…" : "Mark as arrived"}</button>
        </div>
      </>}

      {step === "confirm" && summary && <>
        <div className="bulk-arrivals-summary">
          <div className="bulk-arrivals-stat"><strong>{summary.enteredCount}</strong><span>unique SKU{summary.enteredCount === 1 ? "" : "s"} entered</span></div>
          <div className="bulk-arrivals-stat"><strong>{summary.matchedPurchaseCount}</strong><span>matching purchase{summary.matchedPurchaseCount === 1 ? "" : "s"} found</span></div>
          <div className="bulk-arrivals-stat"><strong>{summary.alreadyArrivedCount}</strong><span>already arrived</span></div>
          <div className="bulk-arrivals-stat bulk-arrivals-stat-highlight"><strong>{summary.updatedPurchaseCount}</strong><span>will be marked as arrived</span></div>
          {summary.notFoundSkus.length > 0 && <div className="bulk-arrivals-stat bulk-arrivals-stat-warn"><strong>{summary.notFoundSkus.length}</strong><span>SKU{summary.notFoundSkus.length === 1 ? "" : "s"} not found</span></div>}
        </div>

        {summary.duplicateMatches.length > 0 && <p className="import-note">{summary.duplicateMatches.length} SKU{summary.duplicateMatches.length === 1 ? "" : "s"} matched more than one purchase record (e.g. from a multi-quantity order) — every matching record will be updated: {summary.duplicateMatches.map(d => `${d.sku} (${d.purchaseCount})`).join(", ")}.</p>}

        {summary.notFoundSkus.length > 0 && <div className="bulk-arrivals-not-found">
          <div className="bulk-arrivals-not-found-header"><strong>SKUs not found</strong><button type="button" className="button-secondary" onClick={copyNotFound}>{copied ? "Copied" : "Copy list"}</button></div>
          <ul className="bulk-arrivals-not-found-list" aria-label="SKUs not found">{summary.notFoundSkus.map(sku => <li key={sku}>{sku}</li>)}</ul>
        </div>}

        {error && <p className="import-select-error" role="alert">{error}</p>}
        <div className="import-dialog-actions">
          <button type="button" className="button-secondary" onClick={() => setStep("compose")} disabled={loading}>Back</button>
          <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
          <button type="button" className="button" disabled={loading || summary.updatedPurchaseCount === 0} onClick={confirmUpdate}>{loading ? "Marking as arrived…" : `Confirm and mark ${summary.updatedPurchaseCount} as arrived`}</button>
        </div>
      </>}

      {step === "result" && result && <div className="import-success">
        <span aria-hidden="true">✓</span>
        <h3>{result.updatedPurchaseCount} purchase{result.updatedPurchaseCount === 1 ? "" : "s"} marked as arrived</h3>
        <p role="status">
          {result.alreadyArrivedCount > 0 && `${result.alreadyArrivedCount} ${result.alreadyArrivedCount === 1 ? "was" : "were"} already marked as arrived. `}
          {result.notFoundSkus.length > 0 && `${result.notFoundSkus.length} SKU${result.notFoundSkus.length === 1 ? "" : "s"} were not found.`}
        </p>
        {result.notFoundSkus.length > 0 && <div className="bulk-arrivals-not-found">
          <div className="bulk-arrivals-not-found-header"><strong>SKUs not found</strong><button type="button" className="button-secondary" onClick={copyNotFound}>{copied ? "Copied" : "Copy list"}</button></div>
          <ul className="bulk-arrivals-not-found-list" aria-label="SKUs not found">{result.notFoundSkus.map(sku => <li key={sku}>{sku}</li>)}</ul>
        </div>}
        <div className="import-dialog-actions"><button type="button" className="button" onClick={onClose}>Done</button></div>
      </div>}
    </div>
  </div>;
}
