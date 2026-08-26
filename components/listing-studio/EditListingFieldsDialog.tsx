"use client";

import { useEffect, useState } from "react";
import { VINTED_COLOURS, VINTED_MATERIALS, VINTED_AUDIENCE_VALUES, VINTED_AUDIENCE_LABELS, type VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import { deriveDraftItemFamily, normaliseFootwearVintedAudience, normaliseFootwearListingText } from "@/lib/listing-studio/vinted-category-selection";
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
// Business-rule follow-up correction: footwear must never be listed under
// a children's Vinted audience — if the draft this dialog opens with is a
// legacy footwear listing still stored as Boys/Girls (predating this
// rule), it's normalised to Women on load so the dropdown shows the
// correct value immediately (never Boys/Girls in the UI for footwear).
// The category selection is cleared in the SAME step, exactly like a live
// user change via setAudience below — so saving immediately recomputes a
// compatible Women's category server-side instead of silently
// re-confirming an incompatible Kids one as a fresh "manual pick".
//
// Business-rule follow-up correction (children's wording in customer-facing
// text): Model/Product type are cleaned of Youth/Kids/Junior/Boys/Girls/
// Child/Children wording on the SAME load, for a footwear/Women's draft —
// so a legacy "Clifton 9 Youth" shows as "Clifton 9" the moment the dialog
// opens, before the user has touched anything. `?? ""` because
// ListingFieldsDraft's model/productType are plain (non-null) strings —
// normaliseFootwearListingText's null-in/null-out shape is for the
// nullable DB-row fields elsewhere, not this always-a-string UI state.
function buildInitialDraft(fields: ListingFieldsDraft): ListingFieldsDraft {
  const itemFamily = deriveDraftItemFamily(fields.productType);
  const normalisedAudience = normaliseFootwearVintedAudience(fields.vintedAudience, itemFamily);
  const cleanedModel = normaliseFootwearListingText(fields.model, itemFamily, normalisedAudience) ?? "";
  const cleanedProductType = normaliseFootwearListingText(fields.productType, itemFamily, normalisedAudience) ?? "";
  const audienceChanged = normalisedAudience !== fields.vintedAudience;
  if (!audienceChanged && cleanedModel === fields.model && cleanedProductType === fields.productType) return fields;
  return {
    ...fields,
    vintedAudience: normalisedAudience,
    model: cleanedModel,
    productType: cleanedProductType,
    vintedCategoryId: audienceChanged ? null : fields.vintedCategoryId,
    vintedCategoryPath: audienceChanged ? null : fields.vintedCategoryPath,
  };
}

export default function EditListingFieldsDialog({ groupTitle, fields, loading, error, onClose, onSave }: {
  groupTitle: string;
  fields: ListingFieldsDraft;
  loading: boolean;
  error?: string;
  onClose: () => void;
  onSave: (fields: ListingFieldsDraft) => void;
}) {
  const [draft, setDraft] = useState<ListingFieldsDraft>(() => buildInitialDraft(fields));

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !loading) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, loading]);

  function set<K extends Exclude<keyof ListingFieldsDraft, "colours">>(key: K, value: string) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  // Business-rule follow-up correction: if the user retypes Product Type
  // into a footwear type while Boys/Girls is still selected (only
  // reachable by having started as non-footwear, since the dropdown below
  // never offers Boys/Girls once already footwear), re-normalise
  // immediately — the audience dropdown's value must always be one of the
  // options it currently renders, and this is also, correctly, the same
  // "audience effectively changed" signal that clears the category
  // selection so a save recomputes a compatible one.
  function setProductType(value: string) {
    setDraft(current => {
      const normalisedAudience = normaliseFootwearVintedAudience(current.vintedAudience, deriveDraftItemFamily(value));
      if (normalisedAudience === current.vintedAudience) return { ...current, productType: value };
      return { ...current, productType: value, vintedAudience: normalisedAudience, vintedCategoryId: null, vintedCategoryPath: null };
    });
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

  // Business-rule follow-up correction: recomputed on every render from
  // the CURRENT productType (not the frozen initial value), so the
  // options list stays correct even as the user edits Product Type live.
  const audienceOptions = deriveDraftItemFamily(draft.productType) === "footwear"
    ? VINTED_AUDIENCE_VALUES.filter(value => value !== "boys" && value !== "girls")
    : VINTED_AUDIENCE_VALUES;

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
          <input className="input" value={draft.productType} onChange={event => setProductType(event.target.value)} disabled={loading} />
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
            {/* Business-rule follow-up correction: footwear must never be
                listed under a children's Vinted audience — Boys/Girls are
                never offered here for a footwear product type, though they
                remain available for clothing/uncertain (e.g. kids
                clothing genuinely needs them). */}
            {audienceOptions.map(value => <option key={value} value={value}>{VINTED_AUDIENCE_LABELS[value]}</option>)}
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
