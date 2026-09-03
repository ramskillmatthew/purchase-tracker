"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PurchaseSearchResponse,
  PurchaseMatchResult,
  SaleSearchResponse,
  SaleMatchResult,
  LossPreviewResponse,
} from "@/lib/returns/api-contract";
import { money, impactMoney, displayDate, LOSS_TYPE_LABELS } from "@/lib/returns/format";
import type { LossType } from "@/lib/returns/types";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

const STEPS = ["Type", "Match", "Details", "Review"] as const;
const LOSS_TYPE_HELP: Record<LossType, string> = {
  lost_inventory: "A purchased unit you can no longer locate or that was lost in transit.",
  unsellable_purchase: "A unit that arrived damaged / not as described and can never be sold.",
  refund_without_return: "You refunded a buyer on a completed sale and the item is not coming back.",
  other_write_off: "Any other write-off — optionally linked to a purchased unit.",
};

export default function LogLossDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState(0);
  const [lossType, setLossType] = useState<LossType>("lost_inventory");

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [purchaseResults, setPurchaseResults] = useState<PurchaseSearchResponse | null>(null);
  const [saleResults, setSaleResults] = useState<SaleSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [group, setGroup] = useState<PurchaseMatchResult | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [sale, setSale] = useState<SaleMatchResult | null>(null);
  const [saleUnitIds, setSaleUnitIds] = useState<string[]>([]);

  const [customerRefund, setCustomerRefund] = useState("");
  const [otherCosts, setOtherCosts] = useState("");
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [eventPrecision, setEventPrecision] = useState<"exact" | "month">("exact");
  const [stockAction, setStockAction] = useState<"remove_from_stock" | "keep_in_stock">("remove_from_stock");
  const [notes, setNotes] = useState("");

  const [preview, setPreview] = useState<LossPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One stable request key per dialog session. Every submit attempt (including
  // a retry after a network blip, or an accidental double-click) reuses it, so
  // the server records at most one loss for this dialog. A fresh dialog =
  // fresh key = a legitimately separate loss.
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const usesPurchase = lossType !== "refund_without_return";
  const purchaseRequired = lossType === "lost_inventory" || lossType === "unsellable_purchase";

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (step !== 1) return;
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);
    const path = usesPurchase ? "/api/losses/purchase-search" : "/api/returns/sale-search";
    const qs = new URLSearchParams({ pageSize: "10" });
    if (debounced) qs.set("q", debounced);
    fetch(`${path}?${qs.toString()}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || "Could not search.");
        if (usesPurchase) setPurchaseResults(body as PurchaseSearchResponse);
        else setSaleResults(body as SaleSearchResponse);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") setSearchError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [step, debounced, usesPurchase]);

  const purchaseIds = useMemo(
    () => (usesPurchase && group ? group.inStockUnitIds.slice(0, Math.max(1, quantity)) : []),
    [usesPurchase, group, quantity],
  );

  const body = useMemo(
    () => ({
      lossType,
      purchaseIds,
      saleItemIds: lossType === "refund_without_return" ? saleUnitIds : [],
      salesOrderId: lossType === "refund_without_return" ? sale?.salesOrderId : undefined,
      customerRefund: customerRefund ? Number(customerRefund) : 0,
      otherCosts: otherCosts ? Number(otherCosts) : 0,
      eventDate,
      eventPrecision,
      stockAction,
      notes: notes.trim() || undefined,
    }),
    [lossType, purchaseIds, saleUnitIds, sale, customerRefund, otherCosts, eventDate, eventPrecision, stockAction, notes],
  );

  useEffect(() => {
    if (step < 2) return;
    if (purchaseRequired && purchaseIds.length === 0) {
      setPreview(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      setPreviewError(null);
      fetch("/api/losses/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(json?.error || "Could not preview this loss.");
          setPreview(json as LossPreviewResponse);
        })
        .catch((e: unknown) => {
          if (e instanceof Error && e.name !== "AbortError") {
            setPreview(null);
            setPreviewError(e.message);
          }
        });
    }, 300);
    return () => {
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [step, body, purchaseRequired, purchaseIds.length]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/losses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, idempotencyKey: idempotencyKeyRef.current }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not record this loss.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not record this loss.");
      setSaving(false);
    }
  }

  const canNext =
    (step === 0) ||
    (step === 1 && (usesPurchase ? (purchaseRequired ? !!group : true) : !!sale && saleUnitIds.length > 0)) ||
    (step === 2 && !!eventDate) ||
    step === 3;

  return (
    <Modal
      title="Log loss / write-off"
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
              <button type="button" className="button" disabled={saving} onClick={submit}>
                {saving ? "Recording…" : "Record loss"}
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
        <div className={styles.outcomeChoices} style={{ gridTemplateColumns: "1fr 1fr" }}>
          {(Object.keys(LOSS_TYPE_LABELS) as LossType[]).map((t) => (
            <button
              type="button"
              key={t}
              className={`${styles.outcomeChoice} ${lossType === t ? styles.selected : ""}`}
              onClick={() => setLossType(t)}
            >
              <strong>{LOSS_TYPE_LABELS[t]}</strong>
              <span>{LOSS_TYPE_HELP[t]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {step === 1 ? (
        <>
          <label className="field">
            <span className="label">{usesPurchase ? "Match an in-stock purchase" : "Match the completed sale"}</span>
            <input
              className="input"
              type="search"
              placeholder={usesPurchase ? "SKU, description, supplier…" : "SKU, description, platform…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {searchError ? <p className="task-modal-error">{searchError}</p> : null}

          {usesPurchase ? (
            <>
              {purchaseResults ? <p className={styles.footerNote}>{purchaseResults.ownershipNote}</p> : null}
              <div className={styles.searchResults}>
                {searching && !purchaseResults ? (
                  <p className={styles.footerNote} style={{ padding: 12 }}>Searching…</p>
                ) : null}
                {purchaseResults && purchaseResults.results.length === 0 ? (
                  <p className={styles.footerNote} style={{ padding: 12 }}>No eligible in-stock units found.</p>
                ) : null}
                {purchaseResults?.results.map((g) => (
                  <button
                    type="button"
                    key={g.groupKey}
                    className={`${styles.resultRow} ${group?.groupKey === g.groupKey ? styles.selected : ""}`}
                    onClick={() => {
                      setGroup(g);
                      setQuantity(1);
                    }}
                  >
                    <span aria-hidden>→</span>
                    <span className="title">
                      {g.itemTitle} <span className={styles.sku}>SKU {g.sku}</span>
                    </span>
                    <span className="meta">{g.supplier ?? "—"}</span>
                    <span className="meta">{g.eligibleQuantity} in stock</span>
                    <span className="meta">{money(g.unitCostPence)}/unit</span>
                  </button>
                ))}
              </div>
              {group ? (
                <label className="field">
                  <span className="label">Quantity to write off</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={group.eligibleQuantity}
                    value={quantity}
                    onChange={(e) => setQuantity(Math.min(group.eligibleQuantity, Math.max(1, Number(e.target.value) || 1)))}
                  />
                </label>
              ) : null}
              {lossType === "other_write_off" ? (
                <p className={styles.footerNote}>A purchase match is optional for an other write-off — skip to continue without one.</p>
              ) : null}
            </>
          ) : (
            <>
              <div className={styles.searchResults}>
                {searching && !saleResults ? (
                  <p className={styles.footerNote} style={{ padding: 12 }}>Searching…</p>
                ) : null}
                {saleResults && saleResults.results.length === 0 ? (
                  <p className={styles.footerNote} style={{ padding: 12 }}>No eligible completed sales found.</p>
                ) : null}
                {saleResults?.results.map((r) => (
                  <button
                    type="button"
                    key={r.salesOrderId}
                    className={`${styles.resultRow} ${sale?.salesOrderId === r.salesOrderId ? styles.selected : ""}`}
                    onClick={() => {
                      setSale(r);
                      setSaleUnitIds(r.items.length === 1 ? [r.items[0].saleItemId] : []);
                    }}
                  >
                    <span aria-hidden>→</span>
                    <span className="title">
                      {r.items[0]?.title ?? "Sale"} <span className={styles.sku}>· {r.platform}</span>
                    </span>
                    <span className="meta">{displayDate(r.saleDate)}</span>
                    <span className="meta">{r.eligibleReturnQuantity} units</span>
                    <span className="meta">{money(r.revenuePence)}</span>
                  </button>
                ))}
              </div>
              {sale ? (
                <div className={styles.unitList}>
                  {sale.items.map((it) => (
                    <label key={it.saleItemId} className={styles.unitRow}>
                      <input
                        type="checkbox"
                        checked={saleUnitIds.includes(it.saleItemId)}
                        onChange={() =>
                          setSaleUnitIds((cur) =>
                            cur.includes(it.saleItemId) ? cur.filter((x) => x !== it.saleItemId) : [...cur, it.saleItemId],
                          )
                        }
                      />
                      <span style={{ flex: 1 }}>
                        {it.title} <span className={styles.sku}>SKU {it.sku}</span>
                      </span>
                      <span>{money(it.revenuePence)}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {step === 2 ? (
        <>
          <div className="task-modal-grid">
            <label className="field">
              <span className="label">Event date</span>
              <input className="input" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Date precision</span>
              <select
                className="input"
                value={eventPrecision}
                onChange={(e) => setEventPrecision(e.target.value as "exact" | "month")}
              >
                <option value="exact">Exact day</option>
                <option value="month">Month only</option>
              </select>
            </label>
          </div>
          {usesPurchase ? (
            <label className="field">
              <span className="label">Stock</span>
              <select
                className="input"
                value={stockAction}
                onChange={(e) => setStockAction(e.target.value as "remove_from_stock" | "keep_in_stock")}
              >
                <option value="remove_from_stock">Remove the matched unit(s) from stock</option>
                <option value="keep_in_stock">Keep in stock (cost write-down only)</option>
              </select>
            </label>
          ) : null}
          <div className="task-modal-grid">
            {lossType === "refund_without_return" ? (
              <label className="field">
                <span className="label">Customer refund (£)</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={customerRefund}
                  onChange={(e) => setCustomerRefund(e.target.value)}
                />
              </label>
            ) : null}
            <label className="field">
              <span className="label">Other costs (£)</span>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={otherCosts}
                onChange={(e) => setOtherCosts(e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span className="label">Notes (optional)</span>
            <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </>
      ) : null}

      {step === 3 ? (
        <>
          {previewError ? <p className="task-modal-error">{previewError}</p> : null}
          {preview ? (
            <>
              <div className={styles.impactGrid}>
                <div className={styles.cell}>
                  <span>Customer refund</span>
                  <strong>{money(preview.impact.customerRefundPence)}</strong>
                </div>
                <div className={styles.cell}>
                  <span>Stock cost written off</span>
                  <strong>{money(preview.impact.stockCostWriteOffPence)}</strong>
                </div>
                <div className={styles.cell}>
                  <span>Other costs</span>
                  <strong>{money(preview.impact.otherCostsPence)}</strong>
                </div>
                <div className={`${styles.cell} ${styles.total}`}>
                  <span>Net profit impact</span>
                  <strong>{impactMoney(preview.impact.netProfitImpactPence)}</strong>
                  <small>recognised {preview.eventMonth}</small>
                </div>
              </div>
              <p className={styles.footerNote}>{preview.accountingNote}</p>
            </>
          ) : (
            <p className={styles.footerNote}>Fill in the details to see the impact preview.</p>
          )}
        </>
      ) : null}

      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
