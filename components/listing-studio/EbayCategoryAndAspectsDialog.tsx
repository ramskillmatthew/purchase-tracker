"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import { partitionAspectsForReview } from "@/lib/listing-studio/ebay-aspect-review-grouping";
import { packageSizes, packageSizeLabels, type EbayCategoryAlternative, type MarketplaceAspectValue, type MarketplaceReadiness, type MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { parsePriceToPence, formatPenceForInput } from "@/lib/listing-studio/ebay-price-input";
import { readEbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";
import { resolveCategoryReviewState, readCategoryConfirmation, CATEGORY_CONFIRMATION_KEY } from "@/lib/listing-studio/ebay-category-review";
import { requiredFootwearDepartment } from "@/lib/listing-studio/footwear-department-rule";
import { DEFAULT_EBAY_CONDITION } from "@/lib/listing-studio/ebay-condition";
import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";
import UnsavedChangesDialog from "./UnsavedChangesDialog";

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
type EbayConditionOption = { conditionId: string; conditionDescription: string; conditionHelpText: string };
type EbayEditorStep = 1 | 2 | 3 | 4;
type InventoryCandidate = { id: string; sku: string; itemDescription: string; itemSize: string; pricePence: number; score: number };

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
export default function EbayCategoryAndAspectsDialog({ draftId, groupTitle, onClose, onDraftUpdated }: { draftId: string; groupTitle: string; onClose: () => void; onDraftUpdated?: () => unknown | Promise<unknown> }) {
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<EbayDraftState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [required, setRequired] = useState<GroupedAspect[]>([]);
  const [recommended, setRecommended] = useState<GroupedAspect[]>([]);
  const [optional, setOptional] = useState<GroupedAspect[]>([]);
  const [optionalExpanded, setOptionalExpanded] = useState(false);
  const [conditionOptions, setConditionOptions] = useState<EbayConditionOption[]>([]);
  const [conditionLoadError, setConditionLoadError] = useState<string | null>(null);
  const [purchasePriceText, setPurchasePriceText] = useState<string | null>(null);
  const [purchasePricePence, setPurchasePricePence] = useState<number | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [suggestingCategory, setSuggestingCategory] = useState(false);
  const [suggestingAspects, setSuggestingAspects] = useState(false);
  const [hasFilledSpecificsWithAi, setHasFilledSpecificsWithAi] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [footerSaveStatus, setFooterSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [activeStep, setActiveStep] = useState<EbayEditorStep>(1);
  const initialStepChosenRef = useRef(false);
  const persistedDraftRef = useRef<EbayDraftState | null>(null);
  const persistedPriceInputRef = useRef("");
  const priceValidationErrorRef = useRef<string | null>(null);
  const defaultConditionAppliedRef = useRef(false);
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
  const reviewField = useCallback((name: string) => { setActiveStep(2); setReviewFocus(name); }, []);

  const load = useCallback(async (preserveEditor = false) => {
    if (!preserveEditor) setLoading(true);
    setLoadError(null);
    try {
      let [draftsResponse, aspectsResponse, conditionsResponse, purchaseResponse] = await Promise.all([
        fetch(`/api/listing-studio/groups/${draftId}/marketplace-drafts`),
        fetch(`/api/listing-studio/groups/${draftId}/ebay-aspects`),
        fetch(`/api/listing-studio/groups/${draftId}/ebay-conditions`),
        fetch(`/api/listing-studio/groups/${draftId}/selling-price`),
      ]);
      if (!draftsResponse.ok) { setLoadError("Could not load this product's eBay draft."); return; }
      let draftsBody = await draftsResponse.json();
      let ebayDraft = (draftsBody.drafts as EbayDraftState[]).find(d => d.marketplace === "EBAY_UK");
      // Older eBay imports predate marketplace-draft persistence. Repair
      // those from the original connected-account listing on first open,
      // then continue into this same editor — no AI generation step.
      if (!ebayDraft) {
        const repairResponse = await fetch(`/api/listing-studio/groups/${draftId}/imported-ebay-details`, { method: "POST" });
        if (!repairResponse.ok) {
          const repairBody = await repairResponse.json().catch(() => ({}));
          setLoadError(repairBody.error || "Could not load the original eBay listing details.");
          return;
        }
        [draftsResponse, aspectsResponse, conditionsResponse, purchaseResponse] = await Promise.all([
          fetch(`/api/listing-studio/groups/${draftId}/marketplace-drafts`, { cache: "no-store" }),
          fetch(`/api/listing-studio/groups/${draftId}/ebay-aspects`, { cache: "no-store" }),
          fetch(`/api/listing-studio/groups/${draftId}/ebay-conditions`, { cache: "no-store" }),
          fetch(`/api/listing-studio/groups/${draftId}/selling-price`, { cache: "no-store" }),
        ]);
        if (!draftsResponse.ok) { setLoadError("Could not load this product's eBay details."); return; }
        draftsBody = await draftsResponse.json();
        ebayDraft = (draftsBody.drafts as EbayDraftState[]).find(d => d.marketplace === "EBAY_UK");
      }
      if (!ebayDraft) { setLoadError("The original eBay details could not be created for this listing."); return; }
      const previousBaseline = persistedDraftRef.current;
      setDraft(current => {
        if (!preserveEditor || !current || !previousBaseline) return ebayDraft;
        const mergedDynamicData = { ...ebayDraft.dynamicData };
        const aspectNames = new Set([...Object.keys(previousBaseline.dynamicData), ...Object.keys(current.dynamicData)]);
        for (const aspectName of aspectNames) {
          const currentValue = current.dynamicData[aspectName];
          const baselineValue = previousBaseline.dynamicData[aspectName];
          if (JSON.stringify(currentValue) === JSON.stringify(baselineValue)) continue;
          if (currentValue === undefined) delete mergedDynamicData[aspectName];
          else mergedDynamicData[aspectName] = currentValue;
        }
        return {
          ...ebayDraft,
          pricePence: current.pricePence !== previousBaseline.pricePence ? current.pricePence : ebayDraft.pricePence,
          conditionValue: current.conditionValue !== previousBaseline.conditionValue ? current.conditionValue : ebayDraft.conditionValue,
          dynamicData: mergedDynamicData,
        };
      });
      const hasStoredAiSpecifics = Object.entries(ebayDraft.dynamicData).some(([name, value]) =>
        !name.startsWith("__") && (value.appliedAutomatically || value.source !== "manual"),
      );
      setHasFilledSpecificsWithAi(current => preserveEditor ? current || hasStoredAiSpecifics : hasStoredAiSpecifics);
      persistedDraftRef.current = ebayDraft;
      const loadedPriceInput = formatPenceForInput(ebayDraft.pricePence);
      setPriceInput(current => preserveEditor && current !== persistedPriceInputRef.current ? current : loadedPriceInput);
      persistedPriceInputRef.current = loadedPriceInput;
      priceValidationErrorRef.current = null;
      if (!initialStepChosenRef.current) {
        setActiveStep(ebayDraft.categoryId ? 2 : 1);
        initialStepChosenRef.current = true;
      }

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
      if (conditionsResponse.ok) {
        const conditionsBody = await conditionsResponse.json();
        setConditionOptions(conditionsBody.conditions ?? []);
        setConditionLoadError(null);
      } else if (conditionsResponse.status === 409) {
        setConditionOptions([]);
        setConditionLoadError(null);
      } else {
        const conditionsBody = await conditionsResponse.json().catch(() => ({}));
        setConditionOptions([]);
        setConditionLoadError(conditionsBody.error || "Could not load eBay's condition choices.");
      }
      if (purchaseResponse.ok) {
        const purchaseBody = await purchaseResponse.json();
        setPurchasePriceText(purchaseBody.purchasePriceText ?? null);
        setPurchasePricePence(purchaseBody.purchaseMatch?.status === "matched" ? purchaseBody.purchaseMatch.purchasePricePence ?? null : null);
      } else {
        setPurchasePriceText("Purchase price unavailable");
        setPurchasePricePence(null);
      }
    } catch {
      setLoadError("Could not load this product's eBay draft.");
    } finally {
      if (!preserveEditor) setLoading(false);
    }
  }, [draftId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const persistedDraft = persistedDraftRef.current;
    if (!draft || !persistedDraft) { setHasUnsavedChanges(false); return; }
    setHasUnsavedChanges(
      priceInput !== persistedPriceInputRef.current
      || draft.conditionValue !== persistedDraft.conditionValue
      || JSON.stringify(draft.dynamicData) !== JSON.stringify(persistedDraft.dynamicData),
    );
  }, [draft, priceInput]);

  const requestClose = useCallback(() => {
    if (footerSaveStatus === "saving") return;
    if (hasUnsavedChanges) setConfirmingClose(true);
    else onClose();
  }, [footerSaveStatus, hasUnsavedChanges, onClose]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || searchOpen) return;
      if (confirmingClose) setConfirmingClose(false);
      else requestClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [confirmingClose, requestClose, searchOpen]);

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
  }, [activeStep, reviewFocus, reviewPartition]);

  async function suggestCategory() {
    setSuggestingCategory(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/ebay-category`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) { setActionError(body.error || "Could not suggest a category."); return; }
      setUsedFixture(Boolean(body.usedFixture));
      await load(true);
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
      setHasFilledSpecificsWithAi(true);
      await load(true);
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
    await load(true);
    onDraftUpdated?.();
  }

  function saveAspect(aspectName: string, value: string | string[] | null) {
    setFooterSaveStatus("idle");
    setActionError(null);
    setDraft(current => current ? {
      ...current,
      dynamicData: {
        ...current.dynamicData,
        [aspectName]: {
          ...(current.dynamicData[aspectName] ?? blankAspect()),
          value,
          confidence: value ? "high" : "unknown",
          source: "manual",
          appliedAutomatically: false,
          needsReview: false,
          userConfirmed: true,
          updatedAt: new Date().toISOString(),
        },
      },
    } : current);
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
    saveAspect(CATEGORY_CONFIRMATION_KEY, draft.categoryId);
  }

  // Price changes are staged with every other editable field. The one
  // Save & close action below persists price, condition and item specifics
  // together so Listing Review can never refresh between separate writes
  // and briefly see a stale/missing selling price.
  function stagePrice(value: string) {
    setFooterSaveStatus("idle");
    setPriceInput(value);
    const parsed = value.trim() ? parsePriceToPence(value) : null;
    const validationMessage = value.trim() && parsed == null ? "Enter a valid price greater than £0.00, e.g. 12.99." : null;
    priceValidationErrorRef.current = validationMessage;
    setDraft(current => current ? { ...current, pricePence: parsed } : current);
  }

  const saveCondition = useCallback(async (conditionValue: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    setActionError(null);
    setFooterSaveStatus("idle");
    setDraft(current => current ? { ...current, conditionValue } : current);
    return { ok: true };
  }, []);

  // The same fixed default used by Vinted's condition workflow: every
  // applicable eBay draft starts on Pre-owned - Excellent, while the live
  // category dropdown below remains fully editable. This also upgrades
  // older drafts that were blank or used the former generic “Very Good”
  // label. A genuine manual eBay choice is never overwritten.
  useEffect(() => {
    if (!draft || defaultConditionAppliedRef.current) return;
    const defaultOption = conditionOptions.find(option => option.conditionId === "2990" && option.conditionDescription === DEFAULT_EBAY_CONDITION);
    if (!defaultOption) return;
    const needsDefault = !draft.conditionValue || draft.conditionValue === "Used – Very Good" || draft.conditionValue === "Used - Very Good";
    if (!needsDefault) return;
    defaultConditionAppliedRef.current = true;
    void saveCondition(defaultOption.conditionDescription).then(result => {
      if (!result.ok) defaultConditionAppliedRef.current = false;
    });
  }, [conditionOptions, draft, saveCondition]);

  async function saveAllChanges() {
    if (!draft) return;
    const parsedPrice = priceInput.trim() ? parsePriceToPence(priceInput) : null;
    if (priceInput.trim() && parsedPrice == null) {
      priceValidationErrorRef.current = "Enter a valid price greater than £0.00, e.g. 12.99.";
      setActionError(priceValidationErrorRef.current);
      setActiveStep(3);
      setFooterSaveStatus("error");
      setConfirmingClose(false);
      return;
    }
    setFooterSaveStatus("saving");
    setActionError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/marketplace-drafts/EBAY_UK`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricePence: parsedPrice, conditionValue: draft.conditionValue, dynamicData: draft.dynamicData }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setActionError(body.error || "Could not save these eBay details.");
        setFooterSaveStatus("error");
        setConfirmingClose(false);
        return;
      }
      const savedDraft: EbayDraftState = {
        ...draft,
        pricePence: body.pricePence ?? parsedPrice,
        conditionValue: body.conditionValue ?? draft.conditionValue,
        dynamicData: body.dynamicData ?? draft.dynamicData,
        status: body.status ?? draft.status,
        readiness: body.readiness ?? draft.readiness,
        validationMessages: body.validationMessages ?? draft.validationMessages,
      };
      setDraft(savedDraft);
      persistedDraftRef.current = savedDraft;
      persistedPriceInputRef.current = priceInput;
      priceValidationErrorRef.current = null;
      setFooterSaveStatus("saved");
      await onDraftUpdated?.();
      onClose();
    } catch {
      setActionError("Network error — could not save these eBay details.");
      setFooterSaveStatus("error");
      setConfirmingClose(false);
    }
  }

  if (loading) return <div className="dialog-backdrop" role="presentation"><div className="task-modal" role="dialog" aria-modal="true"><p className="task-modal-loading">Loading…</p></div></div>;

  if (!loadError && draft) {
    const productFacts = readEbayProductFacts(draft.dynamicData);
    const requiredDepartment = requiredFootwearDepartment(productFacts?.itemFamily ?? "uncertain", productFacts?.ukShoeSize ?? null);
    const categoryReview = resolveCategoryReviewState({
      categoryId: draft.categoryId, categoryName: draft.categoryName, categoryPath: draft.categoryPath,
      categoryConfidence: draft.categoryConfidence, categorySource: draft.categorySource,
      itemFamily: productFacts?.itemFamily ?? "uncertain", ukShoeSize: productFacts?.ukShoeSize ?? null,
      confirmedForCategoryId: readCategoryConfirmation(draft.dynamicData),
    });
    const aspectReviewNames = reviewPartition.needsReview.map(a => a.name);
    const categoryReasonText = categoryReview.needsReview && categoryReview.reason
      ? `Category: ${draft.categoryName ?? "selected category"} — ${categoryReview.reason}`
      : null;
    const reasonCount = (categoryReasonText ? 1 : 0) + aspectReviewNames.length;
    const contentGeneration = readContentGenerationState(draft.dynamicData, {
      sourceType: draft.sourceType, contentMode: draft.contentMode,
      hasTitle: Boolean(draft.title), hasDescription: Boolean(draft.description),
    });
    const degraded = contentGeneration.state === "fallback" || contentGeneration.state === "failed";
    const packageValue = draft.dynamicData[PACKAGE_SIZE_ASPECT_NAME] as PackageSizeAspectValue | undefined;
    const postageAndPriceReady = Boolean(packageValue?.value && draft.pricePence != null && draft.conditionValue);
    const steps: Array<{ id: EbayEditorStep; label: string; meta: string; complete: boolean }> = [
      { id: 1, label: "Category", meta: draft.categoryName ?? "Not selected", complete: Boolean(draft.categoryId) },
      { id: 2, label: "Item specifics", meta: `${draft.readiness.requiredComplete}/${draft.readiness.requiredTotal} required`, complete: draft.readiness.requiredComplete === draft.readiness.requiredTotal },
      { id: 3, label: "Condition & price", meta: postageAndPriceReady ? "Complete" : "Not complete", complete: postageAndPriceReady },
      { id: 4, label: "Review", meta: reasonCount ? `${reasonCount} to review` : "Ready to review", complete: draft.readiness.ready && reasonCount === 0 },
    ];

    return <><div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !searchOpen) requestClose(); }}>
      <div className="task-modal ebay-details-modal ebay-editor" role="dialog" aria-modal="true" aria-labelledby="ebay-details-title">
        <header className="ebay-editor-header">
          <div className="ebay-editor-title">
            <h2 id="ebay-details-title">eBay listing details</h2>
            <span>{groupTitle}</span>
          </div>
          <ol className="ebay-editor-stepper" aria-label="Listing setup progress">
            {steps.map(step => <li key={step.id} className={activeStep === step.id ? "is-active" : step.complete ? "is-complete" : ""}>
              <button type="button" onClick={() => setActiveStep(step.id)} aria-current={activeStep === step.id ? "step" : undefined}>
                <span className="ebay-editor-step-number">{step.complete ? "✓" : step.id}</span>
                <span>{step.label}</span>
              </button>
            </li>)}
          </ol>
          <button type="button" className="ebay-editor-close" onClick={requestClose} aria-label="Close">×</button>
        </header>

        <div className="ebay-editor-layout">
          <aside className="ebay-editor-sidebar" aria-label="Listing sections">
            {steps.map(step => <button key={step.id} type="button" className={activeStep === step.id ? "is-active" : ""} onClick={() => setActiveStep(step.id)}>
              <span className={`ebay-editor-side-number${step.complete ? " is-complete" : ""}`}>{step.complete ? "✓" : step.id}</span>
              <span><strong>{step.label}</strong><small>{step.meta}</small></span>
            </button>)}
          </aside>

          <main className="ebay-editor-main">
            {actionError && <p className="upload-photo-error" role="alert">{actionError}</p>}
            {usedFixture && <p className="ebay-details-fixture-notice" role="status">Showing local fixture categories — no real eBay credentials are configured, so this is not live eBay data.</p>}

            {activeStep === 1 && <section className="ebay-editor-page" aria-labelledby="ebay-category-heading">
              <div className="ebay-editor-page-heading">
                <div><h3 id="ebay-category-heading">Category</h3><p>Choose the closest eBay category for this product.</p></div>
                <div className="ebay-details-section-actions">
                  <button type="button" className="button-secondary" onClick={suggestCategory} disabled={suggestingCategory}>{suggestingCategory ? "Suggesting…" : "Suggest category"}</button>
                  <button type="button" className="button-secondary" onClick={() => setSearchOpen(true)}>Change category</button>
                </div>
              </div>

              <div className="ebay-editor-card">
                {draft.categoryId ? <div className="ebay-details-category">
                  <p className="ebay-details-category-name">{draft.categoryName}</p>
                  <p className="ebay-details-category-path">{draft.categoryPath}</p>
                  <ConfidenceBadge confidence={categoryReview.effectiveConfidence} needsReview={categoryReview.needsReview} />
                  {categoryReview.provenance === "footwear_size_rule" && requiredDepartment && <span className="ebay-details-empty">Deterministic rule: UK {productFacts?.ukShoeSize} footwear is always {requiredDepartment}&apos;s.</span>}
                </div> : <p className="ebay-details-empty">No category selected yet.</p>}
              </div>

              {categoryReview.needsReview && categoryReview.reason && <div className="ebay-editor-inline-warning">
                <strong>Check this category</strong><span>{categoryReview.reason}</span>
                <div className="ebay-details-section-actions">
                  {categoryReview.provenance === "ai_suggestion" && <button type="button" className="button-secondary" onClick={confirmCategory}>Confirm category</button>}
                  <button type="button" className="button-secondary" onClick={() => setSearchOpen(true)}>Change category</button>
                </div>
              </div>}

              {draft.categoryAlternatives.length > 0 && <div className="ebay-details-alternatives ebay-editor-card">
                <span className="label">Other suggestions</span>
                <ul>{draft.categoryAlternatives.map(alt => <li key={alt.categoryId}>
                  <button type="button" className="ebay-details-alternative-button" onClick={() => chooseCategory(alt.categoryId, draft.title ?? "")}>{alt.categoryName} — {alt.categoryPath}</button>
                </li>)}</ul>
              </div>}

              {searchOpen && <section className="ebay-details-search" role="search">
                <label className="field"><span className="label">Search eBay categories</span><input className="input" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="e.g. Pokémon TCG Elite Trainer Box" /></label>
                <div className="ebay-details-section-actions">
                  <button type="button" className="button" onClick={() => runSearch(searchQuery)} disabled={!searchQuery.trim() || searching}>{searching ? "Searching…" : "Search"}</button>
                  <button type="button" className="button-secondary" onClick={() => { setSearchOpen(false); setSearchResults([]); }}>Cancel</button>
                </div>
                {searchResults.length > 0 && <ul className="ebay-details-search-results">{searchResults.map(result => <li key={result.categoryId}>
                  <button type="button" className="ebay-details-alternative-button" onClick={() => chooseCategory(result.categoryId, searchQuery)}>{result.categoryName} — {result.categoryPath}</button>
                </li>)}</ul>}
              </section>}
            </section>}

            {activeStep === 2 && <section className="ebay-editor-page" aria-labelledby="ebay-specifics-heading">
              <div className="ebay-editor-page-heading">
                <div><h3 id="ebay-specifics-heading">Item specifics</h3><p>Add details about the item. AI suggestions remain fully editable before saving.</p></div>
                <div className="ebay-editor-ai-actions">
                  <button type="button" className="button-secondary" onClick={suggestAspects} disabled={suggestingAspects || !draft.categoryId}>{suggestingAspects ? "Filling…" : hasFilledSpecificsWithAi ? "Refill with AI" : "Fill with AI"}</button>
                </div>
              </div>

              {!draft.categoryId && <div className="ebay-editor-inline-warning"><strong>Choose a category first</strong><span>eBay item specifics depend on the selected category.</span><button type="button" className="button-secondary" onClick={() => setActiveStep(1)}>Go to category</button></div>}
              {aspectsLoadError && !suggestingAspects && <p className="upload-photo-error" role="alert">{aspectsLoadError} Item specifics for this category could not be loaded — this is not the same as &quot;no recommended fields exist&quot;. <button type="button" className="ebay-details-alternative-button" onClick={suggestAspects}>Retry</button></p>}

              {draft.categoryId && !aspectsLoadError && <div className="ebay-editor-specifics">
                {reviewPartition.needsReview.length > 0 && <AspectGroup title="Needs review" className="ebay-aspect-group-needs-review" aspects={reviewPartition.needsReview} values={draft.dynamicData} onSave={saveAspect} focusName={reviewFocus} registerRef={registerFieldRef} />}
                {reviewPartition.required.length > 0 && <AspectGroup title="Required" aspects={reviewPartition.required} values={draft.dynamicData} onSave={saveAspect} registerRef={registerFieldRef} focusName={reviewFocus} />}
                {reviewPartition.recommended.length > 0 && <AspectGroup title="Recommended" aspects={reviewPartition.recommended} values={draft.dynamicData} onSave={saveAspect} registerRef={registerFieldRef} focusName={reviewFocus} />}
                {reviewPartition.optional.length > 0 && <div className="ebay-details-optional">
                  <button type="button" className="ebay-details-optional-toggle" aria-expanded={optionalExpanded} onClick={() => setOptionalExpanded(current => !current)}>{optionalExpanded ? "Hide optional fields" : `Show optional fields (${reviewPartition.optional.length})`}</button>
                  {optionalExpanded && <AspectGroup title="Optional" aspects={reviewPartition.optional} values={draft.dynamicData} onSave={saveAspect} registerRef={registerFieldRef} focusName={reviewFocus} />}
                </div>}
              </div>}
            </section>}

            {activeStep === 3 && <section className="ebay-editor-page" aria-labelledby="ebay-postage-heading">
              <div className="ebay-editor-page-heading"><div><h3 id="ebay-postage-heading">Condition, postage &amp; price</h3><p>Confirm the exact eBay condition, parcel size and selling price for this draft.</p></div></div>
              <ConditionSection options={conditionOptions} value={draft.conditionValue} loadError={conditionLoadError} onSave={saveCondition} />
              <div className="ebay-editor-two-column">
                <PackageSizeSection value={draft.dynamicData[PACKAGE_SIZE_ASPECT_NAME] as PackageSizeAspectValue | undefined} onSave={saveAspect} />
                <PriceSection value={priceInput} purchasePriceText={purchasePriceText} purchasePricePence={purchasePricePence} onChange={stagePrice} />
              </div>
            </section>}

            {activeStep === 4 && <section className="ebay-editor-page" aria-labelledby="ebay-review-heading">
              <div className="ebay-editor-page-heading"><div><h3 id="ebay-review-heading">Review</h3><p>Check the draft before saving and returning to Listing Studio.</p></div></div>
              <div className="ebay-details-readiness" role="status">
                <strong className={degraded ? "ebay-details-status-failed" : "ebay-details-status-ok"}>eBay draft status: {degraded ? "Generation failed" : "Content generated"}</strong>
                {degraded && contentGeneration.message && <p className="ebay-details-empty">{contentGeneration.message}</p>}
                <span className="ebay-details-completeness-label">Required fields: {draft.readiness.requiredComplete}/{draft.readiness.requiredTotal} complete</span>
                <span>{aspectsLoadError ? "Recommended specifics could not be loaded" : `Recommended specifics: ${draft.readiness.recommendedComplete}/${draft.readiness.recommendedTotal} complete`}</span>
                <span className="ebay-details-optimisation-note">(Recommended completion is an optimisation score — it never blocks readiness.)</span>
              </div>
              <section className="ebay-editor-card ebay-details-review-summary" aria-label="Review summary">
                {reasonCount === 0 ? <p className="ebay-details-review-clear">No fields require review.</p> : <>
                  <p className="ebay-details-review-count">{reasonCount} field{reasonCount === 1 ? "" : "s"} need{reasonCount === 1 ? "s" : ""} review</p>
                  <ul className="ebay-details-review-list">
                    {categoryReasonText && <li key="__category"><span>{categoryReasonText}</span><button type="button" className="ebay-details-review-action" onClick={() => setActiveStep(1)}>Review category</button></li>}
                    {aspectReviewNames.map(name => <li key={name}><span>{name}: needs review.</span><button type="button" className="ebay-details-review-action" onClick={() => reviewField(name)}>Review field</button></li>)}
                  </ul>
                  {categoryReview.needsReview && categoryReview.provenance === "ai_suggestion" && <div className="ebay-details-section-actions"><button type="button" className="button-secondary" onClick={confirmCategory}>Confirm category</button><button type="button" className="button-secondary" onClick={() => { setActiveStep(1); setSearchOpen(true); }}>Change category</button></div>}
                  {categoryReview.provenance === "footwear_size_rule_mismatch" && <div className="ebay-details-section-actions"><button type="button" className="button-secondary" onClick={() => { setActiveStep(1); setSearchOpen(true); }}>Change category</button></div>}
                </>}
                {reasonCount === 0 && draft.readiness.ready && <p className="ebay-details-review-clear ebay-details-status-ok">Ready to create an eBay draft.</p>}
                <p className="ebay-details-empty">Status: {draft.readiness.ready && reasonCount === 0 ? "Ready" : "Not yet ready"}</p>
              </section>
              <div className="ebay-editor-review-grid">
                <div className="ebay-editor-card"><span>Category</span><strong>{draft.categoryName ?? "Not selected"}</strong></div>
                <div className="ebay-editor-card"><span>Condition</span><strong>{draft.conditionValue ?? "Not set"}</strong></div>
                <div className="ebay-editor-card"><span>Required specifics</span><strong>{draft.readiness.requiredComplete}/{draft.readiness.requiredTotal}</strong></div>
                <div className="ebay-editor-card"><span>Parcel size</span><strong>{typeof packageValue?.value === "string" ? packageSizeLabels[packageValue.value as keyof typeof packageSizeLabels] : "Not set"}</strong></div>
                <div className="ebay-editor-card"><span>Price</span><strong>{draft.pricePence == null ? "Not set" : `£${formatPenceForInput(draft.pricePence)}`}</strong></div>
              </div>
            </section>}
          </main>
        </div>

        <footer className="ebay-editor-footer">
          <button type="button" className="button-secondary" onClick={() => setActiveStep(step => Math.max(1, step - 1) as EbayEditorStep)} disabled={activeStep === 1}>Back</button>
          <div className="ebay-editor-footer-actions">
            {footerSaveStatus === "saved" && <span className="ebay-details-save-status" role="status">All changes saved</span>}
            {footerSaveStatus === "error" && <span className="upload-photo-error ebay-details-save-status" role="alert">{actionError || "Some changes could not be saved."}</span>}
            <button type="button" className="button" onClick={() => { void saveAllChanges(); }} disabled={footerSaveStatus === "saving"}>{footerSaveStatus === "saving" ? "Saving…" : "Save & close"}</button>
          </div>
        </footer>
      </div>
    </div>
    {confirmingClose && <UnsavedChangesDialog
      saving={footerSaveStatus === "saving"}
      onContinueEditing={() => setConfirmingClose(false)}
      onExitWithoutSaving={onClose}
      onSaveAndExit={() => { void saveAllChanges(); }}
    />}
    </>;
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !searchOpen) requestClose(); }}>
    <div className="task-modal ebay-details-modal" role="dialog" aria-modal="true" aria-labelledby="ebay-details-title">
      <div className="task-modal-heading">
        <h2 id="ebay-details-title">eBay details — {groupTitle}</h2>
        <button type="button" onClick={requestClose} aria-label="Close">×</button>
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
                  const requiredDepartment = requiredFootwearDepartment(productFacts?.itemFamily ?? "uncertain", productFacts?.ukShoeSize ?? null);
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
                    {categoryReview.provenance === "footwear_size_rule" && requiredDepartment && <span className="ebay-details-empty">Deterministic rule: UK {productFacts?.ukShoeSize} footwear is always {requiredDepartment}&apos;s.</span>}
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
          {draft.sourceType === "imported_ebay" && <StockMatchSection
            draftId={draftId}
            defaultQuery={groupTitle}
            purchasePriceText={purchasePriceText}
            purchasePricePence={purchasePricePence}
            onMatched={(pricePence, text) => { setPurchasePricePence(pricePence); setPurchasePriceText(text); }}
          />}
          <PriceSection value={priceInput} purchasePriceText={purchasePriceText} purchasePricePence={purchasePricePence} onChange={stagePrice} />
        </>}
      </div>

      <div className="task-modal-actions">
        {footerSaveStatus === "saved" && <span className="ebay-details-save-status" role="status">Changes saved.</span>}
        {footerSaveStatus === "error" && <span className="upload-photo-error ebay-details-save-status" role="alert">{actionError || "Some changes could not be saved."}</span>}
        <button type="button" className="button" onClick={() => { void saveAllChanges(); }} disabled={footerSaveStatus === "saving"}>{footerSaveStatus === "saving" ? "Saving…" : "Save"}</button>
      </div>
    </div>
  </div>;
}

function StockMatchSection({ draftId, defaultQuery, purchasePriceText, purchasePricePence, onMatched }: {
  draftId: string;
  defaultQuery: string;
  purchasePriceText: string | null;
  purchasePricePence: number | null;
  onMatched: (pricePence: number, text: string) => void;
}) {
  const [open, setOpen] = useState(purchasePricePence === null);
  const [query, setQuery] = useState(defaultQuery);
  const [results, setResults] = useState<InventoryCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/purchase-link?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not search stock.");
      setResults(body.results ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not search stock."); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (open && purchasePricePence === null && !results.length) void search(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function choose(candidate: InventoryCandidate) {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/purchase-link`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseId: candidate.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not match this stock item.");
      onMatched(body.purchasePricePence, `You paid: ${formatPenceAsGBP(body.purchasePricePence)}`);
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not match this stock item."); }
    finally { setLoading(false); }
  }

  return <section className="ebay-details-section" aria-label="Stock purchase match">
    <div className="ebay-details-section-heading">
      <div><span className="label">Stock match</span><p className="ebay-details-empty">Links this imported eBay listing to the item you bought so cost and profit are accurate.</p></div>
      <button type="button" className="button-secondary" onClick={() => setOpen(current => !current)}>{open ? "Hide matches" : purchasePricePence !== null ? "Change match" : "Match stock item"}</button>
    </div>
    {!open && purchasePriceText && <p className={purchasePricePence !== null ? "ebay-price-profit" : "ebay-details-empty"}>{purchasePriceText}</p>}
    {open && <div className="ebay-aspect-group">
      <div className="ebay-price-input-row">
        <input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search in-stock items by name or SKU" />
        <button type="button" className="button-secondary" onClick={search} disabled={loading || !query.trim()}>{loading ? "Searching…" : "Search"}</button>
      </div>
      {error && <p className="upload-photo-error" role="alert">{error}</p>}
      {!loading && results.length === 0 && <p className="ebay-details-empty">No confident in-stock match found. Search using the item name or SKU.</p>}
      {results.map(candidate => <button type="button" className="ebay-details-alternative-button" key={candidate.id} onClick={() => choose(candidate)} disabled={loading}>
        <strong>{candidate.itemDescription}</strong> · {candidate.itemSize || "No size"} · SKU {candidate.sku} · You paid {formatPenceAsGBP(candidate.pricePence)}
      </button>)}
    </div>}
  </section>;
}

function ConditionSection({ options, value, loadError, onSave }: {
  options: EbayConditionOption[];
  value: string | null;
  loadError: string | null;
  onSave: (conditionValue: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const equivalent = options.find(option => option.conditionDescription === value)
    ?? (value === "Used – Very Good" || value === "Used - Very Good"
      ? options.find(option => option.conditionId === "2990")
      : undefined);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function choose(conditionDescription: string) {
    if (!conditionDescription) return;
    setStatus("saving");
    setError(null);
    const result = await onSave(conditionDescription);
    if (result.ok) setStatus("saved");
    else { setStatus("error"); setError(result.error); }
  }

  return <section className="ebay-details-section" aria-label="eBay condition">
    <div className="ebay-details-section-heading"><span className="label">eBay condition</span></div>
    {loadError ? <p className="upload-photo-error" role="alert">{loadError}</p> : <div className="field ebay-aspect-field">
      <span className="label">Condition shown to buyers</span>
      <div className="ebay-condition-options" role="radiogroup" aria-label="Condition shown to buyers">
        {options.map(option => <button
          type="button" role="radio" key={option.conditionId}
          aria-checked={equivalent?.conditionId === option.conditionId}
          className={equivalent?.conditionId === option.conditionId ? "ebay-condition-option is-selected" : "ebay-condition-option"}
          disabled={status === "saving"}
          onClick={() => { void choose(option.conditionDescription); }}
        >{option.conditionDescription}</button>)}
      </div>
      {options.length === 0 && <span className="ebay-details-empty">No condition choices are available until a category is selected.</span>}
      {equivalent?.conditionHelpText && <span className="ebay-details-empty">{equivalent.conditionHelpText}</span>}
      {equivalent?.conditionId === "2990" && <span className="ebay-details-empty">This is eBay UK footwear&apos;s equivalent of Very Good when the item is like new with no visible flaws.</span>}
      {status === "saving" && <span className="ebay-details-empty" role="status">Selecting…</span>}
      {status === "saved" && <span className="ebay-details-empty" role="status">Selected — save and close to apply.</span>}
      {status === "error" && error && <span className="upload-photo-error" role="alert">{error}</span>}
    </div>}
  </section>;
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

function PriceSection({ value, purchasePriceText, purchasePricePence, onChange }: {
  value: string;
  purchasePriceText: string | null;
  purchasePricePence: number | null;
  onChange: (value: string) => void;
}) {
  const parsedPrice = value.trim() ? parsePriceToPence(value) : null;
  const validationMessage = value.trim() && parsedPrice == null ? "Enter a valid price greater than £0.00, e.g. 12.99." : null;
  const profitPence = parsedPrice !== null && purchasePricePence !== null ? parsedPrice - purchasePricePence : null;

  return <section className="ebay-details-section" aria-label="Price">
    <div className="ebay-details-section-heading"><span className="label">Price</span></div>
    {purchasePriceText && <p className="ebay-price-paid">{purchasePriceText}</p>}
    <label className="field ebay-aspect-field" htmlFor="ebay-item-price">
      <span className="label">Item price</span>
      <div className="ebay-price-input-row">
        <span className="ebay-price-currency" aria-hidden="true">£</span>
        <input
          id="ebay-item-price" className="input" type="text" inputMode="decimal"
          value={value} placeholder="0.00" aria-describedby="ebay-item-price-status"
          onChange={event => onChange(event.target.value)}
        />
      </div>
    </label>
    {validationMessage && <p id="ebay-item-price-status" className="upload-photo-error" role="alert">{validationMessage}</p>}
    {!validationMessage && profitPence !== null && <p id="ebay-item-price-status" className={profitPence >= 0 ? "ebay-price-profit" : "ebay-price-loss"} role="status">
      {profitPence >= 0 ? "Profit" : "Loss"}: {formatPenceAsGBP(Math.abs(profitPence))}
    </p>}
    {!validationMessage && profitPence === null && <p id="ebay-item-price-status" className="ebay-details-empty">Profit unavailable until the purchase price and selling price are both known.</p>}
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

function SuggestionMeta({ value, onApprove }: { value: MarketplaceAspectValue | undefined; onApprove: () => void }) {
  if (!value) return null;
  const hasValue = typeof value.value === "string" ? Boolean(value.value.trim()) : Array.isArray(value.value) && value.value.length > 0;
  if (!hasValue) return null;
  if (value.needsReview || value.confidence === "low") return <span className="ebay-suggestion-review">
    <span className="ebay-confidence-badge ebay-confidence-review">Check this suggestion</span>
    <button type="button" className="ebay-suggestion-approve" onClick={onApprove}>Approve suggestion</button>
  </span>;
  if (value.userConfirmed || (!value.appliedAutomatically && value.source === "manual")) return null;
  return <span className="ebay-confidence-badge ebay-confidence-suggested">• Suggested</span>;
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

  const fieldClass = `field ebay-aspect-field${highlighted ? " ebay-aspect-field-review-focus" : ""}`;
  const setRef = (element: HTMLElement | null) => registerRef?.(aspect.name, element);

  if (aspect.mode === "FREE_TEXT") {
    return <div className={fieldClass} ref={setRef}>
      <label>
        <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
        <input className="input" value={draftValue} maxLength={aspect.maxLength ?? undefined} onChange={event => {
          const nextValue = event.target.value;
          setDraftValue(nextValue);
          onSave(aspect.name, nextValue.trim() || null);
        }} />
      </label>
      <SuggestionMeta value={current} onApprove={() => onSave(aspect.name, draftValue.trim() || null)} />
    </div>;
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
      <SuggestionMeta value={current} onApprove={() => onSave(aspect.name, selected.length ? selected : null)} />
    </div>;
  }

  const selectedValue = typeof current?.value === "string" ? current.value : "";
  return <div className={fieldClass} ref={setRef}>
    <label>
      <span className="label">{aspect.name}{aspect.usage === "REQUIRED" && <span className="ebay-aspect-required-mark"> *</span>}</span>
      <select className="input" value={selectedValue} onChange={event => onSave(aspect.name, event.target.value || null)}>
        <option value="">Not provided</option>
        {aspect.allowedValues.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
    <SuggestionMeta value={current} onApprove={() => onSave(aspect.name, selectedValue || null)} />
  </div>;
}
