"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MAX_EBAY_IMPORT_URLS, validateAndDedupeEbayUrls, type EbayImportStatus } from "@/lib/listing-studio/ebay-import";

type ImportItem = { id: string; batch_id: string; source_url: string; ebay_item_id: string; status: EbayImportStatus; title: string | null; photo_count: number; draft_id: string | null; safe_error: string | null; attempt_count: number };
type ImportBatch = { id: string; status: string; total_count: number; created_at?: string; items: ImportItem[] };

const STATUS_LABELS: Record<EbayImportStatus, string> = {
  waiting: "Waiting for extension", extracting: "Reading in extension", downloading_photos: "Saving photos",
  processing: "Adding to Listing Studio", imported: "Imported", failed: "Failed",
};

export default function ImportEbayListingsDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => Promise<unknown> }) {
  const [rawUrls, setRawUrls] = useState("");
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [clearing, setClearing] = useState<"waiting" | "history" | null>(null);
  const [error, setError] = useState("");
  const lines = useMemo(() => rawUrls.split(/\r?\n/).map(value => value.trim()).filter(Boolean), [rawUrls]);
  const validation = useMemo(() => validateAndDedupeEbayUrls(lines), [lines]);
  const queueItems = useMemo(() => batches.flatMap(batch => batch.items), [batches]);

  const loadImports = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/listing-studio/ebay-imports", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load imports.");
      setBatches(body.batches ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load imports."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) loadImports(); }, [open, loadImports]);
  useEffect(() => {
    if (!open || !batches.some(batch => batch.items.some(item => !["imported", "failed"].includes(item.status)))) return;
    const timer = setInterval(loadImports, 1200);
    return () => clearInterval(timer);
  }, [open, batches, loadImports]);

  async function createImport() {
    if (!validation.urls.length || validation.errors.length) return;
    setCreating(true); setError("");
    try {
      const response = await fetch("/api/listing-studio/ebay-imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: validation.urls }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not start the import.");
      const batch = body.batch as ImportBatch;
      setBatches(current => [batch, ...current]); setRawUrls("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start the import."); }
    finally { setCreating(false); }
  }

  async function clearWaiting() {
    if (!queueItems.some(item => item.status === "waiting")) return;
    setClearing("waiting"); setError("");
    try {
      const response = await fetch("/api/listing-studio/ebay-imports?scope=waiting", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not clear waiting imports.");
      await loadImports();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not clear waiting imports."); }
    finally { setClearing(null); }
  }

  async function clearHistory() {
    if (!queueItems.some(item => item.status === "imported" || item.status === "failed")) return;
    setClearing("history"); setError("");
    try {
      const response = await fetch("/api/listing-studio/ebay-imports?scope=history", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not clear completed and failed imports.");
      await loadImports();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not clear completed and failed imports."); }
    finally { setClearing(null); }
  }

  if (!open) return null;
  const completed = queueItems.filter(item => item.status === "imported").length;
  const failed = queueItems.filter(item => item.status === "failed").length;
  const waiting = queueItems.filter(item => item.status === "waiting").length;
  const busy = creating || Boolean(clearing) || queueItems.some(item => ["extracting", "downloading_photos", "processing"].includes(item.status));

  return <div className="ebay-import-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="ebay-import-dialog" role="dialog" aria-modal="true" aria-labelledby="ebay-import-title">
      <header><div><span className="ebay-import-eyebrow">LISTING STUDIO · EBAY UK</span><h2 id="ebay-import-title">Import listings</h2><p>Paste one eBay item URL per line. Each item will become a separate editable listing.</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button></header>
      <div className="ebay-import-body">
        <div className="ebay-import-entry">
          <label htmlFor="ebay-import-urls">eBay listing URLs</label>
          <textarea id="ebay-import-urls" value={rawUrls} onChange={event => setRawUrls(event.target.value)} rows={7} placeholder={"https://www.ebay.co.uk/itm/123456789012\nhttps://www.ebay.co.uk/itm/987654321098"} disabled={creating} />
          <div className="ebay-import-validation"><span>{validation.urls.length} valid link{validation.urls.length === 1 ? "" : "s"} · maximum {MAX_EBAY_IMPORT_URLS}</span>{validation.errors.length > 0 && <strong>{validation.errors.length} invalid</strong>}</div>
          {validation.errors.slice(0, 3).map((issue, index) => <p className="ebay-import-inline-error" key={`${issue.input}-${index}`}>{issue.input}: {issue.error}</p>)}
          <button className="button primary ebay-import-submit" type="button" onClick={createImport} disabled={creating || !validation.urls.length || validation.errors.length > 0}>{creating ? "Importing listings…" : `Import ${validation.urls.length || ""} listing${validation.urls.length === 1 ? "" : "s"}`}</button>
        </div>

        {(loading || queueItems.length > 0) && <div className="ebay-import-progress">
          <div className="ebay-import-progress-head"><div><strong>Import queue</strong><span>{completed} imported{waiting ? ` · ${waiting} waiting` : ""}{failed ? ` · ${failed} failed` : ""}</span></div><div className="ebay-import-progress-actions"><button type="button" className="button-secondary" onClick={clearWaiting} disabled={!waiting || Boolean(clearing)}>{clearing === "waiting" ? "Clearing…" : "Clear waiting"}</button><button type="button" className="button-secondary" onClick={clearHistory} disabled={(!completed && !failed) || Boolean(clearing)}>{clearing === "history" ? "Clearing…" : "Clear completed & failed"}</button><button type="button" className="button-secondary" onClick={loadImports}>Refresh</button></div></div>
          {loading && !queueItems.length ? <p className="ebay-import-loading">Loading imports…</p> : <div className="ebay-import-items">{queueItems.map(item => <article key={item.id} className={`ebay-import-item ebay-import-item-${item.status}`}>
            <span className="ebay-import-item-icon" aria-hidden="true">{item.status === "imported" ? "✓" : item.status === "failed" ? "!" : item.status === "waiting" ? "·" : "↻"}</span>
            <div><strong>{item.title || `eBay item ${item.ebay_item_id}`}</strong><small>{STATUS_LABELS[item.status]}{item.photo_count ? ` · ${item.photo_count} photos` : ""}</small>{item.safe_error && <p>{item.safe_error}</p>}</div>
          </article>)}</div>}
        </div>}
        {error && <div className="ebay-import-error" role="alert">{error}</div>}
      </div>
      <footer><span>Open Listing Assistant and press Start importing. Completed listings and photos are saved permanently.</span><button type="button" className="button-secondary" onClick={async () => { if (completed) await onImported(); onClose(); }} disabled={busy}>Done</button></footer>
    </section>
  </div>;
}
