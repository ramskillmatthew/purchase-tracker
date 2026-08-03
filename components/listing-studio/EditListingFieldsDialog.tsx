"use client";

import { useEffect, useState } from "react";

export type ListingFieldsDraft = {
  brand: string;
  model: string;
  productType: string;
  colour: string;
  ukSize: string;
  sku: string;
};

/**
 * The ONE place a listing's structured fields are edited (Milestone 4).
 * Brand/Model/Product Type/Colour/UK Size/SKU are the editable, canonical
 * source of truth — there is deliberately no title or description field
 * here, or anywhere else: saving always regenerates both from these fields
 * via lib/listing-studio/listing-template.ts, with no AI call.
 */
export default function EditListingFieldsDialog({ groupTitle, fields, loading, error, onClose, onSave }: {
  groupTitle: string;
  fields: ListingFieldsDraft;
  loading: boolean;
  error?: string;
  onClose: () => void;
  onSave: (fields: ListingFieldsDraft) => void;
}) {
  const [draft, setDraft] = useState<ListingFieldsDraft>(fields);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !loading) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, loading]);

  function set<K extends keyof ListingFieldsDraft>(key: K, value: string) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby="edit-listing-fields-title">
      <div className="task-modal-heading">
        <h2 id="edit-listing-fields-title">Edit fields — {groupTitle}</h2>
        <button type="button" onClick={onClose} disabled={loading} aria-label="Close">×</button>
      </div>
      {error && <p className="upload-photo-error" role="alert">{error}</p>}
      <div className="task-modal-body edit-listing-fields-body">
        <label className="field">
          <span className="label">Brand</span>
          <input className="input" value={draft.brand} onChange={event => set("brand", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">Model</span>
          <input className="input" value={draft.model} onChange={event => set("model", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">Product type</span>
          <input className="input" value={draft.productType} onChange={event => set("productType", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">Colour</span>
          <input className="input" value={draft.colour} onChange={event => set("colour", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">UK size</span>
          <input className="input" value={draft.ukSize} onChange={event => set("ukSize", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">SKU</span>
          <input className="input" value={draft.sku} onChange={event => set("sku", event.target.value)} disabled={loading} />
        </label>
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="button" className="button" disabled={loading} onClick={() => onSave(draft)}>{loading ? "Saving…" : "Save"}</button>
      </div>
    </div>
  </div>;
}
