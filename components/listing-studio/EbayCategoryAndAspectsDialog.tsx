"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import { partitionAspectsForReview } from "@/lib/listing-studio/ebay-aspect-review-grouping";
import { packageSizes, packageSizeLabels, type EbayCategoryAlternative, type MarketplaceAspectValue, type MarketplaceReadiness, type MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { parsePriceToPence, formatPenceForInput } from "@/lib/listing-studio/ebay-price-input";
import { readEbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";
import { resolveCategoryReviewState, readCategoryConfirmation, CATEGORY_CONFIRMATION_KEY } from "@/lib/listing-studio/ebay-category-review";

// Step 5 (parcel-size suggestion) — persisted as a reserved pseudo-aspect
// (dynamicData.__packageSize), reusing the exact same
// MarketplaceAspectValue shape/route (PATCH .../ebay-aspects) every real
// eBay item specific already uses — see the generate route's own comment
// for why (zero schema change, "manual override always wins" for free via
// the same userConfirmed flag). `reason` rides along as an extra field on
// the same stored JSON object; it's never part of the strict type since
// nothing else reads dynamicData generically.
const PACKAGE_SIZE_ASPECT_NAME = "__packageSize";
type PackageSizeAspectValue = MarketplaceAspectValue & { reason?: string };

type EbayDraftState = {
  id: string;
  marketplace: string;
  title: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  categoryConfidence: "high" | "medium" | "low" | null;
  categorySource: "ai" | "manual" | null;
  categoryAlternatives: EbayCategoryAlternative[];
  conditionValue: string | null;
  pricePence: number | null;
  quantity: number | null;
  status: string;
  readiness: MarketplaceReadiness;
  validationMessages: MarketplaceValidationMessage[];
  dynamicData: Record<string, MarketplaceAspectValue>;
  sourceType: string;
  contentMode: string;
};

type SearchResult = { categoryId: string; categoryName: string; categoryPath: string; relevancy: number | null };

/**
 * Stage 4/5 — "Screen 2: Dynamic eBay details" (category + item specifics)
 * for one product, opened as a modal from Listing Studio matching this
 * app's existing dialog pattern exactly (see PreviewListingDialog.tsx).
 * Opening this dialog NEVER itself triggers an AI call — it only ever GETs
 * currently-stored data; "Suggest category" and "Suggest item specifics"
 * are explicit buttons the owner clicks. Every aspect control is rendered
 * from eBay's own real metadata (select for a constrained value, free text
 * only where eBay itself allows it) — never a fixed, hard-coded form.
 */
export default function EbayCategoryAndAspectsDialog({ draftId, groupTitle, onClose, onDraftUpdated }: { draftId: string; groupTitle: string; onClose: () => void; onDraftUpdated?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<EbayDraftState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [required, setRequired] = useState<GroupedAspect[]>([]);
  const [recommended, setRecommended] = useState<GroupedAspect[]>([]);
  const [optional, setOptional] = useState<GroupedAspect[]>([]);
  const [optionalExpanded, setOptionalExpanded] = useState(false);
  const [suggestingCategory, setSuggestingCategory] = useState(false);
  const [suggestingAspects, setSuggestingAspects] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Problem 4 fix (proven root cause of "0/0 recommended" being shown as
  // if it were a genuine answer when it was really a silently-dropped
  // taxonomy/aspect load failure): the GET below can fail for real reasons
  // (eBay credentials rejected, taxonomy service unavailable, rate
  // limited) — previously that failure was dropped entirely on the floor
  // here, leaving required/recommended/optional at their initial empty
  // arrays with nothing telling the owner why. Taxonomy failure and
  // genuinely-zero-recommended-aspects are different states; this is what
  // distinguishes them.
  const [aspectsLoadError, setAspectsLoadError] = useState<string | null>(null);
  // Phase 8 fix — "the live localhost UI must state when it is using
  // fixture mode." Set only from the server's own honest usedFixture
  // signal (see ebay-category-service.ts) — never inferred client-side.
  const [usedFixture, setUsedFixture] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  // Accessibility fix — "Review field" must jump straight to a flagged
  // aspect. A ref per rendered aspect field lets the effect below scroll it
  // into view and focus its control; `reviewFocus` is the aspect the owner
  // last asked to review.
  const fieldRefs = useRef(new Map<string, HTMLElement | null>());
  const registerFieldRef = useCallback((name: string, element: HTMLElement | null) => { fieldRefs.current.set(name, element); }, []);
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const reviewField = useCallback((name: string) => { setReviewFocus(name); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [draftsResponse, aspectsResponse] = await Promise.all([
        fetch(`/api/listing-studio/groups/${draftId}/marketplace-drafts`),
        fetch(`/api/listing-studio/groups/${draftId}/ebay-aspects`),
      ]);
      if (!draftsResponse.ok) { setLoadError("Could not load this product's eBay draft."); return; }
      const draftsBody = await draftsResponse.json();
      const ebayDraft = (draftsBody.drafts as EbayDraftState[]).find(d => d.marketplace === "EBAY_UK");
      if (!ebayDraft) { setLoadError("No eBay draft exists yet for this product. Select eBay UK or Both and generate listings first."); return; }
      setDraft(ebayDraft);

      if (aspectsResponse.ok) {
        const aspectsBody = await aspectsResponse.json();
        setRequired(aspectsBody.required ?? []);
        setRecommended(aspectsBody.recommended ?? []);
        setOptional(aspectsBody.optional ?? []);
        setAspectsLoadError(null);
      } else {
        const aspectsBody = await aspectsResponse.json().catch(() => ({}));
        setRequired([]); setRecommended([]); setOptional([]);
        setAspectsLoadError(aspectsBody.error || "Could not load this category's item specifics.");
      }
    } catch {
      setLoadError("Could not load this product's eBay draft.");
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !searchOpen) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, searchOpen]);

  // Accessibility fix — every unresolved-review item specific is pulled out
  // of its normal Required/Recommended/Optional group into ONE always-
  // visible "Needs review" group at the top of Item Specifics, so a
  // review-flagged aspect can never be hidden behind the collapsed
  // "optional" section. Same predicate the review summary counts on.
  const reviewPartition = useMemo(
    () => partitionAspectsForReview({ required, recommended, optional }, draft?.dynamicData ?? {}),
    [required, recommended, optional, draft?.dynamicData],
  );

  // "Review field" → scroll the flagged field into view and focus its
  // control. Re-runs whenever the aspect groups change (e.g. after a save
  // re-fetch) so the focus target is still found once it re-renders.
  useEffect(() => {
    if (!reviewFocus) return;
    const element = fieldRefs.current.get(reviewFocus);
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    (element.querySelector("select, input, textarea, button") as HTMLElement | null)?.focus();
  }, [reviewFocus, reviewPartition]);

  async function suggestCategory() {
    setSuggestingCategory(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/ebay-category`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) { setActionError(body.error || "Could not suggest a category."); return; }
      setUsedFixture(Boolean(body.usedFixture));
      await load();
      onDraftUpdated?.();
    } finally {
      setSuggestingCategory(false);
    }
  }

  async function suggestAspects() {
    setSuggestingAspects(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/ebay-aspects`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) { setActionError(body.error || "Could not suggest item specifics."); return; }
      await load();
      onDraftUpdated?.();
    } finally {
      setSuggestingAspects(false);
    }
  }

  async function runSearch(query: string) {
    setSearching(true);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/ebay-category/search`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }),
      });
      const body = await response.json();
      if (response.ok) setSearchResults(body.results ?? []);
      else setActionError(body.error || "Could not search eBay categories.");
    } finally {
      setSearching(false);
    }
  }

  async function chooseCategory(categoryId: string, searchTerms: string) {
    setActionError(null);
    const response = await fetch(`/api/listing-studio/groups/${draftId}/ebay-category`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId, searchTerms }),
    });
    const body = await response.json();
    if (!response.ok) { setActionError(body.error || "The suggested value is not accepted by eBay. Choose another value."); return; }
    setSearchOpen(false);
    setSearchResults([]);
    setSearchQuery("");
    await load();
    onDraftUpdated?.();
  }

  async function saveAspect(aspectName: string, value: string | string[] | null) {
    setDraft(current => current ? { ...current, dynamicData: { ...current.dynamicData, [aspectName]: { ...(current.dynamicData[aspectName] ?? blankAspect()), value, userConfirmed: true } } } : current);
    await fetch(`/api/listing-studio/groups/${draftId}/ebay-aspects`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aspectName, value, confirm: true }),
    });
    await load();
    onDraftUpdated?.();
  }

  // PROVEN ROOT CAUSE FIX — a genuine "Confirm category" action for a
  // UK-size-7+ Medium/Low-confidence category, persisted via the SAME
  // reserved-pseudo-aspect + PATCH /ebay-aspects route every other
  // confirmation in this app already uses (merge-safe, triggers
  // onDraftUpdated). Scoped to the CURRENT category id — see
  // ebay-category-review.ts's own comment on why a stale confirmation from
  // a since-changed category is automatically ignored, with no separate
  // "clear on change" step needed.
  async function confirmCategory() {
    if (!draft?.categoryId) return;
    await saveAspect(CATEGORY_CONFIRMATION_KEY, draft.categoryId);
  }

  // Phase 6 — a genuine price editor. Saves ONLY to the EBAY_UK marketplace
  // draft via the SAME PATCH route Stage 3's title/description already use
  // (which already recomputes readiness/validationMessages server-side —
  // see marketplace-drafts/[marketplace]/route.ts) — never touches a
  // Vinted draft, since the route is called with the literal "EBAY_UK"
  // marketplace segment. Returns an honest ok/error result rather than
  // throwing so PriceSection can show inline save feedback.
  async function savePrice(pricePence: number): Promise<{ ok: true } | { ok: false; error: string }> {
    setActionError(null);
    const response = await fetch(`/api/listing-studio/groups/${draftId}/marketplace-drafts/EBAY_UK`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pricePence }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: body.error || "Could not save this price." };
    setDraft(current => current ? { ...current, pricePence, status: body.status ?? current.status, readiness: body.readiness ?? current.readiness, validationMessages: body.validationMessages ?? current.validationMessages } : current);
    // PROVEN ROOT CAUSE FIX (screenshot regression) — the dialog's own
    // `draft` state above is genuinely updated by this save, but the
    // product-row badge is rendered from a SEPARATE `EbaySummary` object
    // held in the parent GroupingWorkspace's `groups` state (see
    // lib/listing-studio/ebay-card-status.ts's computeEbayCardStatus,
    // which reads `ebay.pricePence` from that summary, not from anything
    // this dialog holds). Nothing previously told the parent a save had
    // happened, so the row kept showing the summary fetched before this
    // dialog ever opened — "Needs price" survives a successful save and
    // even survives closing the dialog. `onDraftUpdated` lets the parent
    // re-fetch its own authoritative copy (GroupingWorkspace passes its
    // `loadWorkspace`) so the row's status is recomputed from the exact
    // same persisted `price_pence` this save just wrote, immediately —
    // never a second, independently-invented price field.
    onDraftUpdated?.();
    return { ok: true };
  }

  if (loading) return <div className="dialog-backdrop" role="presentation"><div className="task-modal" role="dialog" aria-modal="true"><p className="task-modal-loading">Loading…</p></div></div>;

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !searchOpen) onClose(); }}>
    <div className="task-modal ebay-details-modal" role="dialog" aria-modal="true" aria-labelledby="ebay-details-title">
      <div className="task-modal-heading">
        <h2 id="ebay-details-title">eBay details — {groupTitle}</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="task-modal-body ebay-details-body">
        {loadError && <p className="upload-photo-error" role="alert">{loadError}</p>}
        {!loadError && draft && <>
          {/* Phase 12 fix — "The dialog currently says 'eBay readiness:
              63%'. This percentage is misleading when content generation
              failed... A failed content state cannot appear healthy
              merely because several shared fields exist." Generation
              status leads, always, distinct from the completeness
              percentage — which is now explicitly labelled and only ever
              secondary. */}
          {(() => {
            const contentGeneration = readContentGenerationState(draft.dynamicData, {
              sourceType: draft.sourceType, contentMode: draft.contentMode,
              hasTitle: Boolean(draft.title), hasDescription: Boolean(draft.description),
            });
            const degraded = contentGeneration.state === "fallback" || contentGeneration.state === "failed";
            return <div className="ebay-details-readiness" role="status">
              <strong className={degraded ? "ebay-details-status-failed" : "ebay-details-status-ok"}>
                eBay draft status: {degraded ? "Generation failed" : "Content generated"}
              </strong>
              {degraded && contentGeneration.message && <p className="ebay-details-empty">{contentGeneration.message}</p>}
              {/* PROVEN ROOT CAUSE FIX — the old single "X/Y basic
                  requirements (Z%)" line conflated a completion PERCENTAGE
                  with genuine readiness, and blended required/recommended
                  together in a way that read as "only 72% ready" even when
                  every required field was already valid. Required and
                  recommended are now two clearly separate lines, neither
                  labelled as blocking publishing on its own; Review and
                  Status (below) are what actually say whether the draft is
                  ready. */}
              <span className="ebay-details-completeness-label">Required fields: {draft.readiness.requiredComplete}/{draft.readiness.requiredTotal} complete</span>
              {/* Problem 4 fix — "0/0 recommended" must never be shown as
                  if it were a confirmed answer when item specifics
                  actually failed to load; the section below carries the
                  real explanation and retry action. */}
              <span>{aspectsLoadError ? "Recommended specifics could not be loaded" : `Recommended specifics: ${draft.readiness.recommendedComplete}/${draft.readiness.recommendedTotal} complete`}</span>
              <span className="ebay-details-optimisation-note">(Recommended completion is an optimisation score — it never blocks readiness.)</span>
            </div>;
          })()}

          {actionError && <p className="upload-photo-error" role="alert">{actionError}</p>}
          {usedFixture && <p className="ebay-details-fixture-notice" role="status">Showing local fixture categories — no real eBay credentials are configured, so this is not live eBay data.</p>}

          {(() => {
            // PROVEN ROOT CAUSE FIX — the exact reported "Needs review with
            // no visible reason" bug. This is the ONE review summary the
            // dialog renders, sourced from the SAME resolveCategoryReviewState
            // the product-row badge (buildEbaySummary) reads from — the row
            // and this dialog can never disagree about "why". Every
            // required/recommended item specific the aspect pipeline itself
            // flagged needsReview (and the owner hasn't confirmed) is listed
            // alongside a genuine category review reason, if any.
            const productFacts = readEbayProductFacts(draft.dynamicData);
            const categoryReview = resolveCategoryReviewState({
              categoryId: draft.categoryId, categoryName: draft.categoryName, categoryPath: draft.categoryPath,
              categoryConfidence: draft.categoryConfidence, categorySource: draft.categorySource,
              itemFamily: productFacts?.itemFamily ?? "uncertain", ukShoeSize: productFacts?.ukShoeSize ?? null,
              confirmedForCategoryId: readCategoryConfirmation(draft.dynamicData),
            });
            // The aspect review reasons and the "Needs review" aspect group
            // below come from the SAME partitionAspectsForReview call, so the
            // count here can never disagree with the fields the form shows —
            // and every listed reason gets a direct "Review field" action
            // (accessibility fix: no review reason is a dead end).
            const aspectReviewNames = reviewPartition.needsReview.map(a => a.name);
            const categoryReasonText = categoryReview.needsReview && categoryReview.reason
              ? `Category: ${draft.categoryName ?? "selected category"} — ${categoryReview.reason}`
              : null;
            const reasonCount = (categoryReasonText ? 1 : 0) + aspectReviewNames.length;

            return <section className="ebay-details-section ebay-details-review-summary" aria-label="Review summary">
              <div className="ebay-details-section-heading"><span className="label">Review</span></div>
              {reasonCount === 0
                ? <p className="ebay-details-review-clear">No fields require review.</p>
                : <>
                    <p className="ebay-details-review-count">{reasonCount} field{reasonCount === 1 ? "" : "s"} need{reasonCount === 1 ? "s" : ""} review</p>
                    <ul className="ebay-details-review-list">
                      {categoryReasonText && <li key="__category">{categoryReasonText}</li>}
                      {aspectReviewNames.map(name => <li key={name}><span>{name}: needs review.</span><button type="button" className="ebay-details-review-action" onClick={() => reviewField(name)}>Review field</button></li>)}
                    </ul>
                    {categoryReview.needsReview && categoryReview.provenance === "ai_suggestion" && (
                      <div className="ebay-details-section-actions">
                        <button type="button" className="button-secondary" onClick={confirmCategory}>Confirm category</button>
                        <button type="button" className="button-secondary" onClick={() => setSearchOpen(true)}>Change category</button>
                      </div>
                    )}
                    {categoryReview.provenance === "footwear_size_rule_mismatch" && (
                      <div className="ebay-details-section-actions">
                        <button type="button" className="button-secondary" onClick={() => setSearchOpen(true)}>Change category</button>
                      </div>
                    )}
                  </>}
              {reasonCount === 0 && draft.readiness.ready && <p className="ebay-details-review-clear ebay-details-status-ok">Ready to create an eBay draft.</p>}
              <p className="ebay-details-empty">Status: {draft.readiness.ready && reasonCount === 0 ? "Ready" : "Not yet ready"}</p>
            </section>;
          })()}

          <section className="ebay-details-section">
            <div className="ebay-details-section-heading">
              <span className="label">Category</span>
              <div className="ebay-details-section-actions">
                <button type="button" className="button-secondary" onClick={suggestCategory} disabled={suggestingCategory}>{suggestingCategory ? "Suggesting…" : "Suggest category"}</button>
                <button type="button" className="button-secondary" onClick={() => setSearchOpen(true)}>Change category</button>
              </div>
            </div>
            {draft.categoryId
              ? (() => {
                  const productFacts = readEbayProductFacts(draft.dynamicData);
                  const categoryReview = resolveCategoryReviewState({
                    categoryId: draft.categoryId, categoryName: draft.categoryName, categoryPath: draft.categoryPath,
                    categoryConfidence: draft.categoryConfidence, categorySource: draft.categorySource,
                    itemFamily: productFacts?.itemFamily ?? "uncertain", ukShoeSize: productFacts?.ukShoeSize ?? null,
                    confirmedForCategoryId: readCategoryConfirmation(draft.dynamicData),
                  });
                  return <div className="ebay-details-category">
                    <p className="ebay-details-category-name">{draft.categoryName}</p>
                    <p className="ebay-details-category-path">{draft.categoryPath}</p>
                    {/* PROVEN ROOT CAUSE FIX — this used to always show the
                        RAW draft.categoryConfidence with no needsReview
                        ever passed through, so a Medium-confidence category
                        never actually explained anything here even when
                        the row said "Needs review". Now shows the same
                        EFFECTIVE confidence/review state the row and the
                        Review summary above both use — for a qualifying
                        footwear size, this reads High/no-review even when
                        eBay's own raw confidence was Medium, since the
                        deterministic rule corroborates the selection
                        (never displayed as an AI confidence improvement —
                        see the raw confidence preserved untouched in
                        storage). */}
                    <ConfidenceBadge confidence={categoryReview.effectiveConfidence} needsReview={categoryReview.needsReview} />
                    {categoryReview.provenance === "footwear_size_rule" && <span className="ebay-details-empty">Deterministic rule: UK shoe size below 7 is always Women&apos;s.</span>}
                  </div>;
                })()
              : <p className="ebay-details-empty">No category selected yet.</p>}
            {draft.categoryAlternatives.length > 0 && <div className="ebay-details-alternatives">
              <span className="label">Other suggestions</span>
              <ul>
                {draft.categoryAlternatives.map(alt => (
                  <li key={alt.categoryId}>
                    <button type="button" className="ebay-details-alternative-button" onClick={() => chooseCategory(alt.categoryId, draft.title ?? "")}>
                      {alt.categoryName} — {alt.categoryPath}
                    </button>
                  </li>
                ))}
              </ul>
            </div>}
          </section>

          {searchOpen && <section className="ebay-details-search" role="search">
            <label className="field">
              <span className="label">Search eBay categories</span>
              <input className="input" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="e.g. Pokémon TCG Elite Trainer Box" />
            </label>
            <div className="ebay-details-section-actions">
              <button type="button" className="button" onClick={() => runSearch(searchQuery)} disabled={!searchQuery.trim() || searching}>{searching ? "Searching…" : "Search"}</button>
              <button type="button" className="button-secondary" onClick={() => { setSearchOpen(false); setSearchResults([]); }}>Cancel</button>
            </div>
            {searchResults.length > 0 && <ul className="ebay-details-search-results">
              {searchResults.map(result => (
                <li key={result.categoryId}>
                  <button type="button" className="ebay-details-alternative-button" onClick={() => chooseCategory(result.categoryId, searchQuery)}>
                    {result.categoryName} — {result.categoryPath}
                  </button>
                </li>
              ))}
            </ul>}
          </section>}

          {draft.categoryId && <section className="ebay-details-section">
            <div className="ebay-details-section-heading">
              <span className="label">Item specifics</span>
              <button type="button" className="button-secondary" onClick={suggestAspects} disabled={suggestingAspects}>{suggestingAspects ? "Suggesting…" : "Suggest item specifics"}</button>
            </div>

            {/* Problem 4 fix — a genuine load failure is never presented
                as "0 recommended fields"; it gets its own explicit,
                distinct message with a way to retry. */}
            {aspectsLoadError && !suggestingAspects && (
              <p className="upload-photo-error" role="alert">
                {aspectsLoadError} Item specifics for this category could not be loaded — this is not the same as &quot;no recommended fields exist&quot;.{" "}
                <button type="button" className="ebay-details-alternative-button" onClick={suggestAspects}>Retry</button>
              </p>
            )}

            {/* Accessibility invariant — every unresolved-review aspect is
                shown here, in an always-visible group, regardless of whether
                eBay classifies it required / recommended / optional. It
                returns to its normal group below once resolved. */}
            {!aspectsLoadError && reviewPartition.needsReview.length > 0 && (
              <AspectGroup title="Needs review" className="ebay-aspect-group-needs-review" aspects={reviewPartition.needsReview} values={draft.dynamicData} onSave={saveAspect} focusName={reviewFocus} registerRef={registerFieldRef} />
            )}
            {!aspectsLoadError && reviewPartition.required.length > 0 && <AspectGroup title="Required" aspects={reviewPartition.required} values={draft.dynamicData} onSave={saveAspect} registerRef={registerFieldRef} focusName={reviewFocus} />}
            {reviewPartition.recommended.length > 0 && <AspectGroup title="Recommended" aspects={reviewPartition.recommended} values={draft.dynamicData} onSave={saveAspect} registerRef={registerFieldRef} focusName={reviewFocus} />}
            {reviewPartition.optional.length > 0 && <div className="ebay-details-optional">
              <button type="button" className="ebay-details-optional-toggle" aria-expanded={optionalExpanded} onClick={() => setOptionalExpanded(current => !current)}>
                {optionalExpanded ? "Hide optional fields" : `Show optional fields (${reviewPartition.optional.length})`}
              </button>
              {optionalExpanded && <AspectGroup title="Optional" aspects={reviewPartition.optional} values={draft.dynamicData} onSave={saveAspect} registerRef={registerFieldRef} focusName={reviewFocus} />}
            </div>}
          </section>}

          <PackageSizeSection value={draft.dynamicData[PACKAGE_SIZE_ASPECT_NAME] as PackageSizeAspectValue | undefined} onSave={saveAspect} />
          <PriceSection pricePence={draft.pricePence} onSave={savePrice} />
        </>}
      </div>

      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}

function PackageSizeSection({ value, onSave }: { value: PackageSizeAspectValue | undefined; onSave: (name: string, value: string | string[] | null) => void }) {
  const suggested = typeof value?.value === "string" ? value.value : "";
  return <section className="ebay-details-section" aria-label="Parcel size">
    <div className="ebay-details-section-heading"><span className="label">Package size</span></div>
    <label className="field ebay-aspect-field">
      <span className="label">Parcel size for postage</span>
      <select className="input" value={suggested} onChange={event => onSave(PACKAGE_SIZE_ASPECT_NAME, event.target.value || null)}>
        <option value="">Not set</option>
        {packageSizes.map(size => <option key={size} value={size}>{packageSizeLabels[size]}</option>)}
      </select>
      {value
        ? <ConfidenceBadge confidence={value.userConfirmed ? "high" : value.confidence} needsReview={!value.userConfirmed && value.needsReview} />
        : <span className="ebay-details-empty">Not yet suggested — generate this product&apos;s eBay draft first, or choose one manually.</span>}
    </label>
    {value?.reason && !value.userConfirmed && <p className="preview-listing-ebay-readiness">{value.reason}</p>}
  </section>;
}

function PriceSection({ pricePence, onSave }: { pricePence: number | null; onSave: (pricePence: number) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  const [draftValue, setDraftValue] = useState(() => formatPenceForInput(pricePence));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setDraftValue(formatPenceForInput(pricePence)); }, [pricePence]);

  async function commit() {
    const parsed = parsePriceToPence(draftValue);
    if (parsed == null) {
      setStatus("error");
      setValidationMessage(draftValue.trim() ? "Enter a valid price greater than £0.00, e.g. 12.99." : "A price is required.");
      inputRef.current?.focus();
      return;
    }
    setValidationMessage(null);
    setStatus("saving");
    const result = await onSave(parsed);
    if (result.ok) {
      setStatus("saved");
      setDraftValue(formatPenceForInput(parsed));
    } else {
      setStatus("error");
      setValidationMessage(result.error);
      inputRef.current?.focus();
    }
  }

  return <section className="ebay-details-section" aria-label="Price">
    <div className="ebay-details-section-heading"><span className="label">Price</span></div>
    <label className="field ebay-aspect-field" htmlFor="ebay-item-price">
      <span className="label">Item price</span>
      <div className="ebay-price-input-row">
        <span className="ebay-price-currency" aria-hidden="true">£</span>
        <input
          id="ebay-item-price" ref={node => { inputRef.current = node; }} className="input" type="text" inputMode="decimal"
          value={draftValue} placeholder="0.00" aria-describedby="ebay-item-price-status"
          onChange={event => { setDraftValue(event.target.value); setStatus("idle"); }}
          onBlur={() => { void commit(); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void commit(); } }}
        />
      </div>
    </label>
    <p id="ebay-item-price-status" role="status">
      {status === "saving" && "Saving…"}
      {status === "saved" && "Saved."}
      {status === "error" && validationMessage && <span className="upload-photo-error" role="alert">{validationMessage}</span>}
      {status === "idle" && pricePence != null && `Currently saved: £${formatPenceForInput(pricePence)}`}
    </p>
  </section>;
}

function blankAspect(): MarketplaceAspectValue {
  return { value: null, confidence: "unknown", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: new Date().toISOString() };
}

function ConfidenceBadge({ confidence, needsReview }: { confidence: "high" | "medium" | "low" | "unknown"; needsReview?: boolean }) {
  if (needsReview) return <span className="ebay-confidence-badge ebay-confidence-review">⚠ Needs review</span>;
  const labels: Record<typeof confidence, string> = { high: "✓ High confidence", medium: "● Medium confidence", low: "⚠ Low confidence — please confirm", unknown: "— Not provided" };
  return <span className={`ebay-confidence-badge ebay-confidence-${confidence}`}>{labels[confidence]}</span>;
}

function AspectGroup({ title, className, aspects, values, onSave, focusName, registerRef }: {
  title: string;
  className?: string;
  aspects: GroupedAspect[];
  values: Record<string, MarketplaceAspectValue>;
  onSave: (name: string, value: string | string[] | null) => void;
  focusName?: string | null;
  registerRef?: (name: string, element: HTMLElement | null) => void;
}) {
  return <div className={`ebay-aspect-group${className ? ` ${className}` : ""}`}>
    <h4 className="ebay-aspect-group-title">{title}</h4>
    {aspects.map(aspect => <AspectControl key={aspect.name} aspect={aspect} current={values[aspect.name]} onSave={onSave} highlighted={focusName === aspect.name} registerRef={registerRef} />)}
  </div>;
}

function AspectControl({ aspect, current, onSave, highlighted, registerRef }: {
  aspect: GroupedAspect;
  current: MarketplaceAspectValue | undefined;
  onSave: (name: string, value: string | string[] | null) => void;
  highlighted?: boolean;
  registerRef?: (name: string, element: HTMLElement | null) => void;
}) {
  const [draftValue, setDraftValue] = useState<string>(typeof current?.value === "string" ? current.value : "");
  useEffect(() => { setDraftValue(typeof current?.value === "string" ? current.value : ""); }, [current?.value]);

  const confidence = current?.confidence ?? "unknown";
  const needsReview = current?.needsReview ?? false;
  const fieldClass = `field ebay-aspect-field${highlighted ? " ebay-aspect-field-review-focus" : ""}`;
  const setRef = (element: HTMLElement | null) => registerRef?.(aspect.name, element);

  if (aspect.mode === "FREE_TEXT") {
    return <label className={fieldClass} ref={setRef}>
      <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
      <input className="input" value={draftValue} maxLength={aspect.maxLength ?? undefined} onChange={event => setDraftValue(event.target.value)} onBlur={() => onSave(aspect.name, draftValue.trim() || null)} />
      <ConfidenceBadge confidence={confidence} needsReview={needsReview} />
    </label>;
  }

  if (aspect.cardinality === "MULTI") {
    const selected = Array.isArray(current?.value) ? current.value : [];
    return <div className={fieldClass} ref={setRef}>
      <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
      <div className="ebay-aspect-multi-options">
        {aspect.allowedValues.map(option => (
          <label key={option} className="ebay-aspect-multi-option">
            <input
              type="checkbox" checked={selected.includes(option)}
              onChange={event => {
                const next = event.target.checked ? [...selected, option] : selected.filter(v => v !== option);
                onSave(aspect.name, next.length ? next : null);
              }}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
      <ConfidenceBadge confidence={confidence} needsReview={needsReview} />
    </div>;
  }

  return <label className={fieldClass} ref={setRef}>
    <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
    <select className="input" value={typeof current?.value === "string" ? current.value : ""} onChange={event => onSave(aspect.name, event.target.value || null)}>
      <option value="">Not provided</option>
      {aspect.allowedValues.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
    <ConfidenceBadge confidence={confidence} needsReview={needsReview} />
  </label>;
}
