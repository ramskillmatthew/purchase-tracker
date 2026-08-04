"use client";

import { useEffect, useState } from "react";

type CopiedField = "title" | "description" | null;

/**
 * Read-only full preview of a generated listing (Milestone 4 UX fix,
 * extended in Milestone 5 with a Vinted-style card at the top) — the
 * card itself only ever shows a truncated description, with no way to
 * inspect the complete text or copy it. This modal never edits anything:
 * the structured fields (and therefore the title/description) can only
 * ever be changed via EditListingFieldsDialog. No AI call, no new data —
 * every value here is exactly what's already stored and already rendered
 * (in truncated form) on the card.
 *
 * `condition`/`coverImageUrl` are optional so Listing Studio's own,
 * pre-existing call site (which has neither readily available) keeps
 * working completely unchanged — only Listings Review passes them.
 * Price is always a placeholder ("Price not set") — there is no price
 * field anywhere in this milestone; this is explicitly preview-only, no
 * Vinted integration.
 */
export default function PreviewListingDialog({ groupTitle, generatedTitle, generatedDescription, ukSize, sku, condition = null, coverImageUrl = null, onClose }: {
  groupTitle: string;
  generatedTitle: string;
  generatedDescription: string;
  ukSize: string | null;
  sku: string | null;
  condition?: string | null;
  coverImageUrl?: string | null;
  onClose: () => void;
}) {
  const [copiedField, setCopiedField] = useState<CopiedField>(null);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function copy(text: string, field: Exclude<CopiedField, null>) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(current => (current === field ? null : current)), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-secure context, an
      // older browser) — the full text is still visible and selectable in
      // this modal either way, so a copy failure is never treated as a
      // hard error or shown as one.
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal preview-listing-modal" role="dialog" aria-modal="true" aria-labelledby="preview-listing-title">
      <div className="task-modal-heading">
        <h2 id="preview-listing-title">Preview listing — {groupTitle}</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body preview-listing-body">
        <section className="preview-listing-vinted-card" aria-label="Listing preview">
          {coverImageUrl
            // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL, matching every other listing-studio photo <img>
            ? <img className="preview-listing-vinted-image" src={coverImageUrl} alt="" />
            : <div className="preview-listing-vinted-image preview-listing-vinted-image-empty" aria-hidden="true">No photo</div>}
          <div className="preview-listing-vinted-details">
            <p className="preview-listing-vinted-title">{generatedTitle || "No title generated yet."}</p>
            <dl className="preview-listing-vinted-meta">
              <div><dt>Condition</dt><dd>{condition || "Not set"}</dd></div>
              <div><dt>Size</dt><dd>{ukSize ? `UK ${ukSize}` : "Not set"}</dd></div>
              <div><dt>Price</dt><dd className="preview-listing-vinted-price-placeholder">Price not set</dd></div>
            </dl>
          </div>
        </section>

        <section className="preview-listing-section">
          <div className="preview-listing-section-heading">
            <span className="label">Title</span>
            <button type="button" className="button-secondary" onClick={() => copy(generatedTitle, "title")}>
              {copiedField === "title" ? "Copied!" : "Copy title"}
            </button>
          </div>
          <p className="preview-listing-title-text">{generatedTitle || "No title generated yet."}</p>
        </section>

        <section className="preview-listing-section">
          <div className="preview-listing-section-heading">
            <span className="label">Description</span>
            <button type="button" className="button-secondary" onClick={() => copy(generatedDescription, "description")}>
              {copiedField === "description" ? "Copied!" : "Copy description"}
            </button>
          </div>
          {/* white-space: pre-wrap (see globals.css) preserves every line
              break, blank line, and run of spaces exactly as stored — never
              collapsed or reformatted. */}
          <p className="preview-listing-description-text">{generatedDescription || "No description generated yet."}</p>
        </section>

        <div className="preview-listing-meta">
          <div className="preview-listing-meta-item"><span className="label">UK size</span><span>{ukSize || "Not set"}</span></div>
          <div className="preview-listing-meta-item"><span className="label">SKU</span><span>{sku || "Not set"}</span></div>
        </div>
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}
