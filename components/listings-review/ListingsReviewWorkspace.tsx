"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ListingsFilterBar, { type TopTab } from "./ListingsFilterBar";
import ListingsTable, { type ListingTableRow } from "./ListingsTable";
import ListingDetailsPanel, { type ListingDetails } from "./ListingDetailsPanel";
import DraftActivityPanel, { type ActivityEvent, type ActivityBatchFilter } from "./DraftActivityPanel";
import ExtensionBatchGrid, { type BatchBoxViewModel } from "./ExtensionBatchGrid";
import PhotoCarouselDialog from "./PhotoCarouselDialog";
import EditListingFieldsDialog, { type ListingFieldsDraft } from "@/components/listing-studio/EditListingFieldsDialog";
import PreviewListingDialog from "@/components/listing-studio/PreviewListingDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import OverflowMenu from "@/components/listing-studio/OverflowMenu";
import { KpiIcon } from "./KpiIcon";
import {
  computeListingReviewStatus, buildListingWarnings, matchesListingSearch, matchesQuickFilter,
  type ListingQuickFilter, type ReviewableListing,
} from "@/lib/listing-studio/listing-review";
import { computeExtensionWorkflowStatus, WORKFLOW_STATUS_TAB_GROUPS, isBatchStatusTerminal, shouldApplyBatchPollResponse, type ExtensionWorkflowStatus } from "@/lib/listing-studio/extension-workflow-status";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";
import { computeCostPence, computeProfitPence, type SkuPurchaseMatch } from "@/lib/listing-studio/purchase-match";
import { MAX_EXPORT_LISTINGS_PER_BATCH } from "@/lib/listing-studio/vinted-export-schema";
import { MAX_EXTENSION_BATCH_LISTINGS } from "@/lib/listing-studio/extension-batch-schema";

type RejectedExportListing = { draftId: string; sku: string | null; reasons: string[] };

type ExtensionBatchItemStatusRow = {
  itemId: string; draftId: string; queuePosition: number; status: string; attemptCount: number;
  errorCode: string | null; errorMessage: string | null; vintedDraftId: string | null;
  startedAt: string | null; completedAt: string | null;
  // Listings Review redesign — forwarded from the extension's own
  // already-computed local step tracking (see lib/listing-studio/
  // extension-batch-schema.ts's own comment on itemResultRequestSchema).
  currentStep: string | null; detail: string | null;
  generatedTitle: string | null; sku: string | null;
};
type ExtensionBatchStatus = {
  batchId: string; status: string; listingCount: number; displayNumber: number;
  createdAt: string; claimedAt: string | null; expiresAt: string; completedAt: string | null;
  extensionId: string | null; extensionVersion: string | null; browserLabel: string | null;
  boxDismissedAt: string | null; activityDismissedAt: string | null;
  items: ExtensionBatchItemStatusRow[];
};

// Listings Review redesign — one row, the most recent extension-batch-item
// status for this draft across every batch ever sent (see
// rpc/listing_studio_latest_extension_status). Mirrors
// app/api/listing-studio/listings-review/route.ts's own LatestExtensionStatusRow
// (not imported directly — this file already mirrors every other server
// response shape locally, matching the rest of this component).
type LatestExtensionStatusRow = {
  draft_id: string; batch_id: string; batch_status: string; item_status: string; queue_position: number;
  error_code: string | null; error_message: string | null; vinted_draft_id: string | null;
  started_at: string | null; completed_at: string | null; current_step: string | null; step_detail: string | null;
};

type ReviewDraftRow = {
  id: string; created_at: string; updated_at: string;
  // Milestone 6 (Vinted-aware colours/materials): colours/material replace
  // the old free-text colour column.
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; uk_size_source: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  ai_result_json: ListingGenerationFields | null;
  review_marked_ready_at: string | null;
  // Milestone 7 (Vinted category catalogue sync). vinted_category_valid is
  // computed server-side by the listings-review route from a fresh
  // catalogue lookup — never derived client-side from stale data.
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
  vinted_category_valid: boolean;
  vinted_category_status: string | null;
  // Follow-up correction (2026-08-04, extended 2026-08-05).
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_audience_evidence: string[] | null;
  // Milestone 6 (purchase-price lookup and manual Vinted selling price).
  // purchase_match is computed server-side from a batched lookup (never
  // one request per listing) — see app/api/listing-studio/listings-review/route.ts.
  confirmed_price_pence: number | null;
  purchase_match: SkuPurchaseMatch;
  // Listings Review redesign — null when this draft has never been part of
  // any (non-cancelled) extension batch item.
  extension_status: LatestExtensionStatusRow | null;
};
type ReviewImageRow = { id: string; draft_id: string; sort_order: number };
type ReviewData = { drafts: ReviewDraftRow[]; images: ReviewImageRow[] };

// Every field the UI or its derived status/warnings/edited-detection logic
// needs, computed once per listing when the underlying data actually
// changes — never re-derived per render of any child component.
type ListingRow = ListingDetails & ReviewableListing & {
  updatedAt: string; photoIds: string[];
  costPence: number | null; profitPence: number | null;
  extensionStatusSnapshot: LatestExtensionStatusRow | null;
  workflowStatus: ExtensionWorkflowStatus | null;
  queuePosition: number | null;
  currentStep: string | null;
  detail: string | null;
  vintedDraftId: string | null;
  errorMessage: string | null;
};

async function runWithConcurrencyLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    let next: T | undefined;
    while ((next = queue.shift())) await task(next);
  });
  await Promise.all(workers);
}

/**
 * Milestone 5 — the primary place generated listings get reviewed before
 * exporting/auto-listing (not built yet: both bulk actions below are
 * disabled placeholders). Deliberately reuses, rather than reimplements,
 * every piece of Milestone 4 it touches: the same Edit Fields dialog and
 * `/fields` PATCH route, the same Preview dialog (extended, not
 * duplicated — see PreviewListingDialog.tsx's own comment), the same
 * `/images/{id}/view` photo endpoint, and the same single-group DELETE
 * route (called with `mode: "delete_photos"`, since every listing shown
 * here necessarily has photos already). Nothing about grouping, title/
 * description templates, SKU extraction, or size conversion is read or
 * written here at all — this page only ever reads/writes the columns
 * those already produced.
 */
export default function ListingsReviewWorkspace() {
  const [drafts, setDrafts] = useState<ReviewDraftRow[]>([]);
  const [images, setImages] = useState<ReviewImageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  // Listings Review redesign — the 5 top tabs (All/Ready/Needs review/
  // Drafts/Sent) replace the old 4-tab readiness-only switch. "Edited" and
  // "Draft failed" are deliberately NOT top tabs (matching the reference
  // image's exact 5 tabs) but stay reachable — never hidden — via the two
  // booleans below, inside the Filters control.
  const [topTab, setTopTab] = useState<TopTab>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [showEditedOnly, setShowEditedOnly] = useState(false);
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  // Visual-accuracy redesign — "Sent" (in flight: sent/in queue/draft in
  // progress) is no longer its own top tab (the approved reference shows
  // exactly 4 tabs), but stays fully reachable via Filters, same pattern
  // as showEditedOnly/showFailedOnly below.
  const [showSentOnly, setShowSentOnly] = useState(false);
  const [activeQuickFilters, setActiveQuickFilters] = useState<Set<ListingQuickFilter>>(new Set());

  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  // Production-polish pass — the inspector should never sit on a large dead
  // "select a listing" area while real listings are available. Distinct
  // from `selectedListingId` itself so an intentional Close doesn't get
  // immediately re-filled by the very next render: set only by the Close
  // button, cleared by any real selection (a row click, or a fresh manual
  // pick after a filter change). Purely a display-focus flag — never
  // touches bulkSelectedIds, never ticks a checkbox, never writes to the
  // database.
  const [inspectorClosed, setInspectorClosed] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());

  const [editFieldsListingId, setEditFieldsListingId] = useState<string | null>(null);
  const [savingListingFields, setSavingListingFields] = useState(false);
  const [editFieldsError, setEditFieldsError] = useState("");

  const [previewListingId, setPreviewListingId] = useState<string | null>(null);
  const [carouselListingId, setCarouselListingId] = useState<string | null>(null);
  const [carouselInitialPhotoId, setCarouselInitialPhotoId] = useState<string | null>(null);

  const [markingReadyId, setMarkingReadyId] = useState<string | null>(null);
  const [bulkActionRunning, setBulkActionRunning] = useState(false);
  const [bulkActionError, setBulkActionError] = useState("");
  const [bulkActionMessage, setBulkActionMessage] = useState("");
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [assigningCategoryId, setAssigningCategoryId] = useState<string | null>(null);
  const [reassessingAudienceId, setReassessingAudienceId] = useState<string | null>(null);

  // Milestone 7 (revised) — Vinted Draft Export. Exporting produces a ZIP
  // package for manual/assistant-driven transfer into Vinted; it never
  // talks to Vinted itself. exportStep gives the user a truthful sense of
  // progress across the ONE request/response round trip this makes (the
  // server itself does validate -> download/convert photos -> build the
  // ZIP in that order, but there is no server-sent granular progress
  // channel, so these labels track this client's own request lifecycle
  // rather than claiming false precision about server-side sub-steps).
  const [exportRunning, setExportRunning] = useState(false);
  const [exportStep, setExportStep] = useState("");
  const [exportError, setExportError] = useState("");
  const [exportRejected, setExportRejected] = useState<RejectedExportListing[]>([]);

  // Milestone 7 (Chrome extension draft queue), extended for multi-batch
  // support — "Send to extension" creates a short-lived, single-use
  // pairing batch server-side (app/api/listing-studio/extension-batches/
  // route.ts) and then polls its status (a separate, owner-authenticated
  // endpoint — never the bearer-token one the extension itself uses) so
  // this panel shows live progress without the app ever talking to Vinted
  // or the extension directly.
  //
  // Multi-batch support — replaces the old single activeBatchId/
  // pairingCode/batchStatus scalars with per-batch maps, all keyed by the
  // batch's own immutable database id (NEVER its reusable display
  // number). Every batch is independent: creating, polling, cancelling, or
  // dismissing one never reads or writes any other batch's entry.
  const [sendToExtensionRunning, setSendToExtensionRunning] = useState(false);
  const [sendToExtensionError, setSendToExtensionError] = useState("");
  const [sendToExtensionRejected, setSendToExtensionRejected] = useState<RejectedExportListing[]>([]);
  // visibleBatchIds — every batch currently shown in the box grid (i.e.
  // its box hasn't been dismissed). Membership here is the ONLY thing that
  // controls whether a batch is still being polled.
  const [visibleBatchIds, setVisibleBatchIds] = useState<Set<string>>(new Set());
  // batchMetaById — append-only for the whole page session (dismissing a
  // box never removes an entry): the immutable batchId -> its reusable
  // display number and (once known) browser label. This is what lets Live
  // Activity keep attributing old events to the correct batch even after
  // that batch's own box has been dismissed — box-dismissal and
  // activity-dismissal are fully independent (see the requirements this
  // feature was built against).
  const [batchMetaById, setBatchMetaById] = useState<Map<string, { displayNumber: number; browserLabel: string | null }>>(new Map());
  // batchStatusById — the latest poll result for every currently-visible
  // batch; removed only when that batch's box is dismissed (a resumed-but-
  // not-yet-polled, or just-created-but-not-yet-polled, batch is present in
  // visibleBatchIds without yet having an entry here — rendered as a brief
  // "Preparing…" box rather than an empty gap in the grid).
  const [batchStatusById, setBatchStatusById] = useState<Map<string, ExtensionBatchStatus>>(new Map());
  // pairingCodeById — a pairing code is only ever known in plaintext once,
  // in this exact response, to the session that just created the batch
  // (see extension-batches/route.ts's own comment) — never re-fetched, so
  // a batch resumed from an earlier page load simply has no entry here and
  // its box shows "Waiting for the extension to claim this batch…" with no
  // literal code, same graceful degradation the single-batch version had.
  const [pairingCodeById, setPairingCodeById] = useState<Map<string, string>>(new Map());
  // Production-polish pass — a short, self-clearing "Copied" confirmation
  // for whichever batch's pairing-code copy button was just clicked.
  const [codeCopiedBatchId, setCodeCopiedBatchId] = useState<string | null>(null);

  // Listings Review redesign — a session-only projection, never persisted
  // (see DraftActivityPanel.tsx's own comment): one real event per genuine
  // transition observed while polling, newest first.
  //
  // Polish pass — this is now the ONLY place detailed extension progress is
  // ever surfaced on this page. The previous bottom-right toast stack
  // (ExtensionNotifications) was removed entirely: every event it ever
  // showed (draft started/in-progress detail, item drafted, draft failed,
  // batch completed) was already redundant with this panel and the row's
  // own Workflow status/secondary line — see this file's own git history
  // for the removed component. Batch completion, which the toast used to
  // be the ONLY place showing, now gets its own real activity event
  // instead of silently disappearing.
  //
  // Multi-batch support — every event now also carries the batchId it
  // belongs to (see DraftActivityPanel.tsx's own comment on ActivityEvent).
  // activityDismissedBatchIds is the independent "hide this batch's
  // activity" flag (persisted server-side as activity_dismissed_at, seeded
  // from it on resume/poll so a dismissal survives a page refresh even
  // though the events array itself is session-only); activityFilter is the
  // currently-selected Live Activity filter ("all" or one immutable
  // batchId).
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [activityDismissedBatchIds, setActivityDismissedBatchIds] = useState<Set<string>>(new Set());
  const [activityFilter, setActivityFilter] = useState<string>("all");
  // previousItemsByBatchRef holds the PRIOR poll's items PER BATCH, keyed
  // by batchId then itemId — a batch missing from this map means "no poll
  // observed yet for this batch", which deliberately suppresses event
  // synthesis on that batch's very first poll (we can't tell what changed
  // relative to a snapshot we've never seen, so nothing is fabricated —
  // see the polling effect below). completedBatchesLoggedRef is the
  // per-batch equivalent of the old single batchCompletionLoggedRef.
  const previousItemsByBatchRef = useRef<Map<string, Map<string, ExtensionBatchItemStatusRow>>>(new Map());
  const completedBatchesLoggedRef = useRef<Set<string>>(new Set());
  // Mirrors of the two membership sets above, kept in sync via effects
  // just below, so the single perpetual poll loop (which intentionally
  // never restarts just because a batch was added/removed — see that
  // effect's own comment) always reads the CURRENT membership rather than
  // whatever it happened to close over when it last (re)started.
  const visibleBatchIdsRef = useRef<Set<string>>(new Set());
  const batchStatusByIdRef = useRef<Map<string, ExtensionBatchStatus>>(new Map());
  const batchMetaByIdRef = useRef<Map<string, { displayNumber: number; browserLabel: string | null }>>(new Map());
  useEffect(() => { visibleBatchIdsRef.current = visibleBatchIds; }, [visibleBatchIds]);
  useEffect(() => { batchStatusByIdRef.current = batchStatusById; }, [batchStatusById]);
  useEffect(() => { batchMetaByIdRef.current = batchMetaById; }, [batchMetaById]);

  const loadListings = useCallback(async () => {
    try {
      const response = await fetch("/api/listing-studio/listings-review");
      if (!response.ok) { setLoadError("Could not load your listings."); return; }
      const data = await response.json() as ReviewData;
      setDrafts(data.drafts);
      setImages(data.images);
      setLoadError("");
    } catch {
      setLoadError("Could not load your listings. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { loadListings(); }, [loadListings]);

  // Listings Review redesign — root-cause fix: resume tracking every
  // batch that's still genuinely visible (in flight, or terminal but not
  // yet dismissed) from an EARLIER page load (the extension keeps working
  // regardless of whether this tab is open). Runs once, on mount.
  //
  // Multi-batch support — resumes ALL of them, not just one; never
  // overrides a batch this session itself already knows about via
  // handleSendToExtension (a fresh POST always adds its new id, it never
  // clears visibleBatchIds first, so there's nothing here for this effect
  // to clobber even if it runs after a same-session creation).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/listing-studio/extension-batches");
        if (!response.ok || cancelled) return;
        const body = await response.json() as { batchIds: { batchId: string; displayNumber: number }[] };
        if (cancelled || body.batchIds.length === 0) return;
        setVisibleBatchIds(current => {
          const next = new Set(current);
          for (const entry of body.batchIds) next.add(entry.batchId);
          return next;
        });
        setBatchMetaById(current => {
          const next = new Map(current);
          for (const entry of body.batchIds) if (!next.has(entry.batchId)) next.set(entry.batchId, { displayNumber: entry.displayNumber, browserLabel: null });
          return next;
        });
      } catch { /* best-effort — the page still works without resuming */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // One lookup built once per images change, rather than every listing
  // re-filtering/re-sorting the whole array on every render.
  const photoIdsByDraftId = useMemo(() => {
    const map = new Map<string, string[]>();
    const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order);
    for (const image of sorted) {
      const list = map.get(image.draft_id);
      if (list) list.push(image.id); else map.set(image.draft_id, [image.id]);
    }
    return map;
  }, [images]);

  // Status/warnings/edited-ness/cost/profit computed exactly once per
  // listing here — never recomputed by ListingsTable or ListingDetailsPanel
  // themselves. Deliberately does NOT depend on batchStatus (the live
  // 4s-polled extension status) — see the separate listingRows memo below,
  // which layers workflow status on top — so a poll tick that hasn't
  // changed any listing's own data never re-runs this whole pipeline.
  const baseListingRows = useMemo(() => drafts.map(draft => {
    const photoIds = photoIdsByDraftId.get(draft.id) ?? [];
    const reviewable: ReviewableListing = {
      brand: draft.brand, model: draft.model, productType: draft.product_type, colours: draft.colours ?? [], material: draft.material,
      ukSize: draft.uk_size, sku: draft.sku, ukSizeSource: draft.uk_size_source,
      aiResultJson: draft.ai_result_json, reviewMarkedReadyAt: draft.review_marked_ready_at, updatedAt: draft.updated_at,
      vintedCategoryId: draft.vinted_category_id, vintedCategoryValid: draft.vinted_category_valid, vintedCategorySource: draft.vinted_category_source,
      vintedCategoryStatus: draft.vinted_category_status, vintedAudienceSource: draft.vinted_audience_source,
      sellingPricePence: draft.confirmed_price_pence,
      // Follow-up correction (closing the Mark Ready readiness gap) — the
      // remaining ReadinessCheckFields buildListingWarnings/
      // computeListingReviewStatus now also require.
      vintedAudience: draft.vinted_audience,
      generatedTitle: draft.generated_title ?? "", generatedDescription: draft.generated_description ?? "",
      condition: draft.condition, hasPhoto: photoIds.length > 0,
    };
    const costPence = computeCostPence(draft.purchase_match);
    return {
      ...reviewable,
      id: draft.id,
      vintedCategoryPath: draft.vinted_category_path,
      vintedAudienceEvidence: draft.vinted_audience_evidence,
      purchaseMatch: draft.purchase_match,
      status: computeListingReviewStatus(reviewable),
      warnings: buildListingWarnings(reviewable),
      coverPhotoId: photoIds[0] ?? null,
      photoIds,
      costPence,
      profitPence: computeProfitPence(costPence, draft.confirmed_price_pence),
      extensionStatusSnapshot: draft.extension_status,
    };
  }), [drafts, photoIdsByDraftId]);

  // Multi-batch support — one draft can appear in AT MOST one genuinely
  // live (non-terminal) batch at a time (enforced atomically server-side
  // by rpc/listing_studio_create_extension_batch), but its item can still
  // be present in an OLDER, now-terminal batch this session is still
  // displaying (its box not yet dismissed) if the draft was resent after
  // that earlier attempt finished. A live batch's item always wins over a
  // terminal one; among same-terminality candidates (which in practice
  // only ever means two terminal ones), the more recently created batch
  // wins — the freshest real attempt, never a stale one.
  const liveItemByDraftId = useMemo(() => {
    const map = new Map<string, { item: ExtensionBatchItemStatusRow; batch: ExtensionBatchStatus }>();
    for (const batch of batchStatusById.values()) {
      for (const item of batch.items) {
        const existing = map.get(item.draftId);
        if (!existing) { map.set(item.draftId, { item, batch }); continue; }
        const existingLive = !isBatchStatusTerminal(existing.batch.status);
        const candidateLive = !isBatchStatusTerminal(batch.status);
        if (candidateLive && !existingLive) { map.set(item.draftId, { item, batch }); continue; }
        if (candidateLive === existingLive && new Date(batch.createdAt).getTime() > new Date(existing.batch.createdAt).getTime()) {
          map.set(item.draftId, { item, batch });
        }
      }
    }
    return map;
  }, [batchStatusById]);

  // Layers real-time workflow status on top of the base rows: the LIVE
  // batch item for this draft wins when present (freshest — updates every
  // 4s poll), otherwise the page-load historical aggregate
  // (extensionStatusSnapshot) is used, so status stays correct even after
  // every batch this session knew about is dismissed, or on a page that
  // never had one this session. Only this small mapping re-runs on a poll
  // tick, never the full baseListingRows pipeline above.
  const listingRows: ListingRow[] = useMemo(() => baseListingRows.map(row => {
    const live = liveItemByDraftId.get(row.id);
    const workflowStatus = live
      ? computeExtensionWorkflowStatus(live.item.status, live.batch.status)
      : row.extensionStatusSnapshot
        ? computeExtensionWorkflowStatus(row.extensionStatusSnapshot.item_status, row.extensionStatusSnapshot.batch_status)
        : null;
    // Visual-accuracy redesign — the same live-first-else-aggregate
    // precedence workflowStatus itself already uses, extended to the
    // fields a truthful secondary line needs (position/step/detail/draft
    // id/error). One source of truth (computeWorkflowSecondaryLine) reads
    // these identically in the table and the inspector.
    const queuePosition = live ? live.item.queuePosition : row.extensionStatusSnapshot?.queue_position ?? null;
    const currentStep = live ? live.item.currentStep : row.extensionStatusSnapshot?.current_step ?? null;
    const detail = live ? live.item.detail : row.extensionStatusSnapshot?.step_detail ?? null;
    const vintedDraftId = live ? live.item.vintedDraftId : row.extensionStatusSnapshot?.vinted_draft_id ?? null;
    const errorMessage = live ? live.item.errorMessage : row.extensionStatusSnapshot?.error_message ?? null;
    return { ...row, workflowStatus, queuePosition, currentStep, detail, vintedDraftId, errorMessage };
  }), [baseListingRows, liveItemByDraftId]);

  const listingsById = useMemo(() => new Map(listingRows.map(row => [row.id, row])), [listingRows]);

  const categoryOptions = useMemo(() => {
    const values = new Set(listingRows.map(row => row.productType).filter((value): value is string => Boolean(value)));
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [listingRows]);

  // Readiness (Ready/Needs review) and extension workflow (Drafts/Sent)
  // are deliberately separate concepts, per WORKFLOW_STATUS_TAB_GROUPS —
  // never merged into one count. "Ready" includes "edited" (both pass
  // every readiness rule; "edited" just hasn't been re-confirmed since a
  // change), matching this page's own existing readiness definition.
  const readyCount = useMemo(() => listingRows.filter(row => row.status !== "needs_review").length, [listingRows]);
  const needsReviewCount = useMemo(() => listingRows.filter(row => row.status === "needs_review").length, [listingRows]);
  const draftsCount = useMemo(() => listingRows.filter(row => row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.drafts as string[]).includes(row.workflowStatus)).length, [listingRows]);
  const sentCount = useMemo(() => listingRows.filter(row => row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.sent as string[]).includes(row.workflowStatus)).length, [listingRows]);
  const failedCount = useMemo(() => listingRows.filter(row => row.workflowStatus === "failed").length, [listingRows]);
  // Visual-accuracy redesign — the 4th KPI card. Real, persisted extension-
  // item state (preparing/filling/saving), never a client-only guess.
  const draftingCount = useMemo(() => listingRows.filter(row => row.workflowStatus === "in_progress").length, [listingRows]);

  const filtersActive = topTab !== "all" || categoryFilter !== "all" || activeQuickFilters.size > 0 || showEditedOnly || showFailedOnly || showSentOnly || searchQuery.trim().length > 0;
  const clearFilters = useCallback(() => {
    setTopTab("all"); setCategoryFilter("all"); setActiveQuickFilters(new Set());
    setShowEditedOnly(false); setShowFailedOnly(false); setShowSentOnly(false); setSearchQuery("");
  }, []);

  const filteredRows = useMemo(() => listingRows.filter(row => {
    if (topTab === "ready" && row.status === "needs_review") return false;
    if (topTab === "needs_review" && row.status !== "needs_review") return false;
    if (topTab === "drafted" && row.workflowStatus !== "drafted") return false;
    if (categoryFilter !== "all" && row.productType !== categoryFilter) return false;
    if (showEditedOnly && row.status !== "edited") return false;
    if (showFailedOnly && row.workflowStatus !== "failed") return false;
    if (showSentOnly && !(row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.sent as string[]).includes(row.workflowStatus))) return false;
    for (const filter of activeQuickFilters) if (!matchesQuickFilter(row, filter)) return false;
    return matchesListingSearch({ generatedTitle: row.generatedTitle, sku: row.sku, brand: row.brand, model: row.model, colours: row.colours }, searchQuery);
  }), [listingRows, topTab, categoryFilter, showEditedOnly, showFailedOnly, showSentOnly, activeQuickFilters, searchQuery]);

  const selectedListingPosition = useMemo(() => {
    const index = filteredRows.findIndex(row => row.id === selectedListingId);
    return index === -1 ? null : { index, total: filteredRows.length };
  }, [filteredRows, selectedListingId]);

  // Production-polish pass — on initial load, and after any search/filter
  // change, keep the inspector showing something whenever listings are
  // visible: retain the current selection if it's still in the filtered
  // set, otherwise fall back to the first visible listing. Skipped
  // entirely once the user has explicitly closed the inspector (Close
  // button), and never fires while nothing is filtered in (the existing
  // empty state is left exactly as-is). Inspector focus ONLY — never
  // selects a bulk checkbox, marks anything ready, or writes anywhere.
  useEffect(() => {
    if (inspectorClosed) return;
    if (filteredRows.length === 0) return;
    const stillVisible = selectedListingId !== null && filteredRows.some(row => row.id === selectedListingId);
    if (!stillVisible) setSelectedListingId(filteredRows[0].id);
  }, [filteredRows, selectedListingId, inspectorClosed]);

  const selectListing = useCallback((id: string) => {
    setInspectorClosed(false);
    setSelectedListingId(id);
  }, []);
  const closeInspector = useCallback(() => {
    setInspectorClosed(true);
    setSelectedListingId(null);
  }, []);

  const tableRows: ListingTableRow[] = filteredRows;
  const selectedListing = selectedListingId ? listingsById.get(selectedListingId) ?? null : null;
  const carouselListing = carouselListingId ? listingsById.get(carouselListingId) ?? null : null;
  const previewListing = previewListingId ? listingsById.get(previewListingId) ?? null : null;
  const editFieldsListing = editFieldsListingId ? listingsById.get(editFieldsListingId) ?? null : null;

  const toggleQuickFilter = useCallback((filter: ListingQuickFilter) => {
    setActiveQuickFilters(current => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter); else next.add(filter);
      return next;
    });
  }, []);

  const toggleBulkSelect = useCallback((id: string) => {
    setBulkSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setBulkSelectedIds(current => {
      const visibleIds = filteredRows.map(row => row.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => current.has(id));
      if (allSelected) {
        const next = new Set(current);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...current, ...visibleIds]);
    });
  }, [filteredRows]);

  const openCarousel = useCallback((listingId: string, initialPhotoId?: string) => {
    setCarouselListingId(listingId);
    setCarouselInitialPhotoId(initialPhotoId ?? null);
  }, []);

  // Milestone 6 (purchase-price lookup and manual Vinted selling price) —
  // SellingPriceField itself already did the network round-trip and
  // parsed the authoritative server response; this just reflects the
  // already-saved pence value into local state so the "Missing selling
  // price" warning/status/quick-filter recompute immediately, with no
  // extra fetch.
  const handleSellingPriceSaved = useCallback((listingId: string, pence: number) => {
    setDrafts(current => current.map(draft => draft.id === listingId ? { ...draft, confirmed_price_pence: pence, updated_at: new Date().toISOString() } : draft));
  }, []);

  async function handleMarkReady(listingId: string) {
    setMarkingReadyId(listingId);
    setBulkActionError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/mark-ready`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not mark this listing ready."); return; }
      setDrafts(current => current.map(draft => draft.id === listingId ? { ...draft, review_marked_ready_at: body.reviewMarkedReadyAt } : draft));
    } catch {
      setBulkActionError("Network error — could not mark this listing ready.");
    } finally {
      setMarkingReadyId(null);
    }
  }

  // Follow-up correction (2026-08-04) — "Assign category" retry action.
  // Uses only this listing's already-stored structured fields: no photo
  // reanalysis, no title/description regeneration, no other field changes.
  async function handleAssignCategory(listingId: string) {
    setAssigningCategoryId(listingId);
    setBulkActionError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/assign-category`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not assign a category to this listing."); return; }
      setDrafts(current => current.map(draft => draft.id === listingId ? {
        ...draft,
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus, vinted_category_valid: body.vintedCategoryId !== null,
        // Follow-up correction (2026-08-05): this route now also tries a
        // cheap, text-only audience reassessment before giving up — reflect
        // whatever audience it ended up with (unchanged when protected as
        // manual, or when nothing improved it).
        vinted_audience: body.vintedAudience, vinted_audience_evidence: body.vintedAudienceEvidence,
        updated_at: new Date().toISOString(),
      } : draft));
    } catch {
      setBulkActionError("Network error — could not assign a category to this listing.");
    } finally {
      setAssigningCategoryId(null);
    }
  }

  // Follow-up correction (2026-08-05) — the explicit, cost-warned
  // "Reassess audience" action: re-sends this listing's actual stored
  // photos to Claude specifically to look for audience evidence. Real AI
  // cost, so it is never triggered automatically — only from this
  // deliberate click, after the user confirms the cost warning.
  async function handleReassessAudience(listingId: string) {
    if (!window.confirm("Reassess audience from photos? This sends this listing's photos to the AI again and has a small AI cost.")) return;
    setReassessingAudienceId(listingId);
    setBulkActionError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/reassess-audience`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not reassess this listing's audience."); return; }
      if (!body.attempted) { setBulkActionMessage(body.message || "This listing's audience is already manually set."); return; }
      setDrafts(current => current.map(draft => draft.id === listingId ? {
        ...draft,
        vinted_audience: body.vintedAudience, vinted_audience_source: "ai", vinted_audience_evidence: body.vintedAudienceEvidence,
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus, vinted_category_valid: body.vintedCategoryId !== null,
        updated_at: new Date().toISOString(),
      } : draft));
    } catch {
      setBulkActionError("Network error — could not reassess this listing's audience.");
    } finally {
      setReassessingAudienceId(null);
    }
  }

  // Follow-up correction (2026-08-04) — "Assign missing categories" bulk
  // action. ONE HTTP request for every selected listing (never one
  // request per listing — the server itself is concurrency-bounded), then
  // a full reload so every row (including fresh category-validity checks)
  // reflects the server's own final state rather than being patched
  // piecemeal client-side.
  async function handleBulkAssignCategories() {
    const ids = [...bulkSelectedIds];
    if (!ids.length) return;
    setBulkActionRunning(true);
    setBulkActionError("");
    setBulkActionMessage("");
    try {
      const response = await fetch("/api/listing-studio/listings-review/assign-categories", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not assign categories to these listings."); return; }
      const s = body.summary;
      const parts = [
        `${s.deterministicCount} assigned deterministically`, `${s.aiAssignedCount} assigned using AI`,
        `${s.audienceRequiredCount} need an audience`, `${s.noMatchCount} had no match`,
      ];
      if (s.failedCount > 0) parts.push(`${s.failedCount} failed`);
      if (s.skippedCount > 0) parts.push(`${s.skippedCount} already had a manual category`);
      const costSuffix = s.estimatedCostUsd !== null ? ` Estimated AI cost: $${s.estimatedCostUsd.toFixed(4)}.` : "";
      setBulkActionMessage(`${parts.join(", ")}.${costSuffix}`);
      await loadListings();
    } catch {
      setBulkActionError("Network error — could not assign categories to these listings.");
    } finally {
      setBulkActionRunning(false);
    }
  }

  // Milestone 6 (purchase-price lookup and manual Vinted selling price)
  // follow-up: still one independent POST per selected listing (each call
  // re-validates that ONE listing's price/category fresh from the
  // database — see mark-ready/route.ts's own comment, "never trust the
  // browser's warning state" applies per-listing here too), but now
  // collects and groups every skip REASON (the route's own error message)
  // instead of only a blind count, so the summary says what actually
  // blocked each listing.
  async function handleBulkMarkReady() {
    const ids = [...bulkSelectedIds];
    if (!ids.length) return;
    setBulkActionRunning(true);
    setBulkActionError("");
    setBulkActionMessage("");
    let succeededCount = 0;
    const skipReasonCounts = new Map<string, number>();
    await runWithConcurrencyLimit(ids, 5, async id => {
      try {
        const response = await fetch(`/api/listing-studio/groups/${id}/mark-ready`, { method: "POST" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          // Follow-up correction (closing the Mark Ready readiness gap):
          // the route now returns a real `warnings` array (one entry per
          // genuinely missing/invalid thing — Missing SKU, No uploaded
          // photos, etc.) — tallying each one individually across the
          // whole batch is far more useful than grouping by the full
          // joined error string, which would fragment into a separate
          // bucket for every distinct COMBINATION of missing fields.
          const reasons: string[] = Array.isArray(body.warnings) && body.warnings.length ? body.warnings : [body.error || "Could not be marked ready"];
          for (const reason of reasons) skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
          return;
        }
        succeededCount += 1;
        setDrafts(current => current.map(draft => draft.id === id ? { ...draft, review_marked_ready_at: body.reviewMarkedReadyAt } : draft));
      } catch {
        skipReasonCounts.set("Network error", (skipReasonCounts.get("Network error") ?? 0) + 1);
      }
    });
    const skippedCount = ids.length - succeededCount;
    if (skippedCount > 0) {
      const reasonParts = [...skipReasonCounts.entries()].map(([reason, count]) => `${reason} (${count})`);
      setBulkActionError(`${succeededCount} marked ready, ${skippedCount} skipped: ${reasonParts.join(", ")}.`);
    } else {
      setBulkActionMessage(`${succeededCount} listing${succeededCount === 1 ? "" : "s"} marked ready.`);
    }
    setBulkSelectedIds(new Set());
    setBulkActionRunning(false);
  }

  // Milestone 7 (revised) — "Save to Vinted drafts" is now "Export": builds
  // a ZIP of one or more selected Ready listings (photos + structured
  // data) for a human, or another assistant driving a real logged-in
  // browser, to manually transfer into Vinted and save as a Vinted draft
  // themselves. This never publishes, lists, or uploads anything, and
  // never talks to Vinted at all — see app/api/listing-studio/listings-review/export/route.ts's
  // own top comment. The current selection is deliberately NEVER cleared
  // on failure (only on a genuine successful download) so the user can
  // fix/deselect the reported listing(s) and retry without re-picking
  // everything else.
  async function handleExport() {
    const ids = [...bulkSelectedIds];
    if (!ids.length || exportRunning) return;
    if (ids.length > MAX_EXPORT_LISTINGS_PER_BATCH) {
      setExportError(`Select at most ${MAX_EXPORT_LISTINGS_PER_BATCH} listings to export at once (${ids.length} selected).`);
      setExportRejected([]);
      return;
    }
    setExportRunning(true);
    setExportError("");
    setExportRejected([]);
    setExportStep("Validating listings…");
    try {
      setExportStep("Preparing photos and creating package…");
      const response = await fetch("/api/listing-studio/listings-review/export", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setExportError(body.error || "Could not export these listings.");
        setExportRejected(Array.isArray(body.rejected) ? body.rejected : []);
        return;
      }

      setExportStep("Downloading…");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "vinted-drafts.zip";

      // Standard client-side "trigger a file save" pattern — an anchor
      // with a blob object URL, clicked programmatically then discarded.
      // The server response IS the ZIP bytes already fully generated; this
      // only hands them to the browser's own download mechanism.
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);

      setBulkActionMessage(`Exported ${ids.length} listing${ids.length === 1 ? "" : "s"} to ${fileName}.`);
      setBulkSelectedIds(new Set());
    } catch {
      setExportError("Network error — could not export these listings. Your selection has been kept.");
    } finally {
      setExportRunning(false);
      setExportStep("");
    }
  }

  // Milestone 7 (Chrome extension draft queue), extended for multi-batch
  // support — "Send to extension" always creates a NEW, fully independent
  // batch; it never checks for (let alone cancels) any other batch already
  // in flight. This only ever CREATES the batch and shows the pairing
  // code; nothing about form-filling or Vinted itself happens here — that
  // is entirely the extension's own job, running in the user's normal
  // browser profile, once they enter the code. Never clears the current
  // selection on failure, same reasoning as handleExport above.
  // Listings Review redesign — idsOverride lets the inspector's contextual
  // "Send to extension"/"Resend to extension" button reuse this EXACT
  // function for a single listing, never a second batch-creation path.
  // Every existing call site (the sticky bar, with no argument) keeps
  // reading from bulkSelectedIds exactly as before.
  async function handleSendToExtension(idsOverride?: string[]) {
    const ids = idsOverride ?? [...bulkSelectedIds];
    if (!ids.length || sendToExtensionRunning) return;
    if (ids.length > MAX_EXTENSION_BATCH_LISTINGS) {
      setSendToExtensionError(`Select at most ${MAX_EXTENSION_BATCH_LISTINGS} listings to send to the extension at once (${ids.length} selected).`);
      setSendToExtensionRejected([]);
      return;
    }
    setSendToExtensionRunning(true);
    setSendToExtensionError("");
    setSendToExtensionRejected([]);
    try {
      const response = await fetch("/api/listing-studio/extension-batches", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSendToExtensionError(body.error || "Could not send these listings to the extension.");
        setSendToExtensionRejected(Array.isArray(body.rejected) ? body.rejected : []);
        return;
      }
      const batchId: string = body.batchId;
      setVisibleBatchIds(current => new Set(current).add(batchId));
      setBatchMetaById(current => new Map(current).set(batchId, { displayNumber: body.displayNumber, browserLabel: null }));
      setPairingCodeById(current => new Map(current).set(batchId, body.pairingCode));
      setCodeCopiedBatchId(null);
    } catch {
      setSendToExtensionError("Network error — could not send these listings to the extension. Your selection has been kept.");
    } finally {
      setSendToExtensionRunning(false);
    }
  }

  // Multi-batch support — requires the exact immutable batch id; cancels
  // ONLY that one batch. Leaves every other batch's state completely
  // untouched — there is no "cancel the user's current batch" concept
  // anywhere in this file anymore.
  const handleCancelBatch = useCallback(async (batchId: string) => {
    await fetch(`/api/listing-studio/extension-batches/${batchId}`, { method: "DELETE" }).catch(() => {});
  }, []);

  // Production-polish pass — copies one specific batch's real pairing code
  // to the clipboard; the short "Copied" confirmation self-clears so it
  // can never linger and be mistaken for a permanent label.
  const handleCopyPairingCode = useCallback(async (batchId: string) => {
    const code = pairingCodeById.get(batchId);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopiedBatchId(batchId);
      window.setTimeout(() => setCodeCopiedBatchId(current => (current === batchId ? null : current)), 1600);
    } catch { /* clipboard access denied — the code remains visible/selectable regardless */ }
  }, [pairingCodeById]);

  // Multi-batch support — the "×" on a batch box. Only ever offered once a
  // batch is genuinely terminal (see ExtensionBatchGrid.tsx) — dismisses
  // that batch's box (server-side, via box_dismissed_at) and drops it from
  // local box-grid state; its history/results are never deleted.
  //
  // Follow-up correction (combined terminal dismissal) — this now ALSO
  // dismisses that SAME batch's Live Activity (activityDismissedBatchIds
  // + resetting the selected filter back to "All" if it was selected),
  // mirroring the server's own combined box_dismissed_at +
  // activity_dismissed_at UPDATE (see that route's own comment). This is
  // required so a display number can never be reallocated to a brand-new
  // batch while its OLD activity is still visible under the same "Batch
  // N" label — the exact duplicate-filter-button bug this closes.
  // Dismissing activity ALONE (handleDismissBatchActivity, below) still
  // never touches the box — only this direction is now coupled.
  const handleDismissBatchBox = useCallback(async (batchId: string) => {
    setVisibleBatchIds(current => { const next = new Set(current); next.delete(batchId); return next; });
    setBatchStatusById(current => { const next = new Map(current); next.delete(batchId); return next; });
    setPairingCodeById(current => { const next = new Map(current); next.delete(batchId); return next; });
    setActivityDismissedBatchIds(current => new Set(current).add(batchId));
    setActivityFilter(current => (current === batchId ? "all" : current));
    await fetch(`/api/listing-studio/extension-batches/${batchId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss_box" }),
    }).catch(() => {});
  }, []);

  // Multi-batch support — "Dismiss Batch N activity". Hides only this
  // batch's own rows from Live Activity (both "All" and its own filter
  // button disappear) and returns the selected filter to "All" if it was
  // the one just dismissed — never cancels the batch, never touches its
  // box, never deletes anything server-side (activity_dismissed_at is a
  // soft flag, same convention as box_dismissed_at). Applied optimistically
  // client-side (there's nothing to wait on — this is purely a display
  // preference) and persisted best-effort so it survives a page refresh.
  const handleDismissBatchActivity = useCallback((batchId: string) => {
    setActivityDismissedBatchIds(current => new Set(current).add(batchId));
    setActivityFilter(current => (current === batchId ? "all" : current));
    fetch(`/api/listing-studio/extension-batches/${batchId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss_activity" }),
    }).catch(() => {});
  }, []);

  // Multi-batch support — ONE owner-scoped poll loop drives every visible
  // batch (never one timer/subscription per batch — see this feature's own
  // "avoid per-batch timers" requirement). Each tick fetches every
  // currently-tracked, not-yet-known-terminal batch's status in parallel,
  // then applies each result independently: creating Batch 2 never resets
  // or interferes with Batch 1's own polling, and a batch that reaches a
  // terminal status simply stops being included in the NEXT tick's fetch
  // set (its box stays visible with its last-known status until
  // dismissed) — the per-batch equivalent of the old single-batch
  // "stops itself once terminal" behaviour.
  //
  // The loop itself only starts/stops based on whether there is anything
  // to poll at all (hasVisibleBatches) — it deliberately does NOT restart
  // every time a batch is added or removed while already running (that
  // would reset every other in-flight batch's own 4s cadence for no
  // reason); instead it always reads the CURRENT membership via the refs
  // mirrored just above on every tick.
  //
  // Listings Review redesign — this same poll tick also derives
  // activityEvents by DIFFING each batch's previous poll items against its
  // new ones (never a second fetch, never a second interval, never a
  // second timer per batch). Only a genuinely observed transition ever
  // produces an event: a batch's FIRST poll only seeds
  // previousItemsByBatchRef for that batch (plus one real "sent" event,
  // timestamped with the batch's own real createdAt) and never synthesizes
  // anything else, since there is nothing yet to compare against — this is
  // what keeps a page reload mid-batch, or simply the initial load, from
  // fabricating a history it never actually observed.
  const hasVisibleBatches = visibleBatchIds.size > 0;
  useEffect(() => {
    if (!hasVisibleBatches) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // Final-item sync fix — a monotonic sequence number per poll CYCLE
    // (one cycle = one parallel fetch of every tracked batch). The loop
    // below is sequential by construction (the next cycle is only ever
    // scheduled after this one has been fully applied), so this only ever
    // matters against some other, future source of an out-of-order
    // response — never lets an older cycle's results overwrite a newer,
    // already-applied one (see shouldApplyBatchPollResponse).
    let issuedSeq = 0;
    let appliedSeq = 0;

    function applyBatchResult(batchId: string, body: ExtensionBatchStatus) {
      setBatchStatusById(current => new Map(current).set(batchId, body));
      setBatchMetaById(current => {
        const existing = current.get(batchId);
        if (existing && existing.browserLabel === body.browserLabel && existing.displayNumber === body.displayNumber) return current;
        const next = new Map(current);
        next.set(batchId, { displayNumber: body.displayNumber, browserLabel: body.browserLabel });
        return next;
      });
      if (body.activityDismissedAt) setActivityDismissedBatchIds(current => (current.has(batchId) ? current : new Set(current).add(batchId)));

      const displayNumber = batchMetaByIdRef.current.get(batchId)?.displayNumber ?? body.displayNumber;
      const batchLabel = `Batch ${displayNumber}`;
      const browserLabel = body.browserLabel;

      const previousItems = previousItemsByBatchRef.current.get(batchId) ?? null;
      if (previousItems === null) {
        setActivityEvents(current => [
          { id: `${body.batchId}:sent`, batchId, batchLabel, browserLabel, tone: "sent", message: `${body.items.length} listing${body.items.length === 1 ? "" : "s"} sent to extension`, timestampIso: body.createdAt },
          ...current,
        ]);
      } else {
        const newEvents: ActivityEvent[] = [];
        const updatedDetailByEventId = new Map<string, string | null>();
        for (const item of body.items) {
          const prev = previousItems.get(item.itemId);
          if (!prev) continue;
          const label = item.generatedTitle || item.sku || "Listing";
          const isInProgress = item.status === "preparing" || item.status === "filling" || item.status === "saving";
          const wasInProgress = prev.status === "preparing" || prev.status === "filling" || prev.status === "saving";

          if (isInProgress && !wasInProgress) {
            newEvents.push({ id: `${item.itemId}:started`, batchId, batchLabel, browserLabel, tone: "progress", message: `${label} — draft started`, detail: item.detail, timestampIso: item.startedAt ?? new Date().toISOString() });
          } else if (isInProgress && wasInProgress && (item.currentStep !== prev.currentStep || item.detail !== prev.detail)) {
            updatedDetailByEventId.set(`${item.itemId}:started`, item.detail);
          }

          if (item.status === "completed" && prev.status !== "completed") {
            newEvents.push({ id: `${item.itemId}:completed`, batchId, batchLabel, browserLabel, tone: "success", message: `${label} saved successfully`, timestampIso: item.completedAt ?? new Date().toISOString() });
          }
          if (item.status === "failed" && prev.status !== "failed") {
            newEvents.push({ id: `${item.itemId}:failed`, batchId, batchLabel, browserLabel, tone: "failure", message: `${label} — draft failed: ${item.errorMessage ?? "Unknown error"}`, timestampIso: item.completedAt ?? new Date().toISOString() });
          }
          if (item.attemptCount > prev.attemptCount && prev.attemptCount > 0) {
            newEvents.push({ id: `${item.itemId}:retry-${item.attemptCount}`, batchId, batchLabel, browserLabel, tone: "progress", message: `${label} — retry started`, timestampIso: new Date().toISOString() });
          }
        }
        if (newEvents.length > 0 || updatedDetailByEventId.size > 0) {
          setActivityEvents(current => {
            const withUpdatedDetail = updatedDetailByEventId.size > 0
              ? current.map(event => updatedDetailByEventId.has(event.id) ? { ...event, detail: updatedDetailByEventId.get(event.id) ?? null } : event)
              : current;
            return newEvents.length > 0 ? [...newEvents, ...withUpdatedDetail] : withUpdatedDetail;
          });
        }
      }
      previousItemsByBatchRef.current.set(batchId, new Map(body.items.map(item => [item.itemId, item])));

      // Polish pass — batch completion used to be shown ONLY via the now-
      // removed toast; it now gets a real Live Activity event instead of
      // silently disappearing. Fires at most once per batch (guarded by
      // the per-batch completedBatchesLoggedRef set), so re-polling an
      // already-completed batch never re-adds it.
      if (body.status === "completed" && !completedBatchesLoggedRef.current.has(batchId)) {
        completedBatchesLoggedRef.current.add(batchId);
        const savedCount = body.items.filter(item => item.status === "completed").length;
        setActivityEvents(current => [
          { id: `${body.batchId}:batch-complete`, batchId, batchLabel, browserLabel, tone: "success", message: `Batch completed — ${savedCount} item${savedCount === 1 ? "" : "s"} saved to Vinted drafts`, timestampIso: body.completedAt ?? new Date().toISOString() },
          ...current,
        ]);
      }
    }

    async function poll() {
      const seq = ++issuedSeq;
      // Final-item sync fix, generalised — every batch not yet KNOWN to be
      // terminal is polled again this cycle, including a batch this cycle
      // hasn't yet reconciled a terminal response for. A batch already
      // reflected as terminal in batchStatusByIdRef is skipped — its box
      // keeps showing that last-applied status until dismissed.
      const idsToPoll = [...visibleBatchIdsRef.current].filter(id => {
        const known = batchStatusByIdRef.current.get(id);
        return !known || !isBatchStatusTerminal(known.status);
      });
      if (idsToPoll.length === 0) { if (!cancelled) timeoutId = setTimeout(poll, 4000); return; }

      const results = await Promise.all(idsToPoll.map(async id => {
        try {
          const response = await fetch(`/api/listing-studio/extension-batches/${id}`);
          if (!response.ok) return { id, ok: false as const, status: response.status };
          return { id, ok: true as const, body: await response.json() as ExtensionBatchStatus };
        } catch { return { id, ok: false as const, status: 0 }; }
      }));
      if (cancelled) return;
      if (!shouldApplyBatchPollResponse(appliedSeq, seq)) return;
      appliedSeq = seq;

      for (const result of results) {
        if (!result.ok) {
          // Genuinely gone (404 — deleted, or a resumed batch that expired
          // between the resume check and this poll) rather than a
          // transient error: drop ONLY that batch from tracking instead of
          // leaving stale pairing-code/status state displayed forever with
          // no way for the UI to recover on its own. Every other batch's
          // own result this same cycle is applied normally regardless.
          if (result.status === 404) {
            setVisibleBatchIds(current => { const next = new Set(current); next.delete(result.id); return next; });
            setBatchStatusById(current => { const next = new Map(current); next.delete(result.id); return next; });
            setPairingCodeById(current => { const next = new Map(current); next.delete(result.id); return next; });
          }
          // Any other failure (network blip, 5xx) is transient — this one
          // batch simply gets retried next cycle, same as before.
          continue;
        }
        applyBatchResult(result.id, result.body);
      }

      if (!cancelled) timeoutId = setTimeout(poll, 4000);
    }
    poll();
    return () => { cancelled = true; if (timeoutId !== undefined) clearTimeout(timeoutId); };
  }, [hasVisibleBatches]);

  async function commitDelete(ids: string[]) {
    setBulkActionRunning(true);
    setBulkActionError("");
    let failureCount = 0;
    await runWithConcurrencyLimit(ids, 5, async id => {
      try {
        const response = await fetch(`/api/listing-studio/groups/${id}`, {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "delete_photos" }),
        });
        if (!response.ok) { failureCount += 1; return; }
        setDrafts(current => current.filter(draft => draft.id !== id));
        setImages(current => current.filter(image => image.draft_id !== id));
      } catch { failureCount += 1; }
    });
    if (failureCount > 0) setBulkActionError(`${failureCount} of ${ids.length} listing${ids.length === 1 ? "" : "s"} could not be deleted.`);
    setBulkSelectedIds(current => { const next = new Set(current); for (const id of ids) next.delete(id); return next; });
    setSelectedListingId(current => (ids.includes(current ?? "") ? null : current));
    setBulkActionRunning(false);
  }

  function handleBulkDelete() {
    setBulkDeleteConfirmOpen(false);
    commitDelete([...bulkSelectedIds]);
  }

  async function handleSaveListingFields(fields: ListingFieldsDraft) {
    if (!editFieldsListingId) return;
    const listingId = editFieldsListingId;
    setSavingListingFields(true);
    setEditFieldsError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/fields`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: fields.brand || null, model: fields.model || null, productType: fields.productType || null,
          colours: fields.colours, material: fields.material || null, ukSize: fields.ukSize || null, sku: fields.sku || null,
          vintedAudience: fields.vintedAudience, vintedCategoryId: fields.vintedCategoryId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setEditFieldsError(body.error || "Could not save these fields."); return; }
      // Mirrors the same fields the /fields route itself sets server-side
      // (see that route's own uk_size_source line) — the route's response
      // body doesn't echo uk_size_source/updated_at, so they're set the
      // same way here rather than doing a full reload after every edit.
      setDrafts(current => current.map(draft => draft.id === listingId ? {
        ...draft,
        brand: body.brand, model: body.model, product_type: body.productType, colours: body.colours, material: body.material,
        uk_size: body.ukSize, uk_size_source: body.ukSize ? "manual" : null, sku: body.sku,
        generated_title: body.generatedTitle, generated_description: body.generatedDescription,
        vinted_audience: body.vintedAudience, vinted_audience_source: body.vintedAudienceSource,
        // The /fields route only ever persists a category id after
        // confirming it's currently publishable — safe to mark it valid
        // here without a further round-trip.
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus,
        vinted_category_valid: body.vintedCategoryId !== null,
        updated_at: new Date().toISOString(),
      } : draft));
      setEditFieldsListingId(null);
    } catch {
      setEditFieldsError("Network error — could not save these fields.");
    } finally {
      setSavingListingFields(false);
    }
  }

  const hasAnyData = drafts.length > 0;
  const bulkCount = bulkSelectedIds.size;

  // Multi-batch support — the batch box grid's view models, sorted by
  // display number so the two-column grid always reads Batch 1/Batch 2,
  // Batch 3/Batch 4, … regardless of poll-arrival order. Built from
  // visibleBatchIds (so a just-created or just-resumed batch with no poll
  // response yet still gets a box, rendered as "Preparing…" rather than
  // leaving a gap in the grid).
  const batchBoxViewModels: BatchBoxViewModel[] = useMemo(() => [...visibleBatchIds].map(id => {
    const status = batchStatusById.get(id);
    const meta = batchMetaById.get(id);
    const codeCopied = codeCopiedBatchId === id;
    const pairingCode = pairingCodeById.get(id) ?? null;
    if (!status) {
      return {
        batchId: id, displayNumber: meta?.displayNumber ?? 0, browserLabel: meta?.browserLabel ?? null,
        status: "pending", listingCount: 0, completedCount: 0, failedCount: 0, cancelledCount: 0,
        currentItemLabel: null, pairingCode, expiresAt: null, codeCopied,
      };
    }
    const completedCount = status.items.filter(item => item.status === "completed").length;
    const failedCount = status.items.filter(item => item.status === "failed").length;
    const cancelledCount = status.items.filter(item => item.status === "cancelled").length;
    const inProgressItem = status.items.find(item => item.status === "preparing" || item.status === "filling" || item.status === "saving");
    const currentItemLabel = inProgressItem
      ? `${inProgressItem.generatedTitle || inProgressItem.sku || "Listing"}${inProgressItem.detail ? ` — ${inProgressItem.detail}` : ""}`
      : null;
    return {
      batchId: id, displayNumber: status.displayNumber, browserLabel: status.browserLabel,
      status: status.status, listingCount: status.listingCount, completedCount, failedCount, cancelledCount,
      currentItemLabel, pairingCode, expiresAt: status.expiresAt, codeCopied,
    };
  }).sort((a, b) => a.displayNumber - b.displayNumber), [visibleBatchIds, batchStatusById, batchMetaById, pairingCodeById, codeCopiedBatchId]);

  // "Live" for the Live Activity header dot — true whenever ANY tracked
  // batch is genuinely still non-terminal, not just the most recent one.
  const anyBatchLive = useMemo(() => [...batchStatusById.values()].some(status => !isBatchStatusTerminal(status.status)), [batchStatusById]);

  // Multi-batch support — one Live Activity filter button per batch this
  // page session knows about (via batchMetaById, which — unlike
  // visibleBatchIds — is never pruned by a box dismissal, so a batch's
  // activity stays filterable even after its box is gone) whose activity
  // hasn't itself been dismissed, sorted by display number. "All" is
  // rendered separately by the panel itself.
  const activityFilterOptions: ActivityBatchFilter[] = useMemo(() =>
    [...batchMetaById.entries()]
      .filter(([id]) => !activityDismissedBatchIds.has(id))
      .sort((a, b) => a[1].displayNumber - b[1].displayNumber)
      .map(([id, meta]) => ({ batchId: id, label: `Batch ${meta.displayNumber}` })),
  [batchMetaById, activityDismissedBatchIds]);

  const visibleActivityEvents = useMemo(() => activityEvents.filter(event =>
    !activityDismissedBatchIds.has(event.batchId) && (activityFilter === "all" || event.batchId === activityFilter),
  ), [activityEvents, activityDismissedBatchIds, activityFilter]);

  return <div className="lr-layout">
    <div className="lr-topline">
      <h1>Listings Review</h1>
      <span className="lr-safety-badge">Drafts only — never publishes</span>
    </div>

    {/* Visual-accuracy redesign — 4 KPI cards, the canonical, only place
        these totals appear (never duplicated as inline heading stats
        elsewhere on this page). Every value is real computed data —
        Drafting is real, persisted extension-item state
        (preparing/filling/saving), never a client-only guess. */}
    <div className="lr-kpis" role="group" aria-label="Workspace summary">
      <div className="lr-kpi lr-kpi-listings">
        <KpiIcon tone="listings"><path d="M1.5 1.5h4.6L11.5 6.6 6.6 11.5 1.5 6.4V1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="4" cy="4" r=".9" fill="currentColor" /></KpiIcon>
        <div><strong>{listingRows.length}</strong><span className="lr-kpi-label">Listings</span></div>
      </div>
      <div className="lr-kpi lr-kpi-ready">
        <KpiIcon tone="ready"><path d="M2 6.8l3 3 6-6.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></KpiIcon>
        <div><strong>{readyCount}</strong><span className="lr-kpi-label">Ready</span></div>
      </div>
      <div className="lr-kpi lr-kpi-drafting">
        <KpiIcon tone="drafting"><path d="M11 6.5A4.5 4.5 0 1 1 8.9 2.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><path d="M8.5 1.8l.6 1.4-1.5.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></KpiIcon>
        <div><strong>{draftingCount}</strong><span className="lr-kpi-label">Drafting</span></div>
      </div>
      <div className="lr-kpi lr-kpi-review">
        <KpiIcon tone="review"><path d="M6.5 3.6v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="6.5" cy="9" r=".8" fill="currentColor" /><circle cx="6.5" cy="6.5" r="5.2" stroke="currentColor" strokeWidth="1.1" /></KpiIcon>
        <div><strong>{needsReviewCount}</strong><span className="lr-kpi-label">Need review</span></div>
      </div>
    </div>

    <ListingsFilterBar
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      topTab={topTab}
      onTopTabChange={setTopTab}
      totalCount={listingRows.length}
      readyCount={readyCount}
      needsReviewCount={needsReviewCount}
      draftsCount={draftsCount}
      categoryFilter={categoryFilter}
      onCategoryFilterChange={setCategoryFilter}
      categoryOptions={categoryOptions}
      activeQuickFilters={activeQuickFilters}
      onToggleQuickFilter={toggleQuickFilter}
      showEditedOnly={showEditedOnly}
      onToggleEditedOnly={() => setShowEditedOnly(current => !current)}
      showFailedOnly={showFailedOnly}
      onToggleFailedOnly={() => setShowFailedOnly(current => !current)}
      showSentOnly={showSentOnly}
      onToggleSentOnly={() => setShowSentOnly(current => !current)}
      sentCount={sentCount}
      failedCount={failedCount}
      filtersActive={filtersActive}
      onClearFilters={clearFilters}
    />

    {loadError && <div className="home-error">{loadError}</div>}
    {bulkActionError && <div className="home-error" role="alert">{bulkActionError}</div>}
    {bulkActionMessage && <div className="lr-bulk-message" role="status">{bulkActionMessage}</div>}
    {exportError && <div className="home-error" role="alert">
      {exportError}
      {exportRejected.length > 0 && <ul className="lr-export-rejected">
        {exportRejected.map(item => <li key={item.draftId}>{item.sku ?? item.draftId}: {item.reasons.join(", ")}</li>)}
      </ul>}
    </div>}
    {sendToExtensionError && <div className="home-error" role="alert">
      {sendToExtensionError}
      {sendToExtensionRejected.length > 0 && <ul className="lr-export-rejected">
        {sendToExtensionRejected.map(item => <li key={item.draftId}>{item.sku ?? item.draftId}: {item.reasons.join(", ")}</li>)}
      </ul>}
    </div>}

    {/* Multi-batch support — replaces the old single pairing strip with a
        grid of independent batch boxes (one per batch this session is
        still displaying); renders nothing at all once every batch has
        been dismissed, exactly like the old strip rendered nothing before
        any batch existed. The permanent safety badge lives in the page's
        own top line, so no box repeats it. */}
    <ExtensionBatchGrid
      batches={batchBoxViewModels}
      onCancel={handleCancelBatch}
      onDismissBox={handleDismissBatchBox}
      onCopyCode={handleCopyPairingCode}
    />

    {!loading && !hasAnyData && !loadError && <p className="lr-empty-explanation">No generated listings yet — generate listings from your product groups in Listing Studio, then come back here to review them.</p>}

    {/* Two-column workspace (reference image 4's exact proportions). The
        bulk-action bar lives INSIDE the table column, sticky to its own
        bottom — never a viewport-spanning position:fixed overlay — so it
        structurally cannot overlap the inspector/activity column, and
        never needs a guessed padding-bottom reservation. */}
    {hasAnyData && <div className="lr-workspace">
      <div className="lr-table-column">
        <ListingsTable
          rows={tableRows}
          selectedListingId={selectedListingId}
          bulkSelectedIds={bulkSelectedIds}
          onSelectListing={selectListing}
          onToggleBulkSelect={toggleBulkSelect}
          onToggleSelectAll={toggleSelectAll}
          onPreview={setPreviewListingId}
          onEditFields={setEditFieldsListingId}
          onSendToExtension={id => handleSendToExtension([id])}
        />
        {bulkCount > 0 && <div className="lr-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <div className="lr-bulk-bar-selection" role="status">
            <strong>{bulkCount} selected</strong>
            <button type="button" className="button-secondary" onClick={() => setBulkSelectedIds(new Set())}>Clear selection</button>
          </div>
          <div className="lr-bulk-bar-actions">
            {/* Assign categories/Mark ready/Export are real, already-shipped
                batch actions — never removed — but the reference's own
                hierarchy only surfaces Delete + Send as primary, so the
                rest move into an overflow menu rather than visually
                competing with them. */}
            <OverflowMenu label="More bulk actions" items={[
              { label: bulkActionRunning ? "Assigning categories…" : "Assign missing categories", onClick: handleBulkAssignCategories, disabled: bulkActionRunning },
              { label: "Mark ready", onClick: handleBulkMarkReady, disabled: bulkActionRunning },
              {
                label: exportRunning ? (exportStep || "Exporting…") : "Export",
                onClick: handleExport,
                disabled: exportRunning || bulkCount > MAX_EXPORT_LISTINGS_PER_BATCH,
                title: bulkCount > MAX_EXPORT_LISTINGS_PER_BATCH ? `Select at most ${MAX_EXPORT_LISTINGS_PER_BATCH} listings to export at once.` : "Download a ZIP package for manual transfer into Vinted — never publishes anything",
              },
            ]} />
            <button type="button" className="button-danger" disabled={bulkActionRunning} onClick={() => setBulkDeleteConfirmOpen(true)}>Delete</button>
            <button
              type="button"
              className="button"
              disabled={sendToExtensionRunning || bulkCount > MAX_EXTENSION_BATCH_LISTINGS}
              title={bulkCount > MAX_EXTENSION_BATCH_LISTINGS ? `Select at most ${MAX_EXTENSION_BATCH_LISTINGS} listings for the extension at once.` : "Fills Vinted's Create Listing form via the Chrome extension and saves each item as a draft — never publishes anything"}
              onClick={() => handleSendToExtension()}
            >
              {sendToExtensionRunning ? "Preparing batch…" : `Send ${bulkCount} to extension`}
            </button>
          </div>
        </div>}
      </div>
      <div className="lr-rail">
        <ListingDetailsPanel
          listing={selectedListing}
          position={selectedListingPosition}
          markingReady={markingReadyId === selectedListingId}
          assigningCategory={assigningCategoryId === selectedListingId}
          reassessingAudience={reassessingAudienceId === selectedListingId}
          onOpenCarousel={(id, photoId) => openCarousel(id, photoId)}
          onPreview={setPreviewListingId}
          onEditFields={setEditFieldsListingId}
          onAssignCategory={handleAssignCategory}
          onReassessAudience={handleReassessAudience}
          onMarkReady={handleMarkReady}
          onSellingPriceSaved={handleSellingPriceSaved}
          onClose={closeInspector}
          onPrevious={() => {
            if (!selectedListingPosition || selectedListingPosition.index === 0) return;
            setSelectedListingId(filteredRows[selectedListingPosition.index - 1].id);
          }}
          onNext={() => {
            if (!selectedListingPosition || selectedListingPosition.index >= selectedListingPosition.total - 1) return;
            setSelectedListingId(filteredRows[selectedListingPosition.index + 1].id);
          }}
          onSendToExtension={id => handleSendToExtension([id])}
        />
        <DraftActivityPanel
          events={visibleActivityEvents}
          isLive={anyBatchLive}
          filters={activityFilterOptions}
          selectedFilter={activityFilter}
          onSelectFilter={setActivityFilter}
          onDismissActivity={handleDismissBatchActivity}
        />
      </div>
    </div>}

    {carouselListing && <PhotoCarouselDialog
      title={carouselListing.generatedTitle || "Photos"}
      photos={carouselListing.photoIds.map(id => ({ id }))}
      initialPhotoId={carouselInitialPhotoId}
      onClose={() => setCarouselListingId(null)}
    />}

    {previewListing && <PreviewListingDialog
      groupTitle={previewListing.generatedTitle || "this listing"}
      generatedTitle={previewListing.generatedTitle}
      generatedDescription={previewListing.generatedDescription}
      ukSize={previewListing.ukSize}
      sku={previewListing.sku}
      condition={previewListing.condition}
      coverImageUrl={previewListing.coverPhotoId ? `/api/listing-studio/images/${previewListing.coverPhotoId}/view` : null}
      sellingPricePence={previewListing.sellingPricePence}
      onClose={() => setPreviewListingId(null)}
    />}

    {editFieldsListing && <EditListingFieldsDialog
      groupTitle={editFieldsListing.generatedTitle || "this listing"}
      fields={{
        brand: editFieldsListing.brand ?? "", model: editFieldsListing.model ?? "", productType: editFieldsListing.productType ?? "",
        colours: editFieldsListing.colours ?? [], material: editFieldsListing.material ?? "", ukSize: editFieldsListing.ukSize ?? "", sku: editFieldsListing.sku ?? "",
        vintedAudience: editFieldsListing.vintedAudience ?? "unknown",
        vintedCategoryId: editFieldsListing.vintedCategoryId, vintedCategoryPath: editFieldsListing.vintedCategoryPath,
      }}
      loading={savingListingFields}
      error={editFieldsError}
      onClose={() => { setEditFieldsListingId(null); setEditFieldsError(""); }}
      onSave={handleSaveListingFields}
    />}

    {bulkDeleteConfirmOpen && <ConfirmDialog
      title={`Delete ${bulkCount} listing${bulkCount === 1 ? "" : "s"}?`}
      message="These listings and their photos will be permanently deleted. This cannot be undone."
      confirmLabel={`Delete ${bulkCount} listing${bulkCount === 1 ? "" : "s"}`}
      onConfirm={handleBulkDelete}
      onCancel={() => setBulkDeleteConfirmOpen(false)}
    />}
  </div>;
}
