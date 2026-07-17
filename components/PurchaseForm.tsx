"use client";
import { FormEvent, useRef, useState } from "react";
import type { Purchase } from "@/lib/types";

const platforms = ["Vinted", "eBay", "Facebook", "Depop"];
const conditions = ["Brand new", "Brand new without tags", "Labelled as very good condition", "Good condition from photos", "Decent condition from photos"];

export default function PurchaseForm({ onSaved, purchase, onCancel }: { onSaved: () => void; purchase?: Purchase; onCancel?: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const existingPlatform = purchase && platforms.includes(purchase.purchased_from) ? purchase.purchased_from : purchase ? "Other" : "";
  const [source, setSource] = useState(existingPlatform);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function clear() {
    formRef.current?.reset();
    setSource("");
    setError("");
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const { purchased_from_other, ...fields } = values;
    const body = {
      ...fields,
      purchased_from: source === "Other" ? String(purchased_from_other) : source,
      quantity: Number(values.quantity),
      price_purchased: Number(values.price_purchased),
      arrived: values.arrived === "" ? null : values.arrived === "true",
    };
    const url = purchase ? `/api/purchases?id=${encodeURIComponent(purchase.id)}` : "/api/purchases";
    const res = await fetch(url, { method: purchase ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      form.reset();
      setSource("");
      onSaved();
    } else {
      setError((await res.json()).error || "Could not save purchase.");
    }
    setSaving(false);
  }

  return <form ref={formRef} onSubmit={submit} className="card purchase-form">
    <div className="purchase-form-heading">
      <div>
        <span className="purchase-form-kicker">{purchase ? "Purchase record" : "Inventory entry"}</span>
        <h2>{purchase ? "Edit purchase" : "New purchase"}</h2>
      </div>
    </div>
    <div className="purchase-form-grid">
    <label className="field"><span className="label">Order Date</span><input className="input" name="order_date" type="date" defaultValue={purchase?.order_date} required /></label>
    <label className="field"><span className="label">Purchased From</span><select className="input" required value={source} onChange={(e) => setSource(e.target.value)}><option value="" disabled>Choose platform</option>{[...platforms, "Other"].map(x => <option key={x}>{x}</option>)}</select></label>
    {source === "Other" && <label className="field purchase-form-wide"><span className="label">Where did you purchase it?</span><input className="input" name="purchased_from_other" defaultValue={purchase && !platforms.includes(purchase.purchased_from) ? purchase.purchased_from : ""} placeholder="Enter shop, website or seller" required /></label>}
    <label className="field"><span className="label">Seller Name</span><input className="input" name="seller_name" defaultValue={purchase?.seller_name} /></label>
    <label className="field"><span className="label">SKU</span><input className="input" name="sku" defaultValue={purchase?.sku} required /></label>
    <label className="field"><span className="label">Item Description</span><input className="input" name="item_description" defaultValue={purchase?.item_description} required /></label>
    <label className="field"><span className="label">Item Size</span><input className="input" name="item_size" defaultValue={purchase?.item_size} required /></label>
    <label className="field"><span className="label">Quantity</span><input className="input" name="quantity" type="number" min="1" step="1" defaultValue={purchase?.quantity ?? 1} required /></label>
    <label className="field"><span className="label">Item Condition</span><select className="input" name="item_condition" required defaultValue={purchase?.item_condition ?? ""}><option value="" disabled>Choose condition</option>{conditions.map(x => <option key={x}>{x}</option>)}</select></label>
    <label className="field"><span className="label">Price Purchased</span><input className="input" name="price_purchased" type="number" min="0" step="0.01" defaultValue={purchase?.price_purchased} required /></label>
    <label className="field"><span className="label">Arrived?</span><select className="input" name="arrived" defaultValue={purchase?.arrived === null || purchase?.arrived === undefined ? "" : String(purchase.arrived)}><option value="">Blank</option><option value="true">Yes</option><option value="false">No</option></select></label>
    </div>
    {error && <p className="purchase-form-error">{error}</p>}
    <div className="purchase-form-actions">
      <div className="purchase-form-secondary-actions">
      <button type="button" className="button-secondary" onClick={clear}>Clear Fields</button>
      {purchase && <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>}
      </div>
      <button className="button purchase-form-save" disabled={saving}>{saving ? "Saving..." : purchase ? "Save changes" : "Save purchase"}</button>
    </div>
  </form>;
}
