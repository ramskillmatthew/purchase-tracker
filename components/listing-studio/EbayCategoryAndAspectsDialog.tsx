"use client";

import { useCallback, useEffect, useState } from "react";
import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { EbayCategoryAlternative, MarketplaceAspectValue, MarketplaceReadiness, MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";

type EbayDraftState = {
  id: string;
  marketplace: string;
  title: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  categoryConfidence: "high" | "medium" | "low" | null;
  categoryAlternatives: EbayCategoryAlternative[];
  status: string;
  readiness: MarketplaceReadiness;
  validationMessages: MarketplaceValidationMessage[];
  dynamicData: Record<string, MarketplaceAspectValue>;
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
export default function EbayCategoryAndAspectsDialog({ draftId, groupTitle, onClose }: { draftId: string; groupTitle: string; onClose: () => void }) {
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

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

  async function suggestCategory() {
    setSuggestingCategory(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/ebay-category`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) { setActionError(body.error || "Could not suggest a category."); return; }
      await load();
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
  }

  async function saveAspect(aspectName: string, value: string | string[] | null) {
    setDraft(current => current ? { ...current, dynamicData: { ...current.dynamicData, [aspectName]: { ...(current.dynamicData[aspectName] ?? blankAspect()), value, userConfirmed: true } } } : current);
    await fetch(`/api/listing-studio/groups/${draftId}/ebay-aspects`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aspectName, value, confirm: true }),
    });
    await load();
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
          <div className="ebay-details-readiness" role="status">
            <strong>eBay readiness: {draft.readiness.completionPercent}%</strong>
            <span>{draft.readiness.requiredComplete}/{draft.readiness.requiredTotal} required · {draft.readiness.recommendedComplete}/{draft.readiness.recommendedTotal} recommended</span>
          </div>

          {actionError && <p className="upload-photo-error" role="alert">{actionError}</p>}

          <section className="ebay-details-section">
            <div className="ebay-details-section-heading">
              <span className="label">Category</span>
              <div className="ebay-details-section-actions">
                <button type="button" className="button-secondary" onClick={suggestCategory} disabled={suggestingCategory}>{suggestingCategory ? "Suggesting…" : "Suggest category"}</button>
                <button type="button" className="button-secondary" onClick={() => setSearchOpen(true)}>Change category</button>
              </div>
            </div>
            {draft.categoryId
              ? <div className="ebay-details-category">
                  <p className="ebay-details-category-name">{draft.categoryName}</p>
                  <p className="ebay-details-category-path">{draft.categoryPath}</p>
                  <ConfidenceBadge confidence={draft.categoryConfidence ?? "high"} />
                </div>
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

            {required.length > 0 && <AspectGroup title="Required" aspects={required} values={draft.dynamicData} onSave={saveAspect} />}
            {recommended.length > 0 && <AspectGroup title="Recommended" aspects={recommended} values={draft.dynamicData} onSave={saveAspect} />}
            {optional.length > 0 && <div className="ebay-details-optional">
              <button type="button" className="ebay-details-optional-toggle" aria-expanded={optionalExpanded} onClick={() => setOptionalExpanded(current => !current)}>
                {optionalExpanded ? "Hide optional fields" : `Show optional fields (${optional.length})`}
              </button>
              {optionalExpanded && <AspectGroup title="Optional" aspects={optional} values={draft.dynamicData} onSave={saveAspect} />}
            </div>}
          </section>}
        </>}
      </div>

      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}

function blankAspect(): MarketplaceAspectValue {
  return { value: null, confidence: "unknown", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: new Date().toISOString() };
}

function ConfidenceBadge({ confidence, needsReview }: { confidence: "high" | "medium" | "low" | "unknown"; needsReview?: boolean }) {
  if (needsReview) return <span className="ebay-confidence-badge ebay-confidence-review">⚠ Needs review</span>;
  const labels: Record<typeof confidence, string> = { high: "✓ High confidence", medium: "● Medium confidence", low: "⚠ Low confidence — please confirm", unknown: "— Not provided" };
  return <span className={`ebay-confidence-badge ebay-confidence-${confidence}`}>{labels[confidence]}</span>;
}

function AspectGroup({ title, aspects, values, onSave }: { title: string; aspects: GroupedAspect[]; values: Record<string, MarketplaceAspectValue>; onSave: (name: string, value: string | string[] | null) => void }) {
  return <div className="ebay-aspect-group">
    <h4 className="ebay-aspect-group-title">{title}</h4>
    {aspects.map(aspect => <AspectControl key={aspect.name} aspect={aspect} current={values[aspect.name]} onSave={onSave} />)}
  </div>;
}

function AspectControl({ aspect, current, onSave }: { aspect: GroupedAspect; current: MarketplaceAspectValue | undefined; onSave: (name: string, value: string | string[] | null) => void }) {
  const [draftValue, setDraftValue] = useState<string>(typeof current?.value === "string" ? current.value : "");
  useEffect(() => { setDraftValue(typeof current?.value === "string" ? current.value : ""); }, [current?.value]);

  const confidence = current?.confidence ?? "unknown";
  const needsReview = current?.needsReview ?? false;

  if (aspect.mode === "FREE_TEXT") {
    return <label className="field ebay-aspect-field">
      <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
      <input className="input" value={draftValue} maxLength={aspect.maxLength ?? undefined} onChange={event => setDraftValue(event.target.value)} onBlur={() => onSave(aspect.name, draftValue.trim() || null)} />
      <ConfidenceBadge confidence={confidence} needsReview={needsReview} />
    </label>;
  }

  if (aspect.cardinality === "MULTI") {
    const selected = Array.isArray(current?.value) ? current.value : [];
    return <div className="field ebay-aspect-field">
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

  return <label className="field ebay-aspect-field">
    <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
    <select className="input" value={typeof current?.value === "string" ? current.value : ""} onChange={event => onSave(aspect.name, event.target.value || null)}>
      <option value="">Not provided</option>
      {aspect.allowedValues.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
    <ConfidenceBadge confidence={confidence} needsReview={needsReview} />
  </label>;
}
