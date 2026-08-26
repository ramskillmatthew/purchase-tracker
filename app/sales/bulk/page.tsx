"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CreateSaleResult, Purchase } from "@/lib/types";
import { BULK_SALE_FIELDS, inferBulkSaleMapping, parseBulkSaleRows, splitPastedTable, type BulkSaleField, type BulkSaleMapping, type ParsedBulkSaleRow } from "@/lib/sales/bulk-import";
import { formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import styles from "../sales.module.css";

const LABELS: Record<BulkSaleField, string> = { sale_date: "Date sold", ebay: "eBay", vinted: "Vinted", depop: "Depop", other: "Other", item_description: "Item description", sale_price: "Price sold", purchase_price: "Purchase price", shipping: "Shipping cost" };
type WorkingRow = ParsedBulkSaleRow & { key: string; purchase: Purchase | null; query: string; saveError: string; saved: boolean };

export default function BulkSalesPage() {
  const router = useRouter();
  const [pasteOpen, setPasteOpen] = useState(true);
  const [pasteText, setPasteText] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<BulkSaleMapping>(() => Object.fromEntries(BULK_SALE_FIELDS.map(field => [field, null])) as BulkSaleMapping);
  const [rows, setRows] = useState<WorkingRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [completed, setCompleted] = useState<CreateSaleResult[]>([]);

  const table = useMemo(() => splitPastedTable(pasteText), [pasteText]);
  function updatePaste(text: string) { setPasteText(text); const next = splitPastedTable(text); if (next.length) setMapping(inferBulkSaleMapping(hasHeader ? next[0] : [])); }
  function importTable() {
    const parsed = parseBulkSaleRows(table, mapping, hasHeader);
    setRows(parsed.map((row, index) => ({ ...row, key: `${Date.now()}-${index}`, purchase: null, query: row.itemDescription, saveError: "", saved: false })));
    setPasteOpen(false);
  }
  const selectedIds = useMemo(() => new Set(rows.flatMap(row => row.purchase ? [row.purchase.id] : [])), [rows]);
  const readyRows = rows.filter(row => !row.saved && row.errors.length === 0 && row.purchase && !row.saveError);
  const needsAttention = rows.filter(row => !row.saved && (row.errors.length > 0 || !row.purchase || !!row.saveError)).length;
  const totalRevenue = rows.reduce((sum, row) => sum + (row.salePrice ?? 0), 0);
  const totalProfit = rows.reduce((sum, row) => sum + (row.purchase && row.salePrice !== null ? row.salePrice - Number(row.purchase.price_purchased) - (row.shipping ?? 0) : 0), 0);

  async function saveAll() {
    if (!readyRows.length || saving) return;
    setSaving(true); setConfirming(false); const successes: CreateSaleResult[] = [];
    for (const row of readyRows) {
      const purchase = row.purchase!;
      try {
        const response = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseIds: [purchase.id], saleDate: row.saleDate, platform: row.platform, customPlatformName: row.platform === "other" ? row.customPlatformName : null, revenueInputMode: "total", revenueInputValue: row.salePrice, platformFees: 0, postage: row.shipping ?? 0 }) });
        const body = await response.json().catch(() => null);
        if (!response.ok) { setRows(current => current.map(item => item.key === row.key ? { ...item, saveError: body?.error || "Could not save this sale." } : item)); continue; }
        successes.push(body as CreateSaleResult);
        setRows(current => current.map(item => item.key === row.key ? { ...item, saved: true, saveError: "" } : item));
      } catch { setRows(current => current.map(item => item.key === row.key ? { ...item, saveError: "Connection failed. Try this row again." } : item)); }
    }
    setCompleted(current => [...current, ...successes]); setSaving(false);
  }

  if (rows.length > 0 && rows.every(row => row.saved)) return <section className="page-shell"><header className={styles.topbar}><div className="title-row"><h1>Bulk sales recorded</h1></div></header><div className={styles.successBanner}><span>✓</span><span>{completed.length} sales were created and their linked purchases were removed from stock.</span></div><div className={styles.topbarActions} style={{ marginTop: 14 }}><button className="button-secondary" onClick={() => router.push("/sales")}>View Sales</button><button className="button" onClick={() => { setRows([]); setPasteText(""); setCompleted([]); setPasteOpen(true); }}>Start another batch</button></div></section>;

  return <section className="page-shell">
    <header className={styles.topbar}><div><div className="title-row"><h1>Bulk Sales</h1></div><p className={styles.bulkSubtitle}>Paste spreadsheet rows, match each one to in-stock inventory, then review before saving.</p></div><div className={styles.modeSwitch}><button onClick={() => router.push("/sales/new?mode=quick")}>Quick Sale</button><button onClick={() => router.push("/sales/new?mode=order")}>Order Sale</button><button className={styles.modeSwitchActive}>Bulk Sales</button></div></header>
    <div className={styles.bulkSteps}><span className={!rows.length ? styles.bulkStepActive : styles.bulkStepDone}><b>1</b> Paste sales</span><span className={rows.length ? styles.bulkStepActive : ""}><b>2</b> Match inventory</span><span><b>3</b> Review & save</span></div>
    <section className={styles.bulkPastePanel}><div><h2>Paste spreadsheet data</h2><p>Copy the sale columns from Excel or Google Sheets. “Yes” under eBay, Vinted or Depop sets the platform; text in Other becomes the platform name.</p></div><button className="button" onClick={() => setPasteOpen(true)}>{rows.length ? "Replace pasted table" : "Paste table"}</button></section>
    {rows.length === 0 ? <div className={styles.bulkEmpty}><strong>No sales pasted yet</strong><span>Paste your spreadsheet table to begin matching inventory.</span><button className="button" onClick={() => setPasteOpen(true)}>Paste sales</button></div> : <>
      <section className={styles.bulkPreviewPanel}><div className={styles.bulkPreviewHeading}><div><h2>Live preview</h2><span>{rows.length} rows detected. Match each sale to one exact purchase still in stock.</span></div><div><span>Ready <strong>{readyRows.length}</strong></span><span className={needsAttention ? styles.bulkWarn : ""}>Needs attention <strong>{needsAttention}</strong></span></div></div>
        <div className={styles.bulkTableScroll}><table className={styles.bulkSalesTable}><thead><tr><th>#</th><th>Date sold</th><th>Platform</th><th>Spreadsheet item</th><th>Matched purchase</th><th>Price sold</th><th>App cost</th><th>Shipping</th><th>Profit</th><th>Status</th></tr></thead><tbody>{rows.map((row, index) => <BulkRow key={row.key} row={row} index={index} selectedIds={selectedIds} onChange={next => setRows(current => current.map(item => item.key === row.key ? next : item))} />)}</tbody></table></div>
      </section>
      <div className={styles.bulkSaveBar}><div><span>Rows detected<strong>{rows.length}</strong></span><span>Ready to save<strong className={styles.bulkPositive}>{readyRows.length}</strong></span><span>Needs attention<strong className={needsAttention ? styles.bulkWarn : ""}>{needsAttention}</strong></span><span>Total revenue<strong>{formatPenceAsGBP(poundsToPence(totalRevenue))}</strong></span><span>Total profit<strong className={styles.bulkPositive}>{formatPenceAsGBP(poundsToPence(totalProfit))}</strong></span></div><button className="button" disabled={!readyRows.length || saving} onClick={() => setConfirming(true)}>{saving ? "Saving…" : `Save ${readyRows.length} sale${readyRows.length === 1 ? "" : "s"}`}</button></div>
    </>}
    {pasteOpen && <PasteDialog text={pasteText} hasHeader={hasHeader} mapping={mapping} table={table} onText={updatePaste} onHeader={value => { setHasHeader(value); setMapping(inferBulkSaleMapping(value && table.length ? table[0] : [])); }} onMapping={setMapping} onCancel={() => setPasteOpen(false)} onImport={importTable} />}
    {confirming && <div className="dialog-backdrop"><div className={styles.bulkConfirm} role="dialog" aria-modal="true"><h2>Save {readyRows.length} sales?</h2><p>Each matched purchase will be recorded as sold and removed from stock. Rows needing attention will not be saved.</p><div><button className="button-secondary" onClick={() => setConfirming(false)}>Go back</button><button className="button" onClick={saveAll}>Confirm and save</button></div></div></div>}
  </section>;
}

function BulkRow({ row, index, selectedIds, onChange }: { row: WorkingRow; index: number; selectedIds: Set<string>; onChange: (row: WorkingRow) => void }) {
  const [results, setResults] = useState<Purchase[]>([]); const [searching, setSearching] = useState(false); const [open, setOpen] = useState(false);
  async function search(query: string) { onChange({ ...row, query, purchase: null, saveError: "" }); setOpen(true); if (!query.trim()) { setResults([]); return; } setSearching(true); try { const response = await fetch(`/api/sales/available-purchases?q=${encodeURIComponent(query)}&limit=100`); const body = await response.json(); setResults(response.ok ? body.results : []); } finally { setSearching(false); } }
  const profit = row.purchase && row.salePrice !== null ? row.salePrice - Number(row.purchase.price_purchased) - (row.shipping ?? 0) : null;
  const priceMismatch = row.purchase && row.purchasePrice !== null && Math.abs(Number(row.purchase.price_purchased) - row.purchasePrice) >= 0.01;
  const status = row.saved ? "Saved" : row.saveError || row.errors[0] || (!row.purchase ? "Needs item" : priceMismatch ? "Check cost" : "Ready");
  return <tr className={row.saved ? styles.bulkSavedRow : ""}><td>{index + 1}</td><td>{row.saleDate || "—"}</td><td>{row.platform === "other" ? row.customPlatformName : row.platform || "—"}</td><td>{row.itemDescription || "—"}</td><td><div className={styles.bulkMatchCell}>{row.purchase ? <div className={styles.bulkMatchedChip}><span>SKU {row.purchase.sku || "—"}</span><b>{row.purchase.item_description}</b><small>{row.purchase.item_size} · {formatPenceAsGBP(poundsToPence(Number(row.purchase.price_purchased)))}</small><button aria-label="Remove match" onClick={() => onChange({ ...row, purchase: null, saveError: "" })}>×</button></div> : <><input value={row.query} onChange={event => search(event.target.value)} onFocus={() => { setOpen(true); if (!results.length) search(row.query); }} placeholder="Search SKU or description…" disabled={row.saved} />{open && <div className={styles.bulkMatchMenu}>{searching ? <p>Searching…</p> : results.filter(item => !selectedIds.has(item.id)).map(item => <button key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => { onChange({ ...row, purchase: item, query: item.item_description, saveError: "" }); setOpen(false); }}><span><b>{item.item_description}</b><small>SKU {item.sku || "—"} · {item.item_size} · {item.order_date}</small></span><strong>{formatPenceAsGBP(poundsToPence(Number(item.price_purchased)))}</strong></button>)}</div>}</>}</div></td><td>{row.salePrice === null ? "—" : formatPenceAsGBP(poundsToPence(row.salePrice))}</td><td className={priceMismatch ? styles.bulkCostWarn : ""}>{row.purchase ? formatPenceAsGBP(poundsToPence(Number(row.purchase.price_purchased))) : "—"}</td><td>{formatPenceAsGBP(poundsToPence(row.shipping ?? 0))}</td><td className={profit !== null ? styles.bulkProfit : ""}>{profit === null ? "—" : formatPenceAsGBP(poundsToPence(profit))}</td><td><span className={`${styles.bulkStatus} ${row.saved || status === "Ready" ? styles.bulkStatusReady : status === "Check cost" ? styles.bulkStatusWarn : styles.bulkStatusError}`}>{status}</span></td></tr>;
}

function PasteDialog({ text, hasHeader, mapping, table, onText, onHeader, onMapping, onCancel, onImport }: { text: string; hasHeader: boolean; mapping: BulkSaleMapping; table: string[][]; onText: (text: string) => void; onHeader: (value: boolean) => void; onMapping: (mapping: BulkSaleMapping) => void; onCancel: () => void; onImport: () => void }) {
  const width = Math.max(0, ...table.map(row => row.length)); const columns = Array.from({ length: width }, (_, index) => index);
  return <div className="dialog-backdrop"><div className={styles.bulkPasteDialog} role="dialog" aria-modal="true"><div className={styles.bulkDialogHeading}><div><h2>Paste sales table</h2><p>Paste tab-separated cells copied from Excel or Google Sheets.</p></div><button aria-label="Close" onClick={onCancel}>×</button></div><textarea autoFocus value={text} onChange={event => onText(event.target.value)} placeholder={"Date Sold or returned\teBay\tVinted\tDepop\tOther\tPrice Sold\tPurchase Price\tShipping Cost\n20/08/2026\t\tYes\t\t\t35.00\t18.50\t2.99"} /><label className={styles.bulkHeaderCheck}><input type="checkbox" checked={hasHeader} onChange={event => onHeader(event.target.checked)} /> First pasted row contains headings</label>{columns.length > 0 && <div className={styles.bulkMapping}>{columns.map(index => { const selected = BULK_SALE_FIELDS.find(field => mapping[field] === index) ?? ""; return <label key={index}><span>Column {index + 1}<small>{table[0]?.[index] || "—"}</small></span><select value={selected} onChange={event => { const field = event.target.value as BulkSaleField | ""; const next = { ...mapping }; for (const key of BULK_SALE_FIELDS) if (next[key] === index) next[key] = null; if (field) next[field] = index; onMapping(next); }}><option value="">Ignore</option>{BULK_SALE_FIELDS.map(field => <option key={field} value={field}>{LABELS[field]}</option>)}</select></label>; })}</div>}<div className={styles.bulkDialogActions}><button className="button-secondary" onClick={onCancel}>Cancel</button><button className="button" disabled={!text.trim() || mapping.sale_date === null || mapping.sale_price === null} onClick={onImport}>Import table</button></div></div></div>;
}
