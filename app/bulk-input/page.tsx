"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Field = "order_date" | "purchased_from" | "seller_name" | "sku" | "arrived" | "item_description" | "item_size" | "item_condition" | "price_purchased";
type Columns = Record<Field, string>;
type ApplyState = Record<"order_date" | "purchased_from" | "seller_name" | "arrived", boolean>;
type BulkRow = Record<Field, string> & { price: number | null; date: string | null; arrivedValue: boolean | null; errors: Field[] };

const fields: { key: Field; label: string; placeholder: string }[] = [
  { key: "sku", label: "SKU", placeholder: "1801\n1802\n1803" },
  { key: "item_description", label: "Item Description", placeholder: "Nike Air Max 95 Black\nNew Balance 2002R Grey" },
  { key: "item_size", label: "Item Size", placeholder: "9\n8.5\n10" },
  { key: "item_condition", label: "Item Condition", placeholder: "Brand new\nGood condition from photos" },
  { key: "price_purchased", label: "Price Purchased", placeholder: "13.49\n£15\n22.50" },
  { key: "seller_name", label: "Seller Name", placeholder: "seller_one\nseller_two" },
  { key: "purchased_from", label: "Purchased From", placeholder: "Vinted\neBay" },
  { key: "order_date", label: "Order Date", placeholder: "17/07/2026\n18/07/2026" },
  { key: "arrived", label: "Arrived", placeholder: "Yes\nNo\n" },
];
const mapOptions = [{ key: "", label: "Ignore column" }, ...fields.map(({ key, label }) => ({ key, label }))];
const sharedKeys = new Set<Field>(["order_date", "purchased_from", "seller_name", "arrived"]);
const emptyColumns = Object.fromEntries(fields.map(field => [field.key, ""])) as Columns;

function todayIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function lines(value: string) { return value.replace(/\r/g, "").split("\n"); }
function lineCount(value: string) { return value === "" ? 0 : lines(value).length; }
function parsePrice(value: string) {
  const clean = value.replace(/£/g, "").replace(/,/g, "").trim();
  if (!clean) return null;
  const number = Number(clean);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function parseDate(value: string) {
  const clean = value.trim();
  if (!clean) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const match = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00`);
  return date.getFullYear() === Number(year) && date.getMonth() + 1 === Number(month) && date.getDate() === Number(day) ? iso : null;
}
function displayDate(value: string) {
  const iso = parseDate(value);
  if (!iso) return value;
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}
function parseArrived(value: string) {
  const clean = value.trim().toLowerCase();
  if (clean === "yes" || clean === "true" || clean === "1") return true;
  if (clean === "no" || clean === "false" || clean === "0") return false;
  return null;
}
function arrivedIsValid(value: string) {
  return !value.trim() || /^(yes|no|true|false|1|0)$/i.test(value.trim());
}
function fieldFromHeading(value: string): Field | "" {
  const heading = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (/\bsku\b/.test(heading)) return "sku";
  if (/seller/.test(heading)) return "seller_name";
  if (/arrived/.test(heading)) return "arrived";
  if (/condition/.test(heading)) return "item_condition";
  if (/size/.test(heading)) return "item_size";
  if (/price|cost|amount/.test(heading)) return "price_purchased";
  if (/description|item|title/.test(heading)) return "item_description";
  if (/purchased from|platform|source|marketplace/.test(heading)) return "purchased_from";
  if (/date/.test(heading)) return "order_date";
  return "";
}

export default function BulkInputPage() {
  const router = useRouter();
  const submitting = useRef(false);
  const [columns, setColumns] = useState<Columns>(emptyColumns);
  const [shared, setShared] = useState({ order_date: todayIso(), purchased_from: "Vinted", platform: "Vinted", seller_name: "", arrived: "" });
  const [apply, setApply] = useState<ApplyState>({ order_date: true, purchased_from: true, seller_name: true, arrived: true });
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [mapping, setMapping] = useState<string[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [result, setResult] = useState<{ added: number; failures: { row: number; reason: string }[] } | null>(null);

  const count = Math.max(0, ...fields.map(field => lineCount(columns[field.key])));
  const rows = useMemo<BulkRow[]>(() => Array.from({ length: count }, (_, index) => {
    const values = Object.fromEntries(fields.map(field => {
      const columnValue = lines(columns[field.key])[index] ?? "";
      const value = sharedKeys.has(field.key) && apply[field.key as keyof ApplyState]
        ? shared[field.key as keyof ApplyState]
        : columnValue;
      return [field.key, value];
    })) as Record<Field, string>;
    const price = parsePrice(values.price_purchased);
    const date = parseDate(values.order_date);
    const errors: Field[] = [];
    if (!values.sku.trim()) errors.push("sku");
    if (!values.item_description.trim()) errors.push("item_description");
    if (price === null) errors.push("price_purchased");
    if (values.order_date.trim() && date === null) errors.push("order_date");
    if (!arrivedIsValid(values.arrived)) errors.push("arrived");
    return { ...values, price, date, arrivedValue: parseArrived(values.arrived), errors };
  }), [apply, columns, count, shared]);
  const ready = rows.filter(row => !row.errors.length).length;
  const invalid = rows.length - ready;

  function updateLine(field: Field, index: number, value: string) {
    setColumns(current => {
      const nextLines = current[field] === "" ? [] : lines(current[field]);
      while (nextLines.length < count) nextLines.push("");
      nextLines[index] = value;
      return { ...current, [field]: nextLines.join("\n") };
    });
  }

  function editCell(field: Field, index: number, value: string) {
    if (sharedKeys.has(field) && apply[field as keyof ApplyState]) {
      const source = rows.map(row => field === "order_date" ? displayDate(row[field]) : row[field]);
      source[index] = value;
      setColumns(current => ({ ...current, [field]: source.join("\n") }));
      setApply(current => ({ ...current, [field]: false }));
      return;
    }
    updateLine(field, index, value);
  }

  function openPasteTable() {
    setPasteText("");
    setMapping([]);
    setHasHeader(true);
    setPasteOpen(true);
  }

  function inspectPaste(value: string) {
    setPasteText(value);
    const table = value.replace(/\r/g, "").split("\n").map(row => row.split("\t"));
    const width = Math.max(0, ...table.map(row => row.length));
    const first = (table[0] || []).join(" ").toLowerCase();
    const detectedHeader = /sku|description|price|date|seller|size|arrived|condition|purchased|platform/.test(first);
    setHasHeader(detectedHeader);
    setMapping(current => Array.from({ length: width }, (_, index) => fieldFromHeading(table[0]?.[index] || "") || current[index] || fields[index]?.key || ""));
  }

  function importTable() {
    const table = pasteText.replace(/\r/g, "").split("\n").map(row => row.split("\t"));
    const dataRows = hasHeader ? table.slice(1) : table;
    setColumns(current => {
      const next = { ...current };
      mapping.forEach((field, columnIndex) => {
        if (!field) return;
        next[field as Field] = dataRows.map(row => row[columnIndex] ?? "").join("\n");
      });
      return next;
    });
    setPasteOpen(false);
  }

  async function saveAll() {
    if (submitting.current || !ready) return;
    submitting.current = true;
    setSaving(true);
    setSaveError("");
    setConfirming(false);
    const validRows = rows.filter(row => !row.errors.length).map(row => ({
      id: crypto.randomUUID(),
      order_date: row.date,
      purchased_from: row.purchased_from || null,
      seller_name: row.seller_name || null,
      sku: row.sku,
      item_description: row.item_description,
      item_size: row.item_size || null,
      item_condition: row.item_condition || null,
      price_purchased: row.price,
      arrived: row.arrivedValue,
    }));
    try {
      const response = await fetch("/api/purchases/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: validRows }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save purchases.");
      setResult({ added: body.added, failures: [...rows.flatMap((row, index) => row.errors.length ? [{ row: index + 1, reason: `Missing ${row.errors.map(field => fields.find(item => item.key === field)?.label).join(", ")}` }] : []), ...(body.failures || [])] });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save purchases.");
    } finally {
      setSaving(false);
      submitting.current = false;
    }
  }

  function resetBatch() {
    setColumns(emptyColumns);
    setShared({ order_date: todayIso(), purchased_from: "Vinted", platform: "Vinted", seller_name: "", arrived: "" });
    setApply({ order_date: true, purchased_from: true, seller_name: true, arrived: true });
    setResult(null);
    setSaveError("");
  }

  if (result) return <section className="page-shell bulk-page"><header className="page-header"><h1>Bulk Input</h1></header><div className="bulk-success"><span>✓</span><h2>{result.added} purchases added</h2><p>{result.failures.length ? `${result.failures.length} rows were skipped because they contained errors.` : "Every valid row was saved successfully."}</p>{result.failures.length > 0 && <div className="bulk-failures">{result.failures.map(failure => <div key={`${failure.row}-${failure.reason}`}><strong>Row {failure.row}</strong><span>{failure.reason}</span></div>)}</div>}<div><button className="button-secondary" onClick={resetBatch}>Start Another Batch</button><button className="button" onClick={() => router.push("/purchases")}>View Purchases</button></div></div></section>;

  return <section className="page-shell bulk-page">
    <header className="bulk-header"><div><h1>Bulk Input</h1><span>Paste purchase data by column and review it before saving.</span></div><button className="button-secondary" type="button" onClick={openPasteTable}>Paste Table</button></header>

    <section className="bulk-panel shared-panel"><div className="bulk-section-heading"><h2>Shared fields</h2><span>Applied values override the matching column below.</span></div><div className="shared-grid">
      <label className="field"><span className="label">Order Date</span><input className="input" type="date" value={shared.order_date} onChange={event => setShared(current => ({ ...current, order_date: event.target.value }))} /><Apply checked={apply.order_date} onChange={checked => setApply(current => ({ ...current, order_date: checked }))} /></label>
      <label className="field"><span className="label">Platform</span><select className="input" value={shared.platform} onChange={event => setShared(current => ({ ...current, platform: event.target.value, purchased_from: event.target.value === "Other" ? "" : event.target.value }))}>{["Vinted", "eBay", "Facebook", "Depop", "Other"].map(value => <option key={value}>{value}</option>)}</select><Apply checked={apply.purchased_from} onChange={checked => setApply(current => ({ ...current, purchased_from: checked }))} /></label>
      <label className="field"><span className="label">Purchased From</span><input className="input" value={shared.purchased_from} onChange={event => setShared(current => ({ ...current, purchased_from: event.target.value }))} placeholder="Vinted" /><Apply checked={apply.purchased_from} onChange={checked => setApply(current => ({ ...current, purchased_from: checked }))} /></label>
      <label className="field"><span className="label">Seller Name</span><input className="input" value={shared.seller_name} onChange={event => setShared(current => ({ ...current, seller_name: event.target.value }))} /><Apply checked={apply.seller_name} onChange={checked => setApply(current => ({ ...current, seller_name: checked }))} /></label>
      <label className="field"><span className="label">Arrived</span><select className="input" value={shared.arrived} onChange={event => setShared(current => ({ ...current, arrived: event.target.value }))}><option value="">Blank</option><option>Yes</option><option>No</option></select><Apply checked={apply.arrived} onChange={checked => setApply(current => ({ ...current, arrived: checked }))} /></label>
    </div></section>

    <section className="bulk-panel"><div className="bulk-section-heading"><h2>Column inputs</h2><span>One line equals one purchase. Blank lines stay in position.</span></div><div className="bulk-columns">{fields.map(field => <label key={field.key}><span>{field.label}{["sku", "item_description", "price_purchased"].includes(field.key) && <b>*</b>}{sharedKeys.has(field.key) && apply[field.key as keyof ApplyState] && <i>Shared</i>}</span><textarea value={columns[field.key]} onChange={event => setColumns(current => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} spellCheck={field.key === "item_description"} /></label>)}</div></section>

    <section className="bulk-panel preview-panel"><div className="bulk-preview-toolbar"><div><h2>Live preview</h2><span>Click any cell to edit it.</span></div><div className="bulk-counts"><span>Rows detected <strong>{count}</strong></span><span>Ready to save <strong>{ready}</strong></span><span className={invalid ? "count-error" : ""}>Rows with errors <strong>{invalid}</strong></span></div></div><div className="bulk-table-scroll"><table className="bulk-table"><thead><tr><th>#</th>{fields.filter(field => field.key !== "price_purchased").sort((a, b) => ["order_date", "purchased_from", "seller_name", "sku", "arrived", "item_description", "item_size", "item_condition"].indexOf(a.key) - ["order_date", "purchased_from", "seller_name", "sku", "arrived", "item_description", "item_size", "item_condition"].indexOf(b.key)).map(field => <th key={field.key}>{field.label}</th>)}<th>Price Purchased</th></tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={index}><td>{index + 1}</td>{(["order_date", "purchased_from", "seller_name", "sku", "arrived", "item_description", "item_size", "item_condition", "price_purchased"] as Field[]).map(field => <td key={field} className={row.errors.includes(field) ? "bulk-cell-error" : ""}><input value={field === "order_date" ? displayDate(row[field]) : field === "price_purchased" && row.price !== null ? String(row.price) : row[field]} onChange={event => editCell(field, index, event.target.value)} aria-label={`${fields.find(item => item.key === field)?.label} row ${index + 1}`} /></td>)}</tr>) : <tr className="bulk-empty-row"><td colSpan={10}>Paste or type values into a column to create preview rows.</td></tr>}</tbody></table></div></section>

    {saveError && <div className="bulk-save-error">{saveError}</div>}
    <div className="bulk-save-bar"><div><strong>{ready} purchases ready</strong><span>{invalid ? `${invalid} invalid rows will be skipped.` : "Only valid rows will be saved."}</span></div><button className="button" disabled={!ready || saving} onClick={() => setConfirming(true)}>{saving ? "Saving..." : "Save All Purchases"}</button></div>

    {pasteOpen && <PasteDialog text={pasteText} onText={inspectPaste} mapping={mapping} setMapping={setMapping} hasHeader={hasHeader} setHasHeader={setHasHeader} onCancel={() => setPasteOpen(false)} onImport={importTable} />}
    {confirming && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConfirming(false); }}><div className="bulk-confirm" role="dialog" aria-modal="true"><h2>Save {ready} purchases?</h2><p>You are about to save {ready} purchases. {invalid ? `${invalid} rows with errors will be skipped.` : "All detected rows are valid."}</p><div><button className="button-secondary" onClick={() => setConfirming(false)}>Go back</button><button className="button" onClick={saveAll}>Save {ready} purchases</button></div></div></div>}
  </section>;
}

function Apply({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <span className="shared-apply"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /> Apply to every row</span>;
}

function PasteDialog({ text, onText, mapping, setMapping, hasHeader, setHasHeader, onCancel, onImport }: { text: string; onText: (value: string) => void; mapping: string[]; setMapping: React.Dispatch<React.SetStateAction<string[]>>; hasHeader: boolean; setHasHeader: (value: boolean) => void; onCancel: () => void; onImport: () => void }) {
  const table = text.replace(/\r/g, "").split("\n").map(row => row.split("\t"));
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div className="paste-dialog" role="dialog" aria-modal="true"><div className="paste-heading"><div><h2>Paste Table</h2><p>Paste tab-separated cells copied from Excel or Google Sheets.</p></div><button onClick={onCancel} aria-label="Close">×</button></div><textarea autoFocus value={text} onChange={event => onText(event.target.value)} placeholder={"SKU\tDescription\tSize\tPrice\n1801\tNike Air Max 95\t9\t13.49"} /><label className="paste-header-check"><input type="checkbox" checked={hasHeader} onChange={event => setHasHeader(event.target.checked)} /> First pasted row contains headings</label>{mapping.length > 0 && <div className="paste-mapping">{mapping.map((field, index) => <label key={index}><span>Column {index + 1}<small>{table[0]?.[index] || `Sample: ${table[hasHeader ? 1 : 0]?.[index] || "—"}`}</small></span><select value={field} onChange={event => setMapping(current => current.map((value, currentIndex) => currentIndex === index ? event.target.value : value))}>{mapOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>)}</div>}<div className="paste-actions"><button className="button-secondary" onClick={onCancel}>Cancel</button><button className="button" disabled={!text.trim() || !mapping.some(Boolean)} onClick={onImport}>Import Table</button></div></div></div>;
}
