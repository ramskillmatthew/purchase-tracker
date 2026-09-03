"use client";

import { useCallback, useEffect, useState } from "react";
import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";
import { marketplaceLabels, packageSizeLabels } from "@/lib/listing-studio/marketplace-types";
import type { GenerationTarget } from "@/lib/listing-studio/marketplace-types";
import type { MarketplaceAspectValue, MarketplaceReadiness, MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";
import { EBAY_TITLE_MAX_LENGTH } from "@/lib/listing-studio/ebay-title-builder";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";

// Step 5 (parcel-size suggestion) — same reserved pseudo-aspect key
// EbayCategoryAndAspectsDialog.tsx reads/writes; Preview only ever reads
// it, never suggests or saves one itself (opening this dialog must never
// call AI or write anything).
const PACKAGE_SIZE_ASPECT_NAME = "__packageSize";

type CopiedField = "title" | "description" | null;
type PreviewTab = "vinted" | "ebay";

// The shape this dialog actually reads off GET
// /api/listing-studio/groups/{id}/marketplace-drafts — a narrowed view of
// lib/listing-studio/marketplace-types.ts's MarketplaceDraft, mirroring
// EbayCategoryAndAspectsDialog.tsx's own EbayDraftState (same route,
// same fields it already needs).
type EbayPreviewDraft = {
  title: string | null;
  description: string | null;
  conditionValue: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  pricePence: number | null;
  quantity: number | null;
  readiness: MarketplaceReadiness;
  dynamicData: Record<string, MarketplaceAspectValue>;
  validationMessages: MarketplaceValidationMessage[];
  sourceType: string;
  contentMode: string;
};

/**
 * Read-only full preview of a generated listing (Milestone 4 UX fix,
 * extended in Milestone 5 with a Vinted-style card at the top) — the
 * card itself only ever shows a truncated description, with no way to
 * inspect the complete text or copy it. This modal never edits anything:
 * the structured fields (and therefore the title/description) can only
 * ever be changed via EditListingFieldsDialog (Vinted) or
 * EbayCategoryAndAspectsDialog (eBay category/item specifics). No AI
 * call, no new data — every value here is exactly what's already stored.
 *
 * Marketplace-aware fix (Fault 2): this dialog used to only ever know
 * about Vinted-shaped props, passed in by the caller regardless of which
 * marketplace the owner actually cared about — so "eBay Preview" was
 * literally the Vinted template's own output, never the real
 * `listing_marketplace_drafts` EBAY_UK row. It now fetches that row
 * itself (a plain GET, same pattern as EbayCategoryAndAspectsDialog —
 * never an AI call) keyed by `productDraftId`, and — only when a
 * generated eBay draft actually exists for this product — shows a
 * Vinted/eBay UK tab switch so both marketplaces are inspectable from
 * the one Preview action, each reading its own stored record. A product
 * with no eBay draft yet renders exactly as before: single view, no
 * tabs, zero behaviour change.
 *
 * `condition`/`coverImageUrl` are optional so Listing Studio's own,
 * pre-existing call site (which has neither readily available) keeps
 * working completely unchanged — only Listings Review passes them.
 * `sellingPricePence` is likewise optional, for the same reason (Milestone
 * 6, purchase-price lookup and manual Vinted selling price) — Listing
 * Studio's own call site has no selling price to show, so the placeholder
 * ("Price not set") remains there; Listings Review passes the real saved
 * value once it exists.
 */
export default function PreviewListingDialog({ productDraftId, groupTitle, generatedTitle, generatedDescription, ukSize, sku, condition = null, coverImageUrl = null, sellingPricePence = null, defaultMarketplace = "VINTED", onGenerateEbayDraft, onClose }: {
  productDraftId: string;
  groupTitle: string;
  // Regression fix — Vinted's own generated title/description, null for a
  // product that has never had a Vinted draft generated (e.g. an
  // eBay-only product). Preview must still open and show the real eBay
  // content in that case — see this file's own showingEbay/title logic
  // below, and GroupingWorkspace.tsx's mounting condition, which no
  // longer requires a Vinted listing to exist before rendering this
  // dialog at all.
  generatedTitle: string | null;
  generatedDescription: string | null;
  ukSize: string | null;
  sku: string | null;
  condition?: string | null;
  coverImageUrl?: string | null;
  sellingPricePence?: number | null;
  // Phase 7 fix — which marketplace this Preview was opened FOR (the
  // workspace's currently-selected generation target). Drives which tab
  // opens by default, and — critically — whether a missing/degraded eBay
  // draft is shown as an honest empty/failure state instead of silently
  // falling back to Vinted content. Optional so Listings Review's own
  // call site (which has no such concept) keeps behaving exactly as
  // before: defaults to "VINTED", the pre-existing behaviour.
  defaultMarketplace?: GenerationTarget;
  onGenerateEbayDraft?: (productDraftId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [copiedField, setCopiedField] = useState<CopiedField>(null);
  const [ebayDraft, setEbayDraft] = useState<EbayPreviewDraft | null>(null);
  const [ebayLoadFailed, setEbayLoadFailed] = useState(false);
  const [ebayFetchSettled, setEbayFetchSettled] = useState(false);
  const [activeTab, setActiveTab] = useState<PreviewTab>(defaultMarketplace === "EBAY_UK" ? "ebay" : "vinted");
  const [generatingEbay, setGeneratingEbay] = useState(false);

  const wantsEbay = defaultMarketplace === "EBAY_UK" || defaultMarketplace === "BOTH";

  const loadEbayDraft = useCallback(async () => {
    setEbayLoadFailed(false);
    try {
      const response = await fetch(`/api/listing-studio/groups/${productDraftId}/marketplace-drafts`);
      if (!response.ok) { setEbayLoadFailed(true); return; }
      const body = await response.json();
      const found = (body.drafts as Array<EbayPreviewDraft & { marketplace: string }>).find(d => d.marketplace === "EBAY_UK");
      // Only "available" once it actually has generated content — a
      // marketplace draft row can exist (e.g. settings saved) before
      // "Generate listings" has ever produced a title/description, and an
      // empty eBay tab would be worse than no tab at all.
      const resolved = found && (found.title || found.description) ? found : null;
      setEbayDraft(resolved);
      // Opens straight on the eBay tab when Preview was opened FOR eBay
      // and a real draft exists — never silently defaults to Vinted in
      // that case (the exact reported fault).
      if (resolved && wantsEbay) setActiveTab("ebay");
    } catch {
      setEbayLoadFailed(true);
    } finally {
      setEbayFetchSettled(true);
    }
  }, [productDraftId, wantsEbay]);

  useEffect(() => { void loadEbayDraft(); }, [loadEbayDraft]);
  // Reset whenever a different product's preview opens, so switching
  // between two cards never leaves stale tab/fetch state showing.
  // Regression fix — resets to the tab that matches THIS product's own
  // defaultMarketplace, not unconditionally "vinted". Without this, an
  // eBay-only product (no Vinted listing at all) would flash the empty
  // Vinted view — "No title generated yet." — for the entire window
  // before loadEbayDraft's own fetch resolves and switches it back to
  // eBay; a product with no eBay draft at all is unaffected, since
  // showingEbay only ever becomes true once a real eBay draft is found.
  useEffect(() => { setActiveTab(defaultMarketplace === "EBAY_UK" ? "ebay" : "vinted"); setEbayFetchSettled(false); }, [productDraftId, defaultMarketplace]);

  async function handleGenerateEbayDraft() {
    if (!onGenerateEbayDraft) return;
    setGeneratingEbay(true);
    try {
      await onGenerateEbayDraft(productDraftId);
      await loadEbayDraft();
    } finally {
      setGeneratingEbay(false);
    }
  }

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

  const showingEbay = activeTab === "ebay" && ebayDraft;
  const title = showingEbay ? (ebayDraft.title ?? "") : (generatedTitle ?? "");
  const description = showingEbay ? (ebayDraft.description ?? "") : (generatedDescription ?? "");
  const displayCondition = showingEbay ? ebayDraft.conditionValue : condition;
  const displayPricePence = showingEbay ? ebayDraft.pricePence : sellingPricePence;

  // Phase 7 fix — "Do not show Vinted content as though it were eBay."
  // Once the eBay-draft check has actually settled (never before —
  // that would flash the empty state on every open), a Preview opened
  // FOR eBay UK (or Both) with no real eBay draft yet shows this instead
  // of silently falling back to Vinted content.
  const noEbayDraftYet = wantsEbay && ebayFetchSettled && !ebayLoadFailed && !ebayDraft;
  // Phase 3/11 fix — reads the SAME authoritative content-generation
  // state the product card/counters use (never re-derived from
  // validationMessages, which a FALLBACK row also carries as a mere
  // warning). GENERATED is the only state that's ever a genuine success;
  // FALLBACK/FAILED are always shown as a failure, regardless of how
  // clean the recovery text looks.
  const contentGeneration = showingEbay
    ? readContentGenerationState(ebayDraft.dynamicData, { sourceType: ebayDraft.sourceType, contentMode: ebayDraft.contentMode, hasTitle: Boolean(ebayDraft.title), hasDescription: Boolean(ebayDraft.description) })
    : null;
  const ebayDegraded = contentGeneration ? (contentGeneration.state === "fallback" || contentGeneration.state === "failed") : false;

  if (noEbayDraftYet) {
    return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="task-modal preview-listing-modal" role="dialog" aria-modal="true" aria-labelledby="preview-listing-title">
        <div className="task-modal-heading">
          <h2 id="preview-listing-title">Preview listing — {groupTitle}</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="task-modal-body preview-listing-body">
          <div className="preview-listing-empty-state" role="status">
            <p>No eBay UK draft has been generated for this product.</p>
            {onGenerateEbayDraft && <button type="button" className="button" onClick={handleGenerateEbayDraft} disabled={generatingEbay}>
              {generatingEbay ? "Generating…" : "Generate eBay draft"}
            </button>}
          </div>
        </div>
        <div className="task-modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>;
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal preview-listing-modal" role="dialog" aria-modal="true" aria-labelledby="preview-listing-title">
      <div className="task-modal-heading">
        <h2 id="preview-listing-title">Preview listing — {groupTitle}</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body preview-listing-body">
        {ebayDraft && <div className="period-switch preview-marketplace-tabs" role="tablist" aria-label="Marketplace preview">
          <button type="button" role="tab" aria-selected={activeTab === "vinted"} className={activeTab === "vinted" ? "period-active" : undefined} onClick={() => setActiveTab("vinted")}>Vinted</button>
          <button type="button" role="tab" aria-selected={activeTab === "ebay"} className={activeTab === "ebay" ? "period-active" : undefined} onClick={() => setActiveTab("ebay")}>eBay UK</button>
        </div>}
        {ebayLoadFailed && <p className="upload-photo-error" role="alert">Could not check for an eBay draft — showing the Vinted listing only.</p>}
        {/* Phase 11 fix — "The fallback may be visible for diagnosis/
            editing, but must display 'Fallback content — not a completed
            eBay draft'. Do not call it simply EBAY UK DRAFT because that
            implies success." Shows the safe failure reason and attempt
            count alongside Retry — never just a bare "failed" banner. */}
        {showingEbay && ebayDegraded && <div className="upload-photo-error preview-listing-degraded-banner" role="alert">
          <p><strong>eBay draft generation failed</strong> — showing a basic fallback listing instead.</p>
          {contentGeneration?.message && <p className="preview-listing-ebay-readiness">{contentGeneration.message}</p>}
          {contentGeneration && contentGeneration.attemptCount > 0 && <p className="preview-listing-ebay-readiness">Attempts so far: {contentGeneration.attemptCount}</p>}
          {onGenerateEbayDraft && <button type="button" className="button-secondary" onClick={handleGenerateEbayDraft} disabled={generatingEbay}>{generatingEbay ? "Retrying…" : "Retry"}</button>}
        </div>}
        {showingEbay && !ebayDegraded && contentGeneration?.state === "generated" && <p className="preview-listing-ebay-generated-notice" role="status">eBay content generated{contentGeneration.model ? ` (${contentGeneration.model})` : ""}.</p>}

        <section className="preview-listing-vinted-card" aria-label="Listing preview">
          {coverImageUrl
            // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL, matching every other listing-studio photo <img>
            ? <img className="preview-listing-vinted-image" src={coverImageUrl} alt="" />
            : <div className="preview-listing-vinted-image preview-listing-vinted-image-empty" aria-hidden="true">No photo</div>}
          <div className="preview-listing-vinted-details">
            {showingEbay && (
              ebayDegraded
                ? <span className="preview-listing-marketplace-badge preview-listing-marketplace-badge-degraded">Fallback content — not a completed eBay draft</span>
                : <span className="preview-listing-marketplace-badge">{marketplaceLabels.EBAY_UK} draft</span>
            )}
            <p className="preview-listing-vinted-title">{title || "No title generated yet."}</p>
            <dl className="preview-listing-vinted-meta">
              <div><dt>Condition</dt><dd>{displayCondition || "Not set"}</dd></div>
              {!showingEbay && <div><dt>Size</dt><dd>{ukSize ? `UK ${ukSize}` : "Not set"}</dd></div>}
              <div><dt>Price</dt><dd className={displayPricePence ? undefined : "preview-listing-vinted-price-placeholder"}>{displayPricePence ? formatPenceAsGBP(displayPricePence) : "Price not set"}</dd></div>
              {showingEbay && <div><dt>Quantity</dt><dd>{ebayDraft.quantity ?? "Not set"}</dd></div>}
            </dl>
          </div>
        </section>

        {showingEbay && <section className="preview-listing-section" aria-label="eBay draft completeness">
          <div className="preview-listing-section-heading"><span className="label">Draft completeness</span></div>
          {/* Phase 12 fix — blocking issues shown as plain, specific
              statements before the completion percentage, never a bare
              "63%" implying general health while content generation
              itself failed. */}
          <ul className="preview-listing-ebay-blockers">
            <li className={ebayDraft.categoryId ? "preview-listing-ebay-ok" : "preview-listing-ebay-blocked"}>
              Category: {ebayDraft.categoryId ? `${ebayDraft.categoryName} — ${ebayDraft.categoryPath}` : "Not selected yet — open eBay details to suggest one."}
            </li>
            <li className={ebayDraft.conditionValue ? "preview-listing-ebay-ok" : "preview-listing-ebay-blocked"}>
              Condition: {ebayDraft.conditionValue || (ebayDraft.validationMessages.some(m => m.code === "condition_needs_review") ? "Needs review — evidence suggests a defect" : "Missing")}
            </li>
            <li className={displayPricePence ? "preview-listing-ebay-ok" : "preview-listing-ebay-blocked"}>Price: {displayPricePence ? formatPenceAsGBP(displayPricePence) : "Missing"}</li>
            <li className={ebayDraft.readiness.requiredComplete === ebayDraft.readiness.requiredTotal ? "preview-listing-ebay-ok" : "preview-listing-ebay-blocked"}>
              Required specifics: {ebayDraft.readiness.requiredComplete}/{ebayDraft.readiness.requiredTotal} complete
            </li>
          </ul>
          <p className="preview-listing-ebay-readiness">Package size: {formatPackageSize(ebayDraft.dynamicData[PACKAGE_SIZE_ASPECT_NAME])}</p>
        </section>}

        <section className="preview-listing-section">
          <div className="preview-listing-section-heading">
            <span className="label">Title{showingEbay ? ` (${title.length}/${EBAY_TITLE_MAX_LENGTH} characters)` : ""}</span>
            <button type="button" className="button-secondary" onClick={() => copy(title, "title")}>
              {copiedField === "title" ? "Copied!" : "Copy title"}
            </button>
          </div>
          <p className="preview-listing-title-text">{title || "No title generated yet."}</p>
        </section>

        <section className="preview-listing-section">
          <div className="preview-listing-section-heading">
            <span className="label">Description</span>
            <button type="button" className="button-secondary" onClick={() => copy(description, "description")}>
              {copiedField === "description" ? "Copied!" : "Copy description"}
            </button>
          </div>
          {/* white-space: pre-wrap (see globals.css) preserves every line
              break, blank line, and run of spaces exactly as stored — never
              collapsed or reformatted. */}
          <p className="preview-listing-description-text">{description || "No description generated yet."}</p>
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

// Honest, plain-language rendering of the parcel-size suggestion — never
// implies it came from eBay itself (it's this app's own heuristic, or the
// owner's own manual choice once confirmed via EbayCategoryAndAspectsDialog).
function formatPackageSize(aspect: MarketplaceAspectValue | undefined): string {
  if (!aspect || typeof aspect.value !== "string") return "Not yet suggested — open eBay details to review.";
  const label = packageSizeLabels[aspect.value as keyof typeof packageSizeLabels] ?? aspect.value;
  return aspect.userConfirmed ? label : `Suggested: ${label} — review in eBay details.`;
}
