"use client";

import { useEffect, useState } from "react";
import SpreadsheetImportDialog from "@/components/SpreadsheetImportDialog";
import type { AccountResponse } from "@/lib/investments/view-model-types";

type Category = "stock" | "pokemon" | "lego" | "cash";
const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: "stock", label: "Stock / ETF" }, { value: "pokemon", label: "Pokémon" }, { value: "lego", label: "LEGO" }, { value: "cash", label: "Cash" },
];

const NEW_ACCOUNT = "__new__";
const ACCOUNT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "isa", label: "Stocks & Shares ISA" }, { value: "gia", label: "General investment account" },
  { value: "pokemon_collection", label: "Pokémon collection" }, { value: "lego_collection", label: "LEGO collection" },
  { value: "cash", label: "Cash" }, { value: "other", label: "Other" },
];
// A sensible starting suggestion only — the owner can rename/retype before
// creating it. Never auto-created silently; always an explicit choice.
const SUGGESTED_ACCOUNT: Record<Category, { name: string; accountType: string }> = {
  stock: { name: "Stocks & Shares ISA", accountType: "isa" },
  pokemon: { name: "Pokémon Collection", accountType: "pokemon_collection" },
  lego: { name: "LEGO Collection", accountType: "lego_collection" },
  cash: { name: "Cash", accountType: "cash" },
};

// Mirrors lib/investments-import/schema.ts's own column list — kept as a
// small local literal (not re-exported from the server-only schema
// module) purely for the generic SpreadsheetImportDialog's preview table
// labels.
const IMPORT_COLUMNS = [
  { key: "account_name", label: "Account Name" }, { key: "asset_category", label: "Asset Category" },
  { key: "asset_name", label: "Asset Name" }, { key: "ticker", label: "Ticker" }, { key: "exchange", label: "Exchange" },
  { key: "pokepulse_url", label: "PokePulse URL" }, { key: "lego_set_number", label: "LEGO Set Number" },
  { key: "transaction_type", label: "Transaction Type" }, { key: "transaction_date", label: "Transaction Date" },
  { key: "quantity", label: "Quantity" }, { key: "native_unit_price", label: "Native Unit Price" }, { key: "currency", label: "Currency" },
  { key: "actual_total_gbp", label: "Actual Total GBP" }, { key: "fx_rate_at_trade", label: "Purchase FX Rate" },
  { key: "fees_gbp", label: "Fees GBP" }, { key: "image_url", label: "Image URL" }, { key: "notes", label: "Notes" },
  { key: "import_reference", label: "Import Reference" },
];

/**
 * Add investment — a tailored form per category, matching this app's
 * existing modal pattern (.dialog-backdrop + a card, e.g. TaskFormModal)
 * rather than a new, unrelated UI system. All four forms share the same
 * account picker and submit through the same POST /api/investments/assets,
 * which itself validates strictly server-side regardless of what this
 * form sends.
 */
export type AddInvestmentPricingResult = { ok: boolean; provider: string; error?: string } | null;

export default function AddInvestmentModal({ accounts, onClose, onAdded }: {
  accounts: AccountResponse[];
  onClose: () => void;
  onAdded: (pricing: AddInvestmentPricingResult) => void;
}) {
  const [category, setCategory] = useState<Category>("stock");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? (accounts.length === 0 ? NEW_ACCOUNT : ""));
  const [newAccountName, setNewAccountName] = useState(SUGGESTED_ACCOUNT.stock.name);
  const [newAccountType, setNewAccountType] = useState(SUGGESTED_ACCOUNT.stock.accountType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [ticker, setTicker] = useState("");
  const [exchange, setExchange] = useState("");
  const [nativeCurrency, setNativeCurrency] = useState("USD");
  const [sourceUrl, setSourceUrl] = useState("");
  const [legoSetNumber, setLegoSetNumber] = useState("");
  const [currentMarketPriceGbp, setCurrentMarketPriceGbp] = useState("");
  const [cashCurrency, setCashCurrency] = useState("GBP");
  const [openingAmount, setOpeningAmount] = useState("");

  const [purchaseDate, setPurchaseDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [purchaseUnitPrice, setPurchaseUnitPrice] = useState("");
  const [feesGbp, setFeesGbp] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function buildBody(accountId: string): Record<string, unknown> | null {
    if (category === "stock") {
      if (!displayName.trim() || !ticker.trim()) { setError("Enter a name and ticker."); return null; }
      return {
        category, accountId, displayName: displayName.trim(), ticker: ticker.trim(), exchange: exchange.trim() || null, nativeCurrency,
        ...(purchaseDate && quantity && purchaseUnitPrice ? { purchaseDate, quantity: Number(quantity), purchaseUnitPrice: Number(purchaseUnitPrice), feesGbp: Number(feesGbp) || 0 } : {}),
      };
    }
    if (category === "pokemon") {
      if (!sourceUrl.trim()) { setError("Enter a PokePulse URL."); return null; }
      return {
        category, accountId, sourceUrl: sourceUrl.trim(),
        ...(purchaseDate && quantity && purchaseUnitPrice ? { purchaseDate, quantity: Number(quantity), purchaseUnitPrice: Number(purchaseUnitPrice), feesGbp: Number(feesGbp) || 0 } : {}),
      };
    }
    if (category === "lego") {
      if (!displayName.trim() || !legoSetNumber.trim()) { setError("Enter a name and set number."); return null; }
      return {
        category, accountId, displayName: displayName.trim(), legoSetNumber: legoSetNumber.trim(),
        ...(currentMarketPriceGbp ? { currentMarketPriceGbp: Number(currentMarketPriceGbp) } : {}),
        ...(purchaseDate && quantity && purchaseUnitPrice ? { purchaseDate, quantity: Number(quantity), purchaseUnitPrice: Number(purchaseUnitPrice), feesGbp: Number(feesGbp) || 0 } : {}),
      };
    }
    if (!openingAmount) { setError("Enter an opening amount."); return null; }
    return { category, accountId, currency: cashCurrency, openingAmount: Number(openingAmount) };
  }

  async function resolveAccountId(): Promise<string | null> {
    if (accountId !== NEW_ACCOUNT) return accountId;
    if (!newAccountName.trim()) { setError("Enter a name for the new account."); return null; }
    const response = await fetch("/api/investments/accounts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newAccountName.trim(), accountType: newAccountType }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setError(data.error || "Could not create this account."); return null; }
    return data.account.id as string;
  }

  async function submit() {
    setError("");
    setSaving(true);
    const resolvedAccountId = await resolveAccountId();
    if (!resolvedAccountId) { setSaving(false); return; }
    const body = buildBody(resolvedAccountId);
    if (!body) { setSaving(false); return; }
    try {
      const response = await fetch("/api/investments/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "Could not add this investment."); setSaving(false); return; }
      onAdded(data.pricing ?? null);
    } catch {
      setError("Network error — could not add this investment.");
      setSaving(false);
    }
  }

  if (showImport) {
    return <SpreadsheetImportDialog
      title="Import investment transactions" description="Upload a spreadsheet of buy/sell/deposit/withdrawal transactions — accounts and investments are matched or created automatically."
      templateHref="/api/investments/import/template" previewUrl="/api/investments/import/preview" commitUrl="/api/investments/import/commit"
      columns={IMPORT_COLUMNS} itemNoun={{ singular: "transaction", plural: "transactions" }}
      successNote="Prices for any new stock/Pokémon investments will be fetched on the next refresh." onClose={() => setShowImport(false)}
      onImported={() => { onAdded(null); }}
    />;
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal investment-modal" role="dialog" aria-modal="true" aria-labelledby="add-investment-title">
      <div className="task-modal-heading">
        <h2 id="add-investment-title">Add investment</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        <button type="button" className="inv-import-link" onClick={() => setShowImport(true)}>Import from spreadsheet instead</button>
        <div className="field">
          <span className="label">Type</span>
          <div className="task-priority-select">
            {CATEGORIES.map(c => <button key={c.value} type="button" className={`task-priority-option${category === c.value ? " task-priority-option-active" : ""}`} onClick={() => {
              setCategory(c.value);
              // Only steer the still-untouched new-account suggestion — never overwrite a name the owner already typed.
              if (accountId === NEW_ACCOUNT && newAccountName === SUGGESTED_ACCOUNT[category].name) {
                setNewAccountName(SUGGESTED_ACCOUNT[c.value].name);
                setNewAccountType(SUGGESTED_ACCOUNT[c.value].accountType);
              }
            }}>{c.label}</button>)}
          </div>
        </div>

        <label className="field">
          <span className="label">Account *</span>
          <select className="input" value={accountId} onChange={e => setAccountId(e.target.value)}>
            {accounts.length > 0 && <option value="" disabled>Select an account</option>}
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            <option value={NEW_ACCOUNT}>+ Create new account</option>
          </select>
        </label>

        {accountId === NEW_ACCOUNT && <div className="task-modal-grid">
          <label className="field"><span className="label">New account name *</span><input className="input" value={newAccountName} onChange={e => setNewAccountName(e.target.value)} placeholder="e.g. Stocks & Shares ISA" /></label>
          <label className="field"><span className="label">Account type</span>
            <select className="input" value={newAccountType} onChange={e => setNewAccountType(e.target.value)}>
              {ACCOUNT_TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
        </div>}

        {category === "stock" && <>
          <label className="field"><span className="label">Company / ETF name *</span><input className="input" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. NVIDIA Corp" autoFocus /></label>
          <div className="task-modal-grid">
            <label className="field"><span className="label">Ticker *</span><input className="input" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="NVDA" /></label>
            <label className="field"><span className="label">Exchange</span><input className="input" value={exchange} onChange={e => setExchange(e.target.value)} placeholder="NASDAQ" /></label>
          </div>
          <label className="field"><span className="label">Native currency</span>
            <select className="input" value={nativeCurrency} onChange={e => setNativeCurrency(e.target.value)}>
              <option value="USD">USD</option><option value="GBP">GBP</option><option value="EUR">EUR</option>
            </select>
          </label>
        </>}

        {category === "pokemon" && <label className="field">
          <span className="label">PokePulse URL *</span>
          <input className="input" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://pokepulse.io/cards/... or /sealed/..." autoFocus />
          <small>Paste the exact product page URL — its price and image are pulled from PokePulse automatically.</small>
        </label>}

        {category === "lego" && <>
          <label className="field"><span className="label">Product name *</span><input className="input" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. UCS Millennium Falcon" autoFocus /></label>
          <div className="task-modal-grid">
            <label className="field"><span className="label">Set number *</span><input className="input" value={legoSetNumber} onChange={e => setLegoSetNumber(e.target.value)} placeholder="75192" /></label>
            <label className="field"><span className="label">Current market price (£)</span><input className="input" type="number" min="0" step="0.01" value={currentMarketPriceGbp} onChange={e => setCurrentMarketPriceGbp(e.target.value)} placeholder="Optional" /></label>
          </div>
        </>}

        {category === "cash" && <div className="task-modal-grid">
          <label className="field"><span className="label">Currency</span>
            <select className="input" value={cashCurrency} onChange={e => setCashCurrency(e.target.value)}><option value="GBP">GBP</option><option value="USD">USD</option><option value="EUR">EUR</option></select>
          </label>
          <label className="field"><span className="label">Opening amount *</span><input className="input" type="number" min="0" step="0.01" value={openingAmount} onChange={e => setOpeningAmount(e.target.value)} placeholder="0.00" /></label>
        </div>}

        {category !== "cash" && <>
          <p className="label" style={{ marginTop: 4 }}>Optional initial purchase</p>
          <div className="task-modal-grid">
            <label className="field"><span className="label">Purchase date</span><input className="input" type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} /></label>
            <label className="field"><span className="label">Quantity</span><input className="input" type="number" min="0" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
          </div>
          <div className="task-modal-grid">
            <label className="field"><span className="label">Unit price ({category === "pokemon" || category === "lego" ? "£" : nativeCurrency})</span><input className="input" type="number" min="0" step="0.01" value={purchaseUnitPrice} onChange={e => setPurchaseUnitPrice(e.target.value)} /></label>
            <label className="field"><span className="label">Fees (£)</span><input className="input" type="number" min="0" step="0.01" value={feesGbp} onChange={e => setFeesGbp(e.target.value)} /></label>
          </div>
        </>}

        {error && <p className="task-modal-error">{error}</p>}
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="button" disabled={saving} onClick={submit}>{saving ? "Adding…" : "Add investment"}</button>
      </div>
    </div>
  </div>;
}
