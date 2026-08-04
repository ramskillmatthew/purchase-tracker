"use client";

import { useEffect, useState } from "react";
import { VINTED_COLOURS, VINTED_MATERIALS, VINTED_AUDIENCE_VALUES, VINTED_AUDIENCE_LABELS, type VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import VintedCategoryPicker from "./VintedCategoryPicker";

export type ListingFieldsDraft = {
  brand: string;
  model: string;
  productType: string;
  // Milestone 6 (Vinted-aware colours/materials): 0-2 exact VINTED_COLOURS
  // values — never free text.
  colours: string[];
  // Milestone 6: "" means unset; otherwise an exact VINTED_MATERIALS value.
  material: string;
  ukSize: string;
  sku: string;
  // Follow-up correction (2026-08-04): the Vinted marketplace audience —
  // independent of any size-conversion gender, see
  // listing-generation-schemas.ts's own comment. Always one of
  // VINTED_AUDIENCE_VALUES, never free text.
  vintedAudience: VintedAudienceValue;
  // Milestone 7 (Vinted category catalogue sync): a real, currently synced
  // vinted_categories.id (or null) — never free text. vintedCategoryPath is
  // display-only, shown while set; choosing/clearing always goes through
  // VintedCategoryPicker, never typed directly.
  vintedCategoryId: number | null;
  vintedCategoryPath: string | null;
};

/**
 * The ONE place a listing's structured fields are edited (Milestone 4).
 * Brand/Model/Product Type/Colours/Material/UK Size/SKU are the editable,
 * canonical source of truth — there is deliberately no title or
 * description field here, or anywhere else: saving always regenerates
 * both from these fields via lib/listing-studio/listing-template.ts, with
 * no AI call.
 *
 * Colours/material are enum pickers, not free-text boxes (Milestone 6):
 * Vinted only accepts a value from its own fixed lists, so a manual edit
 * can no longer introduce a value Vinted would reject any more than the AI
 * can. Two independent selects stand in for "up to 2 colours" — simpler
 * than a multi-select-with-a-cap widget, and the max is structurally
 * impossible to exceed since there are only two dropdowns.
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

  function set<K extends Exclude<keyof ListingFieldsDraft, "colours">>(key: K, value: string) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  // Each dropdown independently sets "its" slot, then the pair is
  // compacted (blanks removed, duplicates collapsed) — so picking the
  // same colour in both, or clearing the first while the second is set,
  // always resolves back to a clean 0-2-item array.
  function setColour(slot: 0 | 1, value: string) {
    setDraft(current => {
      const slots: [string, string] = [current.colours[0] ?? "", current.colours[1] ?? ""];
      slots[slot] = value;
      return { ...current, colours: [...new Set(slots.filter(Boolean))] };
    });
  }

  const colourA = draft.colours[0] ?? "";
  const colourB = draft.colours[1] ?? "";

  // Follow-up correction (2026-08-04): changing audience clears the local
  // category selection so the fields route's own "audience changed AND no
  // manual category in this save" rule recomputes it server-side — never
  // silently keeps an old, possibly now-wrong category. See
  // app/api/listing-studio/groups/[draftId]/fields/route.ts's own comment.
  function setAudience(value: VintedAudienceValue) {
    setDraft(current => ({ ...current, vintedAudience: value, vintedCategoryId: null, vintedCategoryPath: null }));
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
          <span className="label">Colour 1</span>
          <select className="input" value={colourA} onChange={event => setColour(0, event.target.value)} disabled={loading}>
            <option value="">Not set</option>
            {VINTED_COLOURS.map(colour => <option key={colour} value={colour}>{colour}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Colour 2 (optional)</span>
          <select className="input" value={colourB} onChange={event => setColour(1, event.target.value)} disabled={loading}>
            <option value="">Not set</option>
            {VINTED_COLOURS.map(colour => <option key={colour} value={colour}>{colour}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Material</span>
          <select className="input" value={draft.material} onChange={event => set("material", event.target.value)} disabled={loading}>
            <option value="">Not set</option>
            {VINTED_MATERIALS.map(material => <option key={material} value={material}>{material}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">UK size</span>
          <input className="input" value={draft.ukSize} onChange={event => set("ukSize", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">SKU</span>
          <input className="input" value={draft.sku} onChange={event => set("sku", event.target.value)} disabled={loading} />
        </label>
        <label className="field">
          <span className="label">Vinted audience</span>
          <select className="input" value={draft.vintedAudience} onChange={event => setAudience(event.target.value as VintedAudienceValue)} disabled={loading}>
            {VINTED_AUDIENCE_VALUES.map(value => <option key={value} value={value}>{VINTED_AUDIENCE_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Vinted category</span>
          <VintedCategoryPicker
            value={{ id: draft.vintedCategoryId, path: draft.vintedCategoryPath }}
            disabled={loading}
            onChange={next => setDraft(current => ({ ...current, vintedCategoryId: next.id, vintedCategoryPath: next.path }))}
          />
        </label>
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="button" className="button" disabled={loading} onClick={() => onSave(draft)}>{loading ? "Saving…" : "Save"}</button>
      </div>
    </div>
  </div>;
}
