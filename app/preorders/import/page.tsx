"use client";
/* eslint-disable @next/next/no-img-element -- previews use local data URLs selected by the user */

import Link from "next/link";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import PreorderShell from "@/components/preorders/PreorderShell";
import { loadPreorders, normalizePostcode, savePreorders, type Preorder, type PreorderStatus } from "@/lib/preorders";

const aliases: Record<string, string[]> = {
  accountEmail: ["email"], orderNumber: ["order number"], customerName: ["shipping name"], address: ["shipping address"], addressLine2: ["address line 2"], townCity: ["town/city", "town city"], postcode: ["postcode"], addressOwner: ["whos address this is", "whose address this is", "who's address this is"], product: ["product title", "product", "title"], quantity: ["quantity", "qty"], unitPrice: ["price per item", "unit price", "price"], orderDate: ["order date", "ordered date", "purchase date"], releaseDate: ["expected arrival", "expected arrival date", "arrival date", "release date"]
};

const fields = Object.keys(aliases);
const requiredFields = ["accountEmail", "orderNumber", "customerName", "address", "addressLine2", "townCity", "postcode", "addressOwner"];
function matchHeader(headers: string[], field: string) { return headers.find(header => aliases[field].includes(header.trim().toLowerCase())) || ""; }

export default function PreorderImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [done, setDone] = useState(0);
  const [productImage, setProductImage] = useState("");
  const [defaultProduct, setDefaultProduct] = useState("");
  const [defaultQuantity, setDefaultQuantity] = useState(1);
  const [defaultUnitPrice, setDefaultUnitPrice] = useState(0);
  const [defaultOrderDate, setDefaultOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [defaultReleaseDate, setDefaultReleaseDate] = useState(new Date().toISOString().slice(0, 10));

  function readFile(file?: File) {
    if (!file) return;
    Papa.parse<Record<string, string>>(file, { header: true, skipEmptyLines: true, complete: result => {
      const nextHeaders = result.meta.fields || [];
      setFileName(file.name); setHeaders(nextHeaders); setRawRows(result.data);
      setMapping(Object.fromEntries(fields.map(field => [field, matchHeader(nextHeaders, field)]))); setDone(0);
    }});
  }
  const required = requiredFields;
  const valid = required.every(field => mapping[field]) && rawRows.length > 0;
  const preview = useMemo(() => rawRows.slice(0, 5).map((row, index) => ({ index, email: row[mapping.accountEmail], order: row[mapping.orderNumber], shippingName: row[mapping.customerName], address: row[mapping.address], townCity: row[mapping.townCity], postcode: row[mapping.postcode], addressOwner: row[mapping.addressOwner] })), [rawRows, mapping]);

  function importRows() {
    if (!valid) return;
    const mapped: Preorder[] = rawRows.map((row, index) => ({
      id: `csv-${Date.now()}-${index}`, orderNumber: row[mapping.orderNumber] || `ROW-${index + 1}`, customerName: row[mapping.customerName] || "", postcode: normalizePostcode(row[mapping.postcode] || "Unknown"), address: row[mapping.address] || "", addressLine2: row[mapping.addressLine2] || "", townCity: row[mapping.townCity] || "", addressOwner: row[mapping.addressOwner] || "", preorderType: "Preorder", product: (mapping.product && row[mapping.product]) || defaultProduct, variant: "", quantity: Number((mapping.quantity && row[mapping.quantity]) || defaultQuantity) || 1, retailer: "Not set", orderDate: (mapping.orderDate && row[mapping.orderDate]) || defaultOrderDate, releaseDate: (mapping.releaseDate && row[mapping.releaseDate]) || defaultReleaseDate, unitPrice: Number((mapping.unitPrice && row[mapping.unitPrice]) || defaultUnitPrice) || 0, postage: 0, status: "Awaiting release" as PreorderStatus, paymentMethod: "", accountEmail: row[mapping.accountEmail] || "", notes: "Imported from CSV.", imageUrl: productImage
    }));
    const existing = loadPreorders(); const importedNumbers = new Set(mapped.map(row => row.orderNumber));
    savePreorders([...existing.filter(row => !importedNumbers.has(row.orderNumber)), ...mapped]); setDone(mapped.length);
  }

  return <PreorderShell title="Import preorders" subtitle="Bring in a supplier export or your own spreadsheet, then check the fields before saving."
    actions={<Link href="/preorders" className="pre-button pre-button-quiet">Back to overview</Link>}>
    <div className="pre-import-grid">
      <section className="pre-panel pre-import-card">
        <div className="pre-step"><span>1</span><div><strong>Choose your CSV</strong><small>One row per order line. Multiple products can share an order number.</small></div></div>
        <button type="button" className="pre-dropzone" onClick={() => inputRef.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); readFile(event.dataTransfer.files[0]); }}>
          <span className="pre-upload-icon">⇧</span><strong>{fileName || "Drop a CSV here, or browse"}</strong><small>{rawRows.length ? `${rawRows.length} rows detected` : "CSV up to 10 MB · headers required"}</small>
        </button>
        <input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={event => readFile(event.target.files?.[0])} />
      </section>

      <aside className="pre-import-help">
        <span className="pre-help-kicker">Recommended columns</span>
        <h2>Capture enough now to avoid detective work later.</h2>
        <p>Your file is address-led. All eight columns are required so every order can be grouped reliably and traced back to the right email and delivery address.</p>
        <div className="pre-column-tags">{["Email", "Order number", "Shipping name", "Shipping address", "Address line 2", "Town/city", "Postcode", "Whos address this is"].map(item => <span key={item}>{item}</span>)}</div>
      </aside>
    </div>

    {headers.length > 0 && <section className="pre-panel pre-mapping-card">
      <div className="pre-step"><span>2</span><div><strong>Match CSV columns</strong><small>We matched the obvious headers. Review anything marked required.</small></div></div>
      <div className="pre-mapping-grid">{fields.map(field => <label key={field}><span>{field.replace(/([A-Z])/g, " $1").replace(/^./, char => char.toUpperCase())}{required.includes(field) && <em>Required</em>}</span><select value={mapping[field] || ""} onChange={event => setMapping(current => ({ ...current, [field]: event.target.value }))}><option value="">Not imported</option>{headers.map(header => <option key={header}>{header}</option>)}</select></label>)}</div>
    </section>}

    {rawRows.length > 0 && <section className="pre-panel pre-preview-card">
      <div className="pre-step-row"><div className="pre-step"><span>3</span><div><strong>Review and import</strong><small>Showing the first {preview.length} of {rawRows.length} rows.</small></div></div></div>
      <div className="pre-order-table-wrap"><table className="pre-order-table"><thead><tr><th>Email</th><th>Order number</th><th>Shipping name</th><th>Shipping address</th><th>Town/city</th><th>Postcode</th><th>Whos address</th></tr></thead><tbody>{preview.map(row => <tr key={row.index}><td>{row.email || "Missing"}</td><td><strong>{row.order || "Missing"}</strong></td><td>{row.shippingName || "Missing"}</td><td>{row.address || "Missing"}</td><td>{row.townCity || "Missing"}</td><td>{row.postcode || "Missing"}</td><td>{row.addressOwner || "Missing"}</td></tr>)}</tbody></table></div>
      <div className="pre-bulk-details"><div className="pre-step"><span>4</span><div><strong>Add the product details</strong><small>Used as defaults when your CSV does not contain these optional columns.</small></div></div><div className="pre-bulk-detail-fields"><label><span>Product title</span><input value={defaultProduct} onChange={event=>setDefaultProduct(event.target.value)} placeholder="e.g. 30th anniversary Elite Trainer Box" /></label><label><span>Quantity per order</span><input type="number" min="1" value={defaultQuantity} onChange={event=>setDefaultQuantity(Number(event.target.value))} /></label><label><span>Price per item</span><div className="pre-money-input"><b>£</b><input type="number" min="0" step="0.01" value={defaultUnitPrice} onChange={event=>setDefaultUnitPrice(Number(event.target.value))} /></div></label><label><span>Order date</span><input type="date" value={defaultOrderDate} onChange={event=>setDefaultOrderDate(event.target.value)} /></label><label><span>Expected arrival</span><input type="date" min={defaultOrderDate} value={defaultReleaseDate} onChange={event=>setDefaultReleaseDate(event.target.value)} /></label></div></div>
      <div className="pre-bulk-photo"><div><strong>5. Add the product photo</strong><small>This photo will be used in every imported preorder row.</small></div><label>{productImage ? <img src={productImage} alt="Product preview" /> : <span>＋ Choose product photo</span>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file=event.target.files?.[0]; if(!file)return; const reader=new FileReader(); reader.onload=()=>setProductImage(String(reader.result)); reader.readAsDataURL(file); }} /></label><button className="pre-button pre-button-primary" type="button" disabled={!valid || !productImage || (!mapping.product && !defaultProduct) || (!mapping.quantity && defaultQuantity<1)} onClick={importRows}>Import {rawRows.length} rows</button></div>
      {done > 0 && <div className="pre-success">✓ Imported {done} preorder rows. <Link href="/preorders">View them grouped by postcode</Link></div>}
    </section>}
  </PreorderShell>;
}
