"use client";
import { FormEvent, useRef, useState } from "react";
import type { Expense } from "@/lib/types";

export default function ExpenseForm({ onSaved, expense, onCancel }: { onSaved?: () => void; expense?: Expense; onCancel?: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  function clear() {
    formRef.current?.reset();
    setMessage("");
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setMessage("");
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const arrived = values.arrived === "" ? null : values.arrived === "true";
    const url = expense ? `/api/expenses?id=${encodeURIComponent(expense.id)}` : "/api/expenses";
    const res = await fetch(url, {
      method: expense ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, arrived, cost: Number(values.cost) }),
    });
    if (res.ok) {
      form.reset();
      setMessage(expense ? "Expense updated." : "Expense saved.");
      onSaved?.();
    } else {
      setMessage((await res.json()).error || "Could not save expense.");
    }
    setSaving(false);
  }

  return <form ref={formRef} onSubmit={submit} className="card expense-form">
    <div className="compact-form-heading">
      <div><span>{expense ? "Expense record" : "Expense entry"}</span><h2>{expense ? "Edit expense" : "New expense"}</h2></div>
    </div>
    <div className="compact-form-grid">
    <label className="field"><span className="label">Purchase Date</span><input className="input" name="purchase_date" type="date" defaultValue={expense?.purchase_date} required /></label>
    <label className="field"><span className="label">Purchased From</span><input className="input" name="purchased_from" defaultValue={expense?.purchased_from} placeholder="Enter shop, website or seller" required /></label>
    <label className="field"><span className="label">Arrived?</span><select className="input" name="arrived" defaultValue={expense?.arrived === null || expense?.arrived === undefined ? "" : String(expense.arrived)}><option value="">Blank</option><option value="true">Yes</option><option value="false">No</option></select></label>
    <label className="field"><span className="label">Item Description</span><input className="input" name="item_description" defaultValue={expense?.item_description} required /></label>
    <label className="field"><span className="label">Cost</span><input className="input" name="cost" type="number" min="0" step="0.01" defaultValue={expense?.cost} required /></label>
    </div>
    {message && <p className="compact-form-message">{message}</p>}
    <div className="compact-form-actions">
      <div>
      <button type="button" className="button-secondary" onClick={clear}>Clear Fields</button>
      {expense && <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>}
      </div>
      <button className="button" disabled={saving}>{saving ? "Saving..." : expense ? "Save changes" : "Save expense"}</button>
    </div>
  </form>;
}
