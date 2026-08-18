"use client";

import { useEffect, useMemo, useState } from "react";
import { formatGbp } from "@/lib/investments/format";
import type { AccountResponse, HoldingResponse } from "@/lib/investments/view-model-types";

type TxType = "buy" | "sell" | "fee" | "deposit" | "withdrawal" | "adjustment";
const TX_TYPES: Array<{ value: TxType; label: string }> = [
  { value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }, { value: "fee", label: "Fee" },
  { value: "deposit", label: "Deposit" }, { value: "withdrawal", label: "Withdrawal" }, { value: "adjustment", label: "Adjustment" },
];

/** The form adapts per transaction type — see this feature's own explicit requirement. Every type flows through the same POST /api/investments/transactions, which re-derives and re-validates the current position server-side regardless of what this form shows. */
export default function RecordTransactionModal({ accounts, holdings, onClose, onRecorded }: {
  accounts: AccountResponse[];
  holdings: HoldingResponse[];
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [type, setType] = useState<TxType>("buy");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [assetId, setAssetId] = useState(holdings[0]?.assetId ?? "");
  const [tradeAt, setTradeAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [nativeUnitPrice, setNativeUnitPrice] = useState("");
  const [gbpTotal, setGbpTotal] = useState("");
  const [fxRateAtTrade, setFxRateAtTrade] = useState("");
  const [gbpFees, setGbpFees] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const needsAsset = type !== "deposit" && type !== "withdrawal";
  const selectedHolding = holdings.find(h => h.assetId === assetId) ?? null;
  const averageCost = selectedHolding && Number(selectedHolding.quantity) > 0 ? selectedHolding.costBasisGbp / Number(selectedHolding.quantity) : null;

  const sellPreview = useMemo(() => {
    if (type !== "sell" || !selectedHolding || averageCost === null || !quantity) return null;
    const qty = Number(quantity);
    const costBasisRemoved = averageCost * qty;
    const proceeds = gbpTotal ? Number(gbpTotal) : (nativeUnitPrice ? Number(nativeUnitPrice) * qty * (selectedHolding.nativeCurrency === "GBP" ? 1 : Number(fxRateAtTrade) || 0) : null);
    const currentQuantity = Number(selectedHolding.quantity);
    return {
      currentQuantity, averageCost, costBasisRemoved,
      proceeds: proceeds ?? null,
      realizedResult: proceeds !== null ? proceeds - costBasisRemoved : null,
      postSaleQuantity: currentQuantity - qty,
    };
  }, [type, selectedHolding, averageCost, quantity, gbpTotal, nativeUnitPrice, fxRateAtTrade]);

  async function submit() {
    setError("");
    if (!accountId) { setError("Choose an account."); return; }
    if (needsAsset && !assetId) { setError("Choose an investment."); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/investments/transactions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId, assetId: needsAsset ? assetId : null, transactionType: type, tradeAt,
          quantity: quantity ? Number(quantity) : undefined, nativeUnitPrice: nativeUnitPrice ? Number(nativeUnitPrice) : undefined,
          nativeCurrency: selectedHolding?.nativeCurrency ?? "GBP", gbpTotal: gbpTotal ? Number(gbpTotal) : undefined,
          fxRateAtTrade: fxRateAtTrade ? Number(fxRateAtTrade) : undefined, gbpFees: gbpFees ? Number(gbpFees) : undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "Could not record this transaction."); setSaving(false); return; }
      onRecorded();
    } catch {
      setError("Network error — could not record this transaction.");
      setSaving(false);
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal investment-modal" role="dialog" aria-modal="true" aria-labelledby="record-tx-title">
      <div className="task-modal-heading">
        <h2 id="record-tx-title">Record transaction</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        <div className="field">
          <span className="label">Type</span>
          <div className="task-priority-select">
            {TX_TYPES.map(t => <button key={t.value} type="button" className={`task-priority-option${type === t.value ? " task-priority-option-active" : ""}`} onClick={() => setType(t.value)}>{t.label}</button>)}
          </div>
        </div>

        <label className="field">
          <span className="label">Account *</span>
          <select className="input" value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="" disabled>Select an account</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>

        {needsAsset && <label className="field">
          <span className="label">Investment *</span>
          <select className="input" value={assetId} onChange={e => setAssetId(e.target.value)}>
            <option value="" disabled>Select an investment</option>
            {holdings.map(h => <option key={h.assetId} value={h.assetId}>{h.displayName}{h.ticker ? ` (${h.ticker})` : ""}</option>)}
          </select>
        </label>}

        {type === "sell" && selectedHolding && averageCost !== null && <div className="inv-sell-preview" role="status">
          <p>Currently held: <strong>{selectedHolding.quantity}</strong> · Weighted-average cost: <strong>{formatGbp(averageCost)}</strong></p>
          {sellPreview && quantity && <>
            <p>Cost basis removed: <strong>{formatGbp(sellPreview.costBasisRemoved)}</strong></p>
            {sellPreview.proceeds !== null && <p>Estimated realised result: <strong>{formatGbp(sellPreview.realizedResult ?? 0, { signed: true })}</strong></p>}
            <p>Remaining after this sale: <strong>{sellPreview.postSaleQuantity}</strong></p>
          </>}
        </div>}

        <div className="task-modal-grid">
          <label className="field"><span className="label">Date *</span><input className="input" type="date" value={tradeAt} onChange={e => setTradeAt(e.target.value)} /></label>
          {type !== "fee" && type !== "deposit" && type !== "withdrawal" && <label className="field"><span className="label">Quantity</span><input className="input" type="number" min="0" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
          {(type === "deposit" || type === "withdrawal") && <label className="field"><span className="label">Amount</span><input className="input" type="number" min="0" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
        </div>

        {(type === "buy" || type === "sell") && <div className="task-modal-grid">
          <label className="field"><span className="label">Unit price ({selectedHolding?.nativeCurrency ?? "native"})</span><input className="input" type="number" min="0" step="0.01" value={nativeUnitPrice} onChange={e => setNativeUnitPrice(e.target.value)} /></label>
          {selectedHolding?.nativeCurrency && selectedHolding.nativeCurrency !== "GBP" && <label className="field"><span className="label">FX rate at trade (GBP per {selectedHolding.nativeCurrency})</span><input className="input" type="number" min="0" step="0.0001" value={fxRateAtTrade} onChange={e => setFxRateAtTrade(e.target.value)} /></label>}
        </div>}

        <div className="task-modal-grid">
          <label className="field">
            <span className="label">Actual GBP total{type === "buy" ? " charged" : type === "sell" ? " received" : ""}</span>
            <input className="input" type="number" min="0" step="0.01" value={gbpTotal} onChange={e => setGbpTotal(e.target.value)} placeholder={nativeUnitPrice && quantity ? "Leave blank to estimate from price × FX" : ""} />
          </label>
          <label className="field"><span className="label">Fees (£)</span><input className="input" type="number" min="0" step="0.01" value={gbpFees} onChange={e => setGbpFees(e.target.value)} /></label>
        </div>

        <label className="field"><span className="label">Notes</span><textarea className="input" value={notes} onChange={e => setNotes(e.target.value)} /></label>

        {error && <p className="task-modal-error">{error}</p>}
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="button" disabled={saving} onClick={submit}>{saving ? "Recording…" : "Record transaction"}</button>
      </div>
    </div>
  </div>;
}
