"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ListingsFilterBar, { type TopTab } from "./ListingsFilterBar";
import ListingsTable, { type ListingTableRow, type ListingMarketplaceView } from "./ListingsTable";
import ListingDetailsPanel, { type ListingDetails, type EbayTabData } from "./ListingDetailsPanel";
import DraftActivityPanel, { type ActivityEvent, type ActivityBatchFilter } from "./DraftActivityPanel";
import ExtensionBatchGrid, { type BatchBoxViewModel } from "./ExtensionBatchGrid";
import { RecoverStuckBatchDialog, type RecoverDialogBatch, type RecoverDialogListing } from "./RecoverStuckBatchDialog";
import PhotoCarouselDialog from "./PhotoCarouselDialog";
import EditListingFieldsDialog, { type ListingFieldsDraft } from "@/components/listing-studio/EditListingFieldsDialog";
import PreviewListingDialog from "@/components/listing-studio/PreviewListingDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import OverflowMenu from "@/components/listing-studio/OverflowMenu";
import { KpiIcon } from "./KpiIcon";
import type { EbayPolicyOption, EbayLocationOption, EbayPolicySelection } from "./EbayPolicySelectors";
import BulkEbayPolicyControl, { type BulkPolicyApplyResult } from "./BulkEbayPolicyControl";
import {
  computeListingReviewStatus, buildListingWarnings, matchesListingSearch, matchesQuickFilter,
  type ListingQuickFilter, type ReviewableListing,
} from "@/lib/listing-studio/listing-review";
import { computeExtensionWorkflowStatus, WORKFLOW_STATUS_TAB_GROUPS, isBatchStatusTerminal, shouldApplyBatchPollResponse, type ExtensionWorkflowStatus } from "@/lib/listing-studio/extension-workflow-status";
// PHASE 4 (Listings Review UI wiring) — the ACTIVE eBay pipeline is now the
// Sell Feed API one (lib/listing-studio/ebay-feed/feed-workflow-status.ts),
// the only mechanism that creates a genuine, editable Seller Hub draft. The
// retired Inventory API pipeline's own vocabulary
// (lib/listing-studio/ebay-workflow-status.ts) is used ONLY for the small,
// read-only legacy-stuck-batch notice further down — never for anything
// that drives new work.
import {
  EBAY_FEED_ITEM_STATUS_LABELS, EBAY_FEED_BATCH_STATUS_LABELS, isEbayFeedBatchStatusTerminal, isEbayFeedItemInProgress,
  isEbayFeedBatchInProgress, computeEbayFeedItemWorkflowStatus, SELLER_HUB_DRAFTS_URL, type EbayFeedItemStatus, type EbayFeedBatchStatus,
  type EbayFeedBatchBlockingState,
} from "@/lib/listing-studio/ebay-feed/feed-workflow-status";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";
import { computeCostPence, computeProfitPence, type SkuPurchaseMatch } from "@/lib/listing-studio/purchase-match";
import { MAX_EXPORT_LISTINGS_PER_BATCH } from "@/lib/listing-studio/vinted-export-schema";
import { MAX_EXTENSION_BATCH_LISTINGS } from "@/lib/listing-studio/extension-batch-schema";
import { evaluateEbayFeedDraftEligibility, type EbayFeedDraftEligibilityResult } from "@/lib/listing-studio/ebay-feed/feed-draft-eligibility";

type RejectedExportListing = { draftId: string; sku: string | null; reasons: string[] };

// PHASE 4 — mirrors app/api/listing-studio/listings-review/route.ts's own
// response shape for each product's eBay marketplace draft. `ebayStatus`
// (the RETIRED Inventory API pipeline's own status) is kept only for the
// legacy, read-only offer-id note; `ebayFeedStatus` (the ACTIVE Sell Feed
// API pipeline's own status) is what drives every live workflow display.
type EbayMarketplaceDraftRow = {
  id: string; productDraftId: string; title: string | null; description: string | null;
  categoryId: string | null; categoryPath: string | null; conditionValue: string | null;
  pricePence: number | null; quantity: number | null;
  readiness: { ready: boolean };
  ebayFulfillmentPolicyId: string | null; ebayReturnPolicyId: string | null; ebayPaymentPolicyId: string | null;
  ebayMerchantLocationKey: string | null; ebayOfferId: string | null;
  ebayFeedDraftCreatedAt: string | null;
  ebayStatus: {
    marketplace_draft_id: string; batch_id: string; batch_status: string; item_status: string; queue_position: number;
    error_code: string | null; error_message: string | null; ebay_offer_id: string | null;
    started_at: string | null; completed_at: string | null;
  } | null;
  ebayFeedStatus: {
    marketplace_draft_id: string; batch_id: string; batch_status: string; item_status: string; queue_position: number;
    ebay_task_id: string | null; error_code: string | null; error_message: string | null;
    started_at: string | null; completed_at: string | null;
  } | null;
  // CORRECTIVE PASS (second real submission — duplicate-submission
  // defect, Phase 6) — server-computed, mirrors
  // app/api/listing-studio/listings-review/route.ts's own field exactly.
  feedBatchBlockingState: EbayFeedBatchBlockingState;
};

// Mirrors app/api/listing-studio/ebay-feed-batches/[batchId]/route.ts's GET
// response shape exactly.
type EbayBatchItemRow = {
  itemId: string; marketplaceDraftId: string; draftId: string; queuePosition: number; status: EbayFeedItemStatus;
  errorCode: string | null; errorMessage: string | null;
  startedAt: string | null; completedAt: string | null; generatedTitle: string | null; sku: string | null;
};
type EbayBatchStatus = {
  batchId: string; status: EbayFeedBatchStatus; listingCount: number; displayNumber: number;
  createdAt: string; completedAt: string | null; boxDismissedAt: string | null; activityDismissedAt: string | null;
  errorCode: string | null; errorMessage: string | null; sellerHubDraftsUrl: string;
  items: EbayBatchItemRow[];
};
type EbayStuckBatch = { batchId: string; displayNumber: number; status: string; listingCount: number; createdAt: string };

// Every eBay Feed item status that counts as "still being actively worked
// on" for the marketplace-aware "Sent"/"Drafting" filter, mirroring
// WORKFLOW_STATUS_TAB_GROUPS.sent's own Vinted equivalent.
const EBAY_IN_PROGRESS_STATUSES: readonly EbayFeedItemStatus[] = ["queued", "uploaded", "awaiting_result"];

// Follow-up correction (orphaned extension batch recovery) — mirrors
// GET /api/listing-studio/extension-batches's own `recoverable` entry
// shape, and the POST route's own `blockingBatch` conflict-response
// shape (which carries the same fields plus nothing else — both describe
// exactly one owner-owned, nonterminal batch).
type RecoverableBatchInfo = {
  batchId: string; displayNumber: number; status: string; listingCount: number;
  expiresAt: string; boxDismissedAt: string | null; lastExtensionActivityAt: string | null;
  isHidden: boolean; isStale: boolean;
};
type BlockingBatchInfo = {
  batchId: string; displayNumber: number; status: string; expiresAt: string;
  boxDismissedAt: string | null; lastExtensionActivityAt: string | null; isHidden: boolean; isStale: boolean;
};

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
type ReviewData = { drafts: ReviewDraftRow[]; images: ReviewImageRow[]; ebayDrafts: EbayMarketplaceDraftRow[] };

// Every field the UI or its derived status/warnings/edited-detection logic
// needs, computed once per listing when the underlying data actually
// changes — never re-derived per render of any child component.
//
// Stage 6 (eBay draft batches) — `ebay` (used by ListingDetailsPanel's own
// tab) and the flat `ebay*` fields (used by ListingsTable's own workflow
// column) are two views of the SAME underlying eBay data, both built once
// here from the same source — never two independently-computed answers.
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
  hasEbayPreparation: boolean;
  ebayContentReady: boolean;
  ebayWorkflowStatus: EbayFeedItemStatus | null;
  ebayQueuePosition: number | null;
  ebayErrorMessage: string | null;
  ebaySellingPricePence: number | null;
  ebayProfitPence: number | null;
  // CORRECTIVE PASS (third real-submission audit) — mirrors row.ebay's own
  // feedBatchState, flattened to the same top level as the other ebay*
  // fields above so ListingsTable's own workflow column (which reads only
  // the flat fields, never the nested .ebay object) can detect a stale,
  // inconsistent row and refuse to display a misleading "Queued".
  ebayFeedBatchState: EbayFeedBatchBlockingState;
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

  // Stage 6 (eBay draft batches) — independent eBay marketplace-draft data
  // (never merged into `drafts` above, which stays exactly what it always
  // was: Vinted data only). Policies/locations are fetched once from the
  // existing eBay account endpoint — never re-derived or duplicated here.
  const [ebayDrafts, setEbayDrafts] = useState<EbayMarketplaceDraftRow[]>([]);
  const [ebayPolicies, setEbayPolicies] = useState<EbayPolicyOption[]>([]);
  const [ebayLocations, setEbayLocations] = useState<EbayLocationOption[]>([]);
  const [ebayAccountUsable, setEbayAccountUsable] = useState(false);
  // The small Vinted/eBay toggle beside the Workflow column heading —
  // changes which marketplace's status/price/profit each row displays;
  // never touches stored data. Independent of activityChannel below (the
  // product spec's own "the workflow switch changes the displayed
  // marketplace state only" vs. Live Activity's own separate toggle).
  const [workflowMarketplaceView, setWorkflowMarketplaceView] = useState<ListingMarketplaceView>("VINTED");
  // Live Activity's own independent Vinted/eBay toggle.
  const [activityChannel, setActivityChannel] = useState<ListingMarketplaceView>("VINTED");

  const [ebayCreatingDrafts, setEbayCreatingDrafts] = useState(false);
  const [ebayCreateError, setEbayCreateError] = useState("");
  const [ebayCreateMessage, setEbayCreateMessage] = useState("");
  // CORRECTIVE PASS — pre-submission preview + confirmation, required
  // before any real batch is created: exactly which fields transfer to
  // the Seller Hub draft and which the user must complete themselves
  // afterward. An explicit `phase` (never an implicit combination of
  // loading/error/row-count booleans) drives the dialog's entire
  // title/body/button state — see the incident this corrects: a failed
  // or still-loading preview must NEVER be able to show an
  // enabled-looking "Create 0 Seller Hub drafts" button. The server's own
  // requestedCount/eligibleCount/ineligibleCount are the ONLY source for
  // every count the dialog displays — never re-derived from the client's
  // own earlier selection.
  type EbayPreviewPhase = "loading" | "ready" | "blocked" | "failed";
  const [ebayPreviewOpen, setEbayPreviewOpen] = useState(false);
  const [ebayPreviewPhase, setEbayPreviewPhase] = useState<EbayPreviewPhase>("loading");
  const [ebayPreviewError, setEbayPreviewError] = useState("");
  const [ebayPreviewRequestedCount, setEbayPreviewRequestedCount] = useState(0);
  const [ebayPreviewRows, setEbayPreviewRows] = useState<Array<{ draftId: string; fields: Record<string, string>; completeInSellerHub: string[] }>>([]);
  const [ebayPreviewBlockers, setEbayPreviewBlockers] = useState<Array<{ draftId: string; reason: string }>>([]);
  // Required explicit acknowledgement before a PARTIAL submission
  // (some eligible, some blocked) can be confirmed — never implied by
  // merely having the dialog open.
  const [ebayPreviewPartialAck, setEbayPreviewPartialAck] = useState(false);
  const [ebayVisibleBatchIds, setEbayVisibleBatchIds] = useState<Set<string>>(new Set());
  const [ebayBatchStatusById, setEbayBatchStatusById] = useState<Map<string, EbayBatchStatus>>(new Map());
  const [ebayStuckBatches, setEbayStuckBatches] = useState<EbayStuckBatch[]>([]);
  // Corrective pass — true until the resume-batches poll below tells us
  // otherwise. false means the eBay draft-batches migration
  // (supabase-ebay-draft-batches.sql) hasn't been applied to this database
  // yet: batch-dependent controls (Create eBay drafts, bulk policy assign,
  // stuck-batch recovery) are disabled with an explanatory note, but the
  // per-item eBay editor (title/description/category/price/policies) has
  // no dependency on this and stays fully visible and usable regardless.
  const [ebayBatchingAvailable, setEbayBatchingAvailable] = useState(true);
  const [ebayDismissTarget, setEbayDismissTarget] = useState<EbayStuckBatch | { batchId: string; displayNumber: number } | null>(null);
  const [ebayActivityEvents, setEbayActivityEvents] = useState<ActivityEvent[]>([]);
  const [ebayActivityDismissedBatchIds, setEbayActivityDismissedBatchIds] = useState<Set<string>>(new Set());
  const [ebayActivityFilter, setEbayActivityFilter] = useState<string>("all");
  const ebayPreviousItemsByBatchRef = useRef<Map<string, Map<string, EbayBatchItemRow>>>(new Map());
  const ebayCompletedBatchesLoggedRef = useRef<Set<string>>(new Set());
  const ebayVisibleBatchIdsRef = useRef<Set<string>>(new Set());
  const ebayBatchStatusByIdRef = useRef<Map<string, EbayBatchStatus>>(new Map());
  useEffect(() => { ebayVisibleBatchIdsRef.current = ebayVisibleBatchIds; }, [ebayVisibleBatchIds]);
  useEffect(() => { ebayBatchStatusByIdRef.current = ebayBatchStatusById; }, [ebayBatchStatusById]);
  // CORRECTIVE PASS (fourth real-submission audit — Phase 5/9: stalled
  // detection) — the timestamp a batch's own status was last OBSERVED to
  // change, updated inside applyEbayBatchResult below. Session-scoped
  // (like every other "live" signal this page tracks) — a batch never
  // observed to change this session simply isn't reported as stalled
  // (unknown, not "fine"), rather than guessing from a page-load
  // snapshot with no real history to compare against.
  //
  // Deliberately real React STATE, never a ref: ebayStalledBatchAction's
  // own useMemo below reads this during render to decide whether to
  // offer "Resume processing" — a ref read during render is unsafe (React
  // refs are only meant for imperative, non-render-time access) and is
  // actually flagged by this codebase's own eslint-plugin-react-hooks
  // "refs" rule; state is the correct tool for a value that legitimately
  // drives what gets rendered.
  const [ebayBatchStatusChangedAt, setEbayBatchStatusChangedAt] = useState<Map<string, number>>(new Map());
  const EBAY_STALL_THRESHOLD_MS = 90_000;
  const isEbayBatchStalled = useCallback((batchId: string, status: EbayFeedBatchStatus): boolean => {
    if (isEbayFeedBatchStatusTerminal(status)) return false;
    const changedAt = ebayBatchStatusChangedAt.get(batchId);
    if (!changedAt) return false;
    return Date.now() - changedAt > EBAY_STALL_THRESHOLD_MS;
  }, [ebayBatchStatusChangedAt]);

  // CORRECTIVE PASS (second real submission — Phase 7/8: "View error" /
  // "Retry Seller Hub draft") — both dialogs read the already-fetched,
  // already-polled EbayBatchStatus straight out of ebayBatchStatusById;
  // neither one issues its own extra fetch just to display what this page
  // already knows.
  const [viewErrorBatchId, setViewErrorBatchId] = useState<string | null>(null);
  const [retryConfirmBatchId, setRetryConfirmBatchId] = useState<string | null>(null);
  const [retryingBatchId, setRetryingBatchId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  // CORRECTIVE PASS (third real-submission audit) — Reconcile is a
  // genuinely separate action from Retry (never combined without its own
  // confirmation boundary — Phase 5's explicit requirement): it makes no
  // eBay call at all, ever, and only ever flips a stale local item row to
  // 'failed' so Retry can subsequently become available.
  const [reconcileConfirmBatchId, setReconcileConfirmBatchId] = useState<string | null>(null);
  const [reconcilingBatchId, setReconcilingBatchId] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState("");

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
  // Follow-up correction (orphaned extension batch recovery) — the batch
  // named by the create route's own DRAFT_ALREADY_IN_ACTIVE_BATCH 409
  // response, if any, so the error can offer a real "View active batch" /
  // "Recover stuck batch" action instead of just the generic message.
  const [blockingBatch, setBlockingBatch] = useState<BlockingBatchInfo | null>(null);
  // recoverableBatches — every nonterminal batch this owner has that is
  // EITHER hidden (its box was dismissed) OR stale (no fresh genuine
  // extension activity) — see GET /api/listing-studio/extension-batches's
  // own `recoverable` field. Surfaced as the compact "Hidden active
  // batch" section below the KPI row.
  const [recoverableBatches, setRecoverableBatches] = useState<RecoverableBatchInfo[]>([]);
  const [recoverDialogBatch, setRecoverDialogBatch] = useState<RecoverDialogBatch | null>(null);
  const [recoverDialogListings, setRecoverDialogListings] = useState<RecoverDialogListing[]>([]);
  const [recoverDialogLoading, setRecoverDialogLoading] = useState(false);
  const [recoverStillActiveWarning, setRecoverStillActiveWarning] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState("");
  const [recoverMessage, setRecoverMessage] = useState("");
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
      setEbayDrafts(data.ebayDrafts ?? []);
      setLoadError("");
    } catch {
      setLoadError("Could not load your listings. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { loadListings(); }, [loadListings]);

  // Stage 6 (eBay draft batches) — the connected account's own currently-
  // synced policies/locations, fetched once on mount (never per-listing;
  // reused by every row/tab/bulk control). Reuses the EXISTING Settings
  // endpoint rather than duplicating this data — never re-fetched just
  // because this page opened after Settings already loaded it once.
  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/ebay/connection");
        if (!response.ok) return;
        const body = await response.json() as {
          connection: { connectionStatus: string } | null;
          policies: Array<{ policyType: "FULFILLMENT" | "RETURN" | "PAYMENT"; ebayPolicyId: string; name: string; available: boolean }>;
          locations: Array<{ merchantLocationKey: string; name: string | null; addressSummary: string | null; available: boolean }>;
        };
        setEbayAccountUsable(body.connection?.connectionStatus === "connected");
        setEbayPolicies(body.policies.map(p => ({ policyType: p.policyType, ebayPolicyId: p.ebayPolicyId, name: p.name, available: p.available })));
        setEbayLocations(body.locations);
      } catch { /* best-effort — the page still works, eBay tabs just show no policy options yet */ }
    })();
  }, []);

  // PHASE 4 — resumes tracking every eBay Seller Hub draft batch still
  // genuinely visible from an earlier page load, exactly mirroring the
  // Vinted extension-batch resume effect above (but independent state).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/listing-studio/ebay-feed-batches");
        if (!response.ok || cancelled) return;
        const body = await response.json() as { available?: boolean; batchIds: { batchId: string; displayNumber: number }[]; stuck?: EbayStuckBatch[] };
        if (cancelled) return;
        if (body.available === false) setEbayBatchingAvailable(false);
        setEbayStuckBatches(body.stuck ?? []);
        if (body.batchIds.length === 0) return;
        setEbayVisibleBatchIds(current => { const next = new Set(current); for (const entry of body.batchIds) next.add(entry.batchId); return next; });
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
        const body = await response.json() as { batchIds: { batchId: string; displayNumber: number }[]; recoverable?: RecoverableBatchInfo[] };
        if (cancelled) return;
        setRecoverableBatches(body.recoverable ?? []);
        if (body.batchIds.length === 0) return;
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

  // Stage 6 (eBay draft batches) — one eBay marketplace draft per product
  // at most (see supabase-listing-studio-marketplace.sql's own unique
  // constraint), indexed once here rather than filtering ebayDrafts inside
  // the per-row map below.
  const ebayByProductId = useMemo(() => new Map(ebayDrafts.map(d => [d.productDraftId, d])), [ebayDrafts]);

  // Status/warnings/edited-ness/cost/profit computed exactly once per
  // listing here — never recomputed by ListingsTable or ListingDetailsPanel
  // themselves. Deliberately does NOT depend on batchStatus (the live
  // 4s-polled extension status) — see the separate listingRows memo below,
  // which layers workflow status on top — so a poll tick that hasn't
  // changed any listing's own data never re-runs this whole pipeline.
  const baseListingRows = useMemo(() => drafts.map(draft => {
    const photoIds = photoIdsByDraftId.get(draft.id) ?? [];
    const ebayDraft = ebayByProductId.get(draft.id) ?? null;
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
    // Stage 6 — the SAME real purchase cost (costPence, computed once
    // above) is used for eBay's own profit — "You paid" is a property of
    // the purchase, not the marketplace. Only the SELLING price and
    // therefore profit differ per marketplace.
    const ebayProfitPence = ebayDraft ? computeProfitPence(costPence, ebayDraft.pricePence) : null;
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
      // Corrective pass (canonical unified row model) — this page now
      // legitimately includes eBay-only products (see the listings-review
      // route's own header comment for the proven bug this closes): a row
      // has real Vinted content only when BOTH generated_title and
      // generated_description are non-null — exactly the same condition
      // app/api/listing-studio/groups/[draftId]/generate/route.ts's own
      // `shouldWriteVintedContent` gate uses to decide whether to ever
      // write them, so client and server can never disagree about "does
      // this product have a genuine Vinted preparation".
      hasVintedPreparation: Boolean(draft.generated_title) && Boolean(draft.generated_description),
      hasEbayPreparation: ebayDraft !== null,
      ebayContentReady: ebayDraft?.readiness.ready ?? false,
      ebaySellingPricePence: ebayDraft?.pricePence ?? null,
      ebayProfitPence,
      ebay: ebayDraft ? {
        marketplaceDraftId: ebayDraft.id,
        categoryId: ebayDraft.categoryId,
        contentReady: ebayDraft.readiness.ready,
        sellingPricePence: ebayDraft.pricePence,
        costPence,
        profitPence: ebayProfitPence,
        quantity: ebayDraft.quantity,
        conditionValue: ebayDraft.conditionValue,
        selection: {
          fulfillmentPolicyId: ebayDraft.ebayFulfillmentPolicyId, returnPolicyId: ebayDraft.ebayReturnPolicyId,
          paymentPolicyId: ebayDraft.ebayPaymentPolicyId, merchantLocationKey: ebayDraft.ebayMerchantLocationKey,
        } satisfies EbayPolicySelection,
        // PHASE 3 — the RETIRED Inventory API pipeline's own offer id, kept
        // only as a historical fact (see EbayTabData's own comment).
        legacyOfferId: ebayDraft.ebayOfferId,
        feedDraftCreatedAt: ebayDraft.ebayFeedDraftCreatedAt,
        // PHASE 4 — workflowStatus/queuePosition/errorMessage now come from
        // ebayFeedStatus (the ACTIVE Sell Feed API pipeline), not the
        // legacy ebayStatus. The separate listingRows memo below layers the
        // LIVE poll result on top, exactly mirroring how Vinted's own
        // workflowStatus is layered (see liveItemByDraftId below).
        workflowStatus: ebayDraft.ebayFeedStatus ? computeEbayFeedItemWorkflowStatus(ebayDraft.ebayFeedStatus.item_status) : null,
        queuePosition: ebayDraft.ebayFeedStatus?.queue_position ?? null,
        errorMessage: ebayDraft.ebayFeedStatus?.error_message ?? null,
        feedBatchState: ebayDraft.feedBatchBlockingState ?? { kind: "none" },
      } satisfies EbayTabData : null,
    };
  }), [drafts, photoIdsByDraftId, ebayByProductId]);

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

  // Stage 6 (eBay draft batches) — the exact same "live batch item wins,
  // tie-break by most recently created batch" precedence as
  // liveItemByDraftId above, independently keyed by marketplaceDraftId
  // (never productDraftId — a product's eBay marketplace draft has its own
  // distinct id). Completing/failing an eBay batch item never touches this
  // same product's Vinted liveItemByDraftId entry, and vice versa.
  const ebayLiveItemByMarketplaceDraftId = useMemo(() => {
    const map = new Map<string, { item: EbayBatchItemRow; batch: EbayBatchStatus }>();
    for (const batch of ebayBatchStatusById.values()) {
      for (const item of batch.items) {
        const existing = map.get(item.marketplaceDraftId);
        if (!existing) { map.set(item.marketplaceDraftId, { item, batch }); continue; }
        const existingLive = !isEbayFeedBatchStatusTerminal(existing.batch.status);
        const candidateLive = !isEbayFeedBatchStatusTerminal(batch.status);
        if (candidateLive && !existingLive) { map.set(item.marketplaceDraftId, { item, batch }); continue; }
        if (candidateLive === existingLive && new Date(batch.createdAt).getTime() > new Date(existing.batch.createdAt).getTime()) {
          map.set(item.marketplaceDraftId, { item, batch });
        }
      }
    }
    return map;
  }, [ebayBatchStatusById]);

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

    // Stage 6 — same live-first-else-aggregate precedence, entirely
    // independent of the Vinted fields just computed above. A live eBay
    // batch item, when present, wins over row.ebay's own page-load
    // aggregate (already set in baseListingRows); a cancelled/absent live
    // item leaves that aggregate exactly as it was.
    const ebayLive = row.ebay ? ebayLiveItemByMarketplaceDraftId.get(row.ebay.marketplaceDraftId) : undefined;
    const ebayWorkflowStatus = ebayLive ? computeEbayFeedItemWorkflowStatus(ebayLive.item.status) : row.ebay?.workflowStatus ?? null;
    const ebayQueuePosition = ebayLive ? ebayLive.item.queuePosition : row.ebay?.queuePosition ?? null;
    const ebayErrorMessage = ebayLive ? ebayLive.item.errorMessage : row.ebay?.errorMessage ?? null;
    const ebay = row.ebay ? {
      ...row.ebay, workflowStatus: ebayWorkflowStatus, queuePosition: ebayQueuePosition, errorMessage: ebayErrorMessage,
    } : null;

    return {
      ...row, workflowStatus, queuePosition, currentStep, detail, vintedDraftId, errorMessage,
      ebayWorkflowStatus, ebayQueuePosition, ebayErrorMessage, ebay,
      ebayFeedBatchState: row.ebay?.feedBatchState ?? { kind: "none" as const },
    };
  }), [baseListingRows, liveItemByDraftId, ebayLiveItemByMarketplaceDraftId]);

  const listingsById = useMemo(() => new Map(listingRows.map(row => [row.id, row])), [listingRows]);

  const categoryOptions = useMemo(() => {
    const values = new Set(listingRows.map(row => row.productType).filter((value): value is string => Boolean(value)));
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [listingRows]);

  // Corrective pass — every one of these now follows the active
  // Workflow-column channel (workflowMarketplaceView), per the product
  // spec's own "Marketplace-aware KPI cards and filters" requirement.
  // `channelRows` scopes to rows that genuinely HAVE the active channel's
  // preparation FIRST — "rows without the active marketplace preparation
  // should not distort active-channel totals" — so a Vinted-only row can
  // never inflate/deflate an eBay-mode count, and vice versa. Within that
  // scope, readiness (Ready/Needs review) and workflow progress
  // (Drafting/Drafts/Sent/Failed) stay the same two deliberately SEPARATE
  // concepts this page has always kept apart — never merged into one
  // count — just computed from whichever channel's own fields apply.
  const channelRows = useMemo(
    () => listingRows.filter(row => (workflowMarketplaceView === "VINTED" ? row.hasVintedPreparation : row.hasEbayPreparation)),
    [listingRows, workflowMarketplaceView],
  );
  // The "Listings" KPI card's own count — channel-scoped (per the spec's
  // own "Listings count includes rows with an eBay preparation" wording).
  // Deliberately a SEPARATE value from the filter bar's "All" tab count
  // below, which stays the genuinely unfiltered total — "All" always
  // means every row on the page, on either channel, so a row without the
  // active channel's preparation is never hidden from it, only shown as
  // "Not prepared" in the table (see ListingsTable.tsx's own
  // resolveWorkflowDisplay).
  const channelListingsCount = channelRows.length;

  const readyCount = useMemo(() => channelRows.filter(row =>
    workflowMarketplaceView === "VINTED" ? row.status !== "needs_review" : row.ebayContentReady,
  ).length, [channelRows, workflowMarketplaceView]);
  const needsReviewCount = useMemo(() => channelRows.filter(row =>
    workflowMarketplaceView === "VINTED" ? row.status === "needs_review" : !row.ebayContentReady,
  ).length, [channelRows, workflowMarketplaceView]);
  const draftsCount = useMemo(() => channelRows.filter(row =>
    workflowMarketplaceView === "VINTED"
      ? row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.drafts as string[]).includes(row.workflowStatus)
      : row.ebayWorkflowStatus === "succeeded",
  ).length, [channelRows, workflowMarketplaceView]);
  const sentCount = useMemo(() => channelRows.filter(row =>
    workflowMarketplaceView === "VINTED"
      ? row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.sent as string[]).includes(row.workflowStatus)
      : row.ebayWorkflowStatus !== null && (EBAY_IN_PROGRESS_STATUSES as string[]).includes(row.ebayWorkflowStatus),
  ).length, [channelRows, workflowMarketplaceView]);
  const failedCount = useMemo(() => channelRows.filter(row =>
    workflowMarketplaceView === "VINTED" ? row.workflowStatus === "failed" : row.ebayWorkflowStatus === "failed",
  ).length, [channelRows, workflowMarketplaceView]);
  // Visual-accuracy redesign — the 4th KPI card. Real, persisted extension-
  // (or eBay draft-batch-) item state, never a client-only guess.
  const draftingCount = useMemo(() => channelRows.filter(row =>
    workflowMarketplaceView === "VINTED" ? row.workflowStatus === "in_progress" : isEbayFeedItemInProgress(row.ebayWorkflowStatus),
  ).length, [channelRows, workflowMarketplaceView]);

  const filtersActive = topTab !== "all" || categoryFilter !== "all" || activeQuickFilters.size > 0 || showEditedOnly || showFailedOnly || showSentOnly || searchQuery.trim().length > 0;
  const clearFilters = useCallback(() => {
    setTopTab("all"); setCategoryFilter("all"); setActiveQuickFilters(new Set());
    setShowEditedOnly(false); setShowFailedOnly(false); setShowSentOnly(false); setSearchQuery("");
  }, []);

  // Corrective pass — "All" (topTab === "all") is deliberately the ONE
  // exception that never channel-filters: it always means "every row on
  // the page", exactly as it always has, so a row without the active
  // channel's preparation still appears (as "Not prepared") rather than
  // vanishing the instant the Workflow toggle is switched. Every OTHER
  // top-tab filter (Ready/Need review/Drafts) is channel-aware and, as a
  // natural consequence of the criteria themselves, only ever matches
  // rows that DO have the active channel's own preparation.
  const filteredRows = useMemo(() => listingRows.filter(row => {
    if (topTab === "ready") {
      if (workflowMarketplaceView === "VINTED" ? (!row.hasVintedPreparation || row.status === "needs_review") : (!row.hasEbayPreparation || !row.ebayContentReady)) return false;
    }
    if (topTab === "needs_review") {
      if (workflowMarketplaceView === "VINTED" ? (!row.hasVintedPreparation || row.status !== "needs_review") : (!row.hasEbayPreparation || row.ebayContentReady)) return false;
    }
    if (topTab === "drafted") {
      if (workflowMarketplaceView === "VINTED" ? row.workflowStatus !== "drafted" : row.ebayWorkflowStatus !== "succeeded") return false;
    }
    if (categoryFilter !== "all" && row.productType !== categoryFilter) return false;
    if (showEditedOnly && row.status !== "edited") return false;
    if (showFailedOnly && row.workflowStatus !== "failed") return false;
    if (showSentOnly && !(row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.sent as string[]).includes(row.workflowStatus))) return false;
    for (const filter of activeQuickFilters) if (!matchesQuickFilter(row, filter)) return false;
    return matchesListingSearch({ generatedTitle: row.generatedTitle, sku: row.sku, brand: row.brand, model: row.model, colours: row.colours }, searchQuery);
  }), [listingRows, topTab, workflowMarketplaceView, categoryFilter, showEditedOnly, showFailedOnly, showSentOnly, activeQuickFilters, searchQuery]);

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

  // Stage 6 (eBay draft batches) — mirrors handleSellingPriceSaved's own
  // "the route already saved it; just reflect the result locally" pattern,
  // for whichever eBay field(s) were just saved (price and/or one policy).
  // Only ever patches ebayDrafts (never `drafts`, the Vinted array) — the
  // two marketplaces' local state can never cross-contaminate.
  const handleEbaySettingsSaved = useCallback((listingId: string, patch: { sellingPricePence?: number } & Partial<EbayPolicySelection>) => {
    setEbayDrafts(current => current.map(d => {
      if (d.productDraftId !== listingId) return d;
      return {
        ...d,
        pricePence: patch.sellingPricePence !== undefined ? patch.sellingPricePence : d.pricePence,
        ebayFulfillmentPolicyId: patch.fulfillmentPolicyId !== undefined ? patch.fulfillmentPolicyId : d.ebayFulfillmentPolicyId,
        ebayReturnPolicyId: patch.returnPolicyId !== undefined ? patch.returnPolicyId : d.ebayReturnPolicyId,
        ebayPaymentPolicyId: patch.paymentPolicyId !== undefined ? patch.paymentPolicyId : d.ebayPaymentPolicyId,
        ebayMerchantLocationKey: patch.merchantLocationKey !== undefined ? patch.merchantLocationKey : d.ebayMerchantLocationKey,
      };
    }));
  }, []);

  // PHASE 4 — calls the exact SAME evaluateEbayFeedDraftEligibility
  // function the server uses (lib/listing-studio/ebay-feed/feed-draft-eligibility.ts,
  // also used by resolveEbayFeedDraftEligibilityForProducts in
  // lib/listing-studio/ebay-feed/feed-batches.ts) rather than a separate,
  // hand-rolled boolean check. Deliberately does NOT check policies/
  // location (see that function's own header: the real Seller Hub Feed
  // template has no column for either — confirmed directly from the real
  // downloaded template, not guessed). This is still only a CLIENT-SIDE
  // preview for the button's label/enabled state and for explaining
  // blockers inline — the server independently re-runs the same function
  // against fresh data before ever creating a batch.
  const ebayEligibilityById = useMemo(() => {
    const map = new Map<string, EbayFeedDraftEligibilityResult>();
    for (const id of bulkSelectedIds) {
      const row = listingsById.get(id);
      if (!row?.ebay) { map.set(id, { eligible: false, reasons: ["No eBay preparation for this listing"] }); continue; }
      map.set(id, evaluateEbayFeedDraftEligibility({
        hasEbayPreparation: true,
        accountUsable: ebayAccountUsable,
        alreadyHasFeedDraft: row.ebay.feedDraftCreatedAt !== null,
        feedBatchState: row.ebay.feedBatchState,
        contentReady: row.ebay.contentReady,
        hasValidPrice: row.ebay.sellingPricePence != null && row.ebay.sellingPricePence > 0,
        hasPhoto: row.photoIds.length > 0,
        hasSku: Boolean(row.sku),
        hasQuantity: row.ebay.quantity != null,
        hasCategoryId: Boolean(row.ebay.categoryId),
        conditionValue: row.ebay.conditionValue,
      }));
    }
    return map;
  }, [bulkSelectedIds, listingsById, ebayAccountUsable]);

  const eligibleEbayCount = useMemo(() =>
    [...ebayEligibilityById.values()].filter(result => result.eligible).length,
  [ebayEligibilityById]);

  // Every DISTINCT blocking reason across every selected-but-ineligible
  // listing, deduplicated — surfaced next to the button/popover instead of
  // an unexplained "Create 0 Seller Hub drafts" (product requirement).
  const ebayIneligibleBlockingReasons = useMemo(() => {
    if (eligibleEbayCount > 0 || ebayEligibilityById.size === 0) return [] as string[];
    const reasons = new Set<string>();
    for (const result of ebayEligibilityById.values()) for (const reason of result.reasons) reasons.add(reason);
    return [...reasons];
  }, [ebayEligibilityById, eligibleEbayCount]);

  // CORRECTIVE PASS (third real-submission audit) — a DURABLE entry point
  // for "Reconcile failed batch" / "Retry Seller Hub draft", always
  // reachable on any fresh page load (computed straight from this row's
  // already-fetched feedBatchState), unlike Live Activity's own
  // View-error/Retry controls (DraftActivityPanel.tsx's own
  // retryableBatchId), which only ever appear for a transition observed
  // LIVE within the current browser session — a real gap this audit
  // found: a batch that failed in an EARLIER session (like the real
  // Batch #1) never gets a Live Activity entry on a fresh reload, so
  // that surface alone is not sufficient. Scoped to exactly one selected
  // listing (bulkCount === 1) to stay unambiguous — with several
  // listings selected across different blocking batches, only the
  // reasons list is shown, exactly as before.
  const ebayBlockingBatchAction = useMemo(() => {
    // Deliberately reads bulkSelectedIds.size directly, never the later-
    // declared `bulkCount` alias — this memo runs before that const's own
    // declaration during render.
    if (bulkSelectedIds.size !== 1) return null;
    const id = [...bulkSelectedIds][0];
    const state = listingsById.get(id)?.ebay?.feedBatchState;
    if (!state || state.kind === "none" || state.kind === "active") return null;
    return state;
  }, [bulkSelectedIds, listingsById]);

  // CORRECTIVE PASS (fourth real-submission audit — Phase 5/9: "queued
  // beyond a sensible threshold") — an "active" (genuinely in-flight)
  // batch offers "Resume processing" instead of silently saying
  // "Position 1" forever, in EITHER of two cases:
  //   (a) it's genuinely stalled — polled this session, but its status
  //       hasn't changed in EBAY_STALL_THRESHOLD_MS; or
  //   (b) it has NEVER been polled this session at all — a real gap this
  //       audit found: a batch whose box was previously dismissed (e.g.
  //       the real Batch #1) is excluded from ebayVisibleBatchIds on
  //       every fresh page load (GET /ebay-feed-batches's own "visible"
  //       filter), so ebayBatchStatusById never gets an entry for it —
  //       without case (b), such a batch would show no Resume control at
  //       all, not even after a genuine Retry, because nothing this
  //       session ever confirmed it was progressing OR stalled.
  // Deliberately separate from ebayBlockingBatchAction above (which
  // excludes "active" entirely) since this needs live poll data
  // (ebayBatchStatusById), not just the row's own already-fetched
  // feedBatchState.
  const ebayStalledBatchAction = useMemo(() => {
    if (bulkSelectedIds.size !== 1) return null;
    const id = [...bulkSelectedIds][0];
    const state = listingsById.get(id)?.ebay?.feedBatchState;
    if (!state || state.kind !== "active") return null;
    const status = ebayBatchStatusById.get(state.batchId);
    if (!status) return state; // case (b): never observed this session
    if (!isEbayBatchStalled(state.batchId, status.status)) return null;
    return state; // case (a): genuinely stalled
  }, [bulkSelectedIds, listingsById, ebayBatchStatusById, isEbayBatchStalled]);

  // CORRECTIVE PASS (fourth real-submission audit — Phase 7 action-area
  // redesign) — whether the single selected listing already has a
  // genuine, confirmed Seller Hub draft (independent of feedBatchState,
  // which only ever describes an in-flight or failed ATTEMPT — a
  // completed one clears differently, via ebayFeedDraftCreatedAt). Used
  // to offer "Open Seller Hub Drafts" as the one eBay primary action
  // instead of a disabled/absent Create button.
  const ebayAlreadyDraftedSingleSelection = useMemo(() => {
    if (bulkSelectedIds.size !== 1) return false;
    const id = [...bulkSelectedIds][0];
    return listingsById.get(id)?.ebay?.feedDraftCreatedAt != null;
  }, [bulkSelectedIds, listingsById]);

  // CORRECTIVE PASS — step 1: opens the preview dialog for every currently
  // ELIGIBLE selected listing (never the ineligible ones — nothing to
  // preview for a listing that won't be included). Purely read-only: no
  // batch, task, or upload is created by opening this. The dialog starts
  // in the "loading" phase and NEVER shows a row/blocker count — let
  // alone an enabled submit button — until a genuinely successful,
  // server-authoritative response has landed; see the phase state machine
  // below for every other transition.
  async function handleOpenEbayCreatePreview() {
    const ids = [...bulkSelectedIds].filter(id => ebayEligibilityById.get(id)?.eligible);
    if (!ids.length) return;
    setEbayPreviewOpen(true);
    setEbayPreviewPhase("loading");
    setEbayPreviewError("");
    setEbayPreviewRequestedCount(ids.length);
    setEbayPreviewRows([]);
    setEbayPreviewBlockers([]);
    setEbayPreviewPartialAck(false);
    try {
      const response = await fetch("/api/listing-studio/ebay-feed-batches/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setEbayPreviewError(body.error || "Could not build a preview for these listings."); setEbayPreviewPhase("failed"); return; }
      const rows = (body.rows ?? []) as Array<{ draftId: string; fields: Record<string, string>; completeInSellerHub: string[] }>;
      const blockers = (body.blockers ?? []) as Array<{ draftId: string; reason: string }>;
      setEbayPreviewRequestedCount(body.requestedCount ?? ids.length);
      setEbayPreviewRows(rows);
      setEbayPreviewBlockers(blockers);
      setEbayPreviewPhase(rows.length > 0 ? "ready" : "blocked");
    } catch {
      setEbayPreviewError("Network error — could not build a preview for these listings.");
      setEbayPreviewPhase("failed");
    }
  }

  // Retries the preview from the same selection — never re-triggers batch
  // creation, only ever the read-only preview.
  function handleRetryEbayPreview() {
    void handleOpenEbayCreatePreview();
  }

  // CORRECTIVE PASS — step 2: the actual, real batch creation, only ever
  // reached from the preview dialog's own explicit confirm button, which
  // is itself only ever enabled in the "ready" phase (see the dialog's
  // own disabled= expression below) — i.e. only once the server has
  // confirmed at least one real, valid row exists. Submits exactly the
  // draft ids that came back as real preview ROWS in this dialog's own
  // last successful response — never the raw earlier bulk selection —
  // so the count the user just reviewed and the count actually submitted
  // can never silently diverge.
  async function handleCreateEbayDrafts() {
    const ids = ebayPreviewRows.map(row => row.draftId);
    if (!ids.length || ebayCreatingDrafts) return;
    setEbayCreatingDrafts(true); setEbayCreateError(""); setEbayCreateMessage("");
    try {
      const response = await fetch("/api/listing-studio/ebay-feed-batches", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setEbayCreateError(body.error || "Could not create Seller Hub drafts."); return; }
      if (body.batchId) setEbayVisibleBatchIds(current => new Set(current).add(body.batchId));
      const skippedNote = body.skippedCount > 0 ? ` ${body.skippedCount} skipped: ${[...new Set((body.skipped as Array<{ reasons: string[] }>).flatMap(s => s.reasons))].join(", ")}.` : "";
      setEbayCreateMessage(`${body.eligibleCount} Seller Hub draft${body.eligibleCount === 1 ? "" : "s"} started.${skippedNote}`);
      setEbayPreviewOpen(false);
    } catch {
      setEbayCreateError("Network error — could not create Seller Hub drafts. Your selection has been kept.");
    } finally {
      setEbayCreatingDrafts(false);
    }
  }

  // PHASE 3/4 — the per-item "Retry failed draft" flow is RETIRED along
  // with the Inventory API route it called. This pipeline's unit of work
  // is a whole batch/CSV upload, not one row (see
  // lib/listing-studio/ebay-feed/feed-batches.ts's own header) — a failed
  // listing simply stays eligible and is picked up fresh the next time
  // it's selected and "Create Seller Hub draft" is clicked (see
  // components/listings-review/ListingDetailsPanel.tsx's own
  // EbayFailedDraftActions, which now only offers "View error").

  // Passed to BulkEbayPolicyControl — applies one shipping policy to every
  // eligible selected listing, then reloads so each row/tab reflects the
  // server's own final state (mirrors handleBulkAssignCategories' own
  // "one request, then reload" convention below).
  const handleApplyBulkEbayPolicy = useCallback(async (ebayPolicyId: string): Promise<BulkPolicyApplyResult> => {
    const ids = [...bulkSelectedIds];
    try {
      const response = await fetch("/api/listing-studio/listings-review/ebay-bulk-policy", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids, policyType: "FULFILLMENT", ebayPolicyId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { appliedCount: 0, skippedCount: ids.length, skipped: ids.map(draftId => ({ draftId, reason: body.error || "Could not apply." })) };
      await loadListings();
      return body as BulkPolicyApplyResult;
    } catch {
      return { appliedCount: 0, skippedCount: ids.length, skipped: ids.map(draftId => ({ draftId, reason: "Network error" })) };
    }
  }, [bulkSelectedIds, loadListings]);

  const handleCancelEbayBatch = useCallback(async (batchId: string) => {
    await fetch(`/api/listing-studio/ebay-feed-batches/${batchId}`, { method: "DELETE" }).catch(() => {});
  }, []);

  const handleDismissEbayBatchBox = useCallback(async (batchId: string) => {
    setEbayVisibleBatchIds(current => { const next = new Set(current); next.delete(batchId); return next; });
    setEbayBatchStatusById(current => { const next = new Map(current); next.delete(batchId); return next; });
    setEbayActivityDismissedBatchIds(current => new Set(current).add(batchId));
    setEbayActivityFilter(current => (current === batchId ? "all" : current));
    await fetch(`/api/listing-studio/ebay-feed-batches/${batchId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss_box" }),
    }).catch(() => {});
  }, []);

  const handleDismissEbayBatchActivity = useCallback((batchId: string) => {
    setEbayActivityDismissedBatchIds(current => new Set(current).add(batchId));
    setEbayActivityFilter(current => (current === batchId ? "all" : current));
    fetch(`/api/listing-studio/ebay-feed-batches/${batchId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss_activity" }),
    }).catch(() => {});
  }, []);

  // CORRECTIVE PASS (second real submission — Phase 7/8) — "View error"
  // opens a real dialog showing the batch's FULL, already-fetched
  // errorMessage (never the CSS-truncated Live Activity row's own text).
  const handleViewEbayBatchError = useCallback((batchId: string) => { setViewErrorBatchId(batchId); }, []);

  // "Retry Seller Hub draft" — a real confirmation step first (this
  // corrective task's own Phase 7 requirement), explaining what will
  // happen before any request is sent.
  const handleOpenRetryConfirm = useCallback((batchId: string) => { setRetryError(""); setRetryConfirmBatchId(batchId); }, []);

  const handleConfirmRetryEbayBatch = useCallback(async () => {
    if (!retryConfirmBatchId) return;
    const batchId = retryConfirmBatchId;
    setRetryingBatchId(batchId);
    setRetryError("");
    try {
      const response = await fetch(`/api/listing-studio/ebay-feed-batches/${batchId}/retry`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setRetryError(body?.error || "Could not retry this Seller Hub draft."); return; }
      // CORRECTIVE PASS (fourth real-submission audit — ROOT CAUSE of "Retry
      // returns to Queued forever") — this line was missing entirely. The
      // poll loop's own idsToPoll only ever considers
      // ebayVisibleBatchIdsRef.current (see that useEffect's own comment);
      // a batch whose box was previously dismissed (exactly Batch #1's real
      // state) is NOT in that set, so setting ebayBatchStatusById alone —
      // which is all this handler used to do — updated the DISPLAYED status
      // but left the batch permanently invisible to the very poll loop that
      // was supposed to keep driving it forward. Confirmed live: Batch #1's
      // real row was found genuinely healthy and claimable (generating_csv,
      // no stale lease, no zombie claim) minutes after a real Retry click —
      // nothing was ever broken at the data layer, nothing was ever
      // re-polling it. Retrying now un-dismisses the batch's box locally
      // (matches the real intent: you are actively working this batch
      // again) so it re-enters the poll loop immediately.
      setEbayVisibleBatchIds(current => new Set(current).add(batchId));
      // Reflect the fresh, now-non-terminal status immediately — the
      // existing poll loop (see the useEffect above) picks this batch back
      // up on its own next tick because it reads batch status fresh from
      // ebayBatchStatusById, never a value cached from before this retry.
      setEbayBatchStatusById(current => new Map(current).set(batchId, body as EbayBatchStatus));
      setEbayBatchStatusChangedAt(current => new Map(current).set(batchId, Date.now()));
      // Allow a LATER failure of this same batch to be logged again — it
      // was already logged once (the failure that led to this retry).
      ebayCompletedBatchesLoggedRef.current.delete(batchId);
      setEbayActivityEvents(current => [
        { id: `${batchId}:retried:${Date.now()}`, batchId, batchLabel: `Batch ${(body as EbayBatchStatus).displayNumber}`, tone: "sent", message: "Seller Hub draft attempt retried", timestampIso: new Date().toISOString() },
        ...current,
      ]);
      setRetryConfirmBatchId(null);
      // CORRECTIVE PASS (third real-submission audit) — row.ebay.feedBatchState
      // (the field eligibility/ebayBlockingBatchAction actually reads) comes
      // from a SEPARATE fetch (listings-review), never from
      // ebayBatchStatusById above — without this reload, the blocking
      // reason/action shown for this listing would stay stale until the
      // page's own next full data refresh.
      await loadListings();
    } catch {
      setRetryError("Could not reach the server to retry this Seller Hub draft.");
    } finally {
      setRetryingBatchId(null);
    }
  }, [retryConfirmBatchId, loadListings]);

  // CORRECTIVE PASS (third real-submission audit) — "Reconcile failed
  // batch": a genuinely SEPARATE action from Retry (own confirmation
  // boundary), makes NO eBay call at all — it only ever repairs a stale
  // local child row via reconcileInconsistentFailedFeedBatchItems.
  const handleOpenReconcileConfirm = useCallback((batchId: string) => { setReconcileError(""); setReconcileConfirmBatchId(batchId); }, []);

  const handleConfirmReconcileEbayBatch = useCallback(async () => {
    if (!reconcileConfirmBatchId) return;
    const batchId = reconcileConfirmBatchId;
    setReconcilingBatchId(batchId);
    setReconcileError("");
    try {
      const response = await fetch(`/api/listing-studio/ebay-feed-batches/${batchId}/reconcile`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setReconcileError(body?.error || "Could not reconcile this Seller Hub draft batch."); return; }
      // CORRECTIVE PASS (fourth real-submission audit) — same fix as
      // handleConfirmRetryEbayBatch: a previously-dismissed batch must
      // re-enter the visible/polled set once the user is actively working
      // it again, so its status (and any later Retry) stays live-observed.
      setEbayVisibleBatchIds(current => new Set(current).add(batchId));
      setEbayBatchStatusById(current => new Map(current).set(batchId, body as EbayBatchStatus));
      setReconcileConfirmBatchId(null);
      // Refreshes row.ebay.feedBatchState fresh from the server — once
      // reconciled, the item's own status is now genuinely 'failed', so
      // this listing's blocking state becomes "failed" (Retry available)
      // rather than "needs_reconciliation".
      await loadListings();
    } catch {
      setReconcileError("Could not reach the server to reconcile this Seller Hub draft batch.");
    } finally {
      setReconcilingBatchId(null);
    }
  }, [reconcileConfirmBatchId, loadListings]);

  // CORRECTIVE PASS (fourth real-submission audit — Phase 5) — "Resume
  // processing": runs exactly one safe tick via the EXISTING /process
  // route (never a special "force" path), which never re-creates a task
  // if one already exists (see feed-batches.ts's own "uploading" stage:
  // feedTaskHasInputFile is checked first, always). Also re-adds the
  // batch to the polled/visible set — the same root-cause fix Retry and
  // Reconcile now both apply — so a stalled batch stops being stalled for
  // real, not just for one manual click.
  const [resumingBatchId, setResumingBatchId] = useState<string | null>(null);
  const runResumeProcessing = useCallback(async (batchId: string) => {
    setResumingBatchId(batchId);
    setEbayVisibleBatchIds(current => new Set(current).add(batchId));
    try {
      const response = await fetch(`/api/listing-studio/ebay-feed-batches/${batchId}/process`, { method: "POST" });
      if (response.ok) {
        const body = await response.json() as EbayBatchStatus;
        setEbayBatchStatusById(current => new Map(current).set(batchId, body));
        setEbayBatchStatusChangedAt(current => new Map(current).set(batchId, Date.now()));
      }
      // A non-ok response is not surfaced as a hard error here — the
      // batch was already re-added to the visible/polled set above, so
      // the existing poll loop retries on its own very next tick
      // regardless (Phase 5's own "do not silently remain queued
      // forever, but also do not treat one transient failure as fatal").
    } catch { /* poll loop retries regardless — see above */ } finally {
      setResumingBatchId(null);
    }
  }, []);

  // CORRECTIVE PASS (fifth real-submission audit) — REQUIREMENT: Resume
  // processing must never be a bare, unwarned one-click action — unlike
  // Retry/Reconcile (both already gated behind their own confirm dialog),
  // Resume previously fired the instant its button was clicked. Resume is
  // NOT purely cosmetic: for a batch like this one (no ebay_task_id yet),
  // it can genuinely advance all the way through createTask/uploadFile —
  // a real, live eBay contact — so the user must see that stated plainly,
  // with no implication a draft already exists, before it ever fires.
  const [resumeConfirmBatchId, setResumeConfirmBatchId] = useState<string | null>(null);
  const handleOpenResumeConfirm = useCallback((batchId: string) => { setResumeConfirmBatchId(batchId); }, []);
  const handleConfirmResumeProcessing = useCallback(async () => {
    if (!resumeConfirmBatchId) return;
    const batchId = resumeConfirmBatchId;
    setResumeConfirmBatchId(null);
    await runResumeProcessing(batchId);
  }, [resumeConfirmBatchId, runResumeProcessing]);

  // Stuck-batch dismissal (product spec requirement) — a small × on each
  // stuck eBay batch row opens a real confirmation dialog (never a browser
  // alert), explaining that dismissing only removes it from the recovery
  // list and never deletes listings or completed drafts.
  //
  // CORRECTIVE PASS — the previous version of this handler called ONLY
  // dismiss_box, never DELETE (cancel), for a batch that might still be
  // genuinely non-terminal (pending_claim/in_progress). That hid the box
  // from view but left every still-queued item exactly as claimable as
  // before (rpc/listing_studio_claim_ebay_draft_batch_items only skips
  // completed/failed/cancelled items — a dismissed-but-not-cancelled batch
  // is invisible yet still fully claimable, and listing_studio_create_
  // ebay_draft_batch would still refuse to let the SAME listing start a
  // new batch, reporting a conflict the user can no longer see or resolve).
  // Cancelling FIRST (only ever touches still-queued items — anything
  // already mid-processing finishes or fails on its own, never
  // interrupted) makes the batch genuinely terminal, so the dismiss that
  // follows is the real, final word: hidden AND no longer claimable.
  const [ebayStuckConfirmOpen, setEbayStuckConfirmOpen] = useState(false);
  const [ebayStuckDismissing, setEbayStuckDismissing] = useState(false);
  function openEbayStuckDismissConfirm(batch: EbayStuckBatch) { setEbayDismissTarget(batch); setEbayStuckConfirmOpen(true); }
  async function confirmEbayStuckDismiss() {
    if (!ebayDismissTarget || ebayStuckDismissing) return;
    setEbayStuckDismissing(true);
    try {
      await fetch(`/api/listing-studio/ebay-feed-batches/${ebayDismissTarget.batchId}`, { method: "DELETE" }).catch(() => {});
      setEbayStuckConfirmOpen(false);
      setEbayStuckBatches(current => current.filter(b => b.batchId !== ebayDismissTarget.batchId));
      await handleDismissEbayBatchBox(ebayDismissTarget.batchId);
      setEbayDismissTarget(null);
    } finally {
      setEbayStuckDismissing(false);
    }
  }

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
    setBlockingBatch(null);
    try {
      const response = await fetch("/api/listing-studio/extension-batches", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSendToExtensionError(body.error || "Could not send these listings to the extension.");
        setSendToExtensionRejected(Array.isArray(body.rejected) ? body.rejected : []);
        setBlockingBatch(body.blockingBatch ?? null);
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

  // CORRECTIVE PASS — stuck-batch dismissal for the "Hidden active batch"
  // recovery panel. Previously this panel offered only "Recover stuck
  // batch", with no way to make an unwanted stale alert go away. A stale/
  // hidden batch is usually still genuinely non-terminal (pending_claim/
  // in_progress), so — unlike handleDismissBatchBox above, which the
  // ExtensionBatchGrid box only ever calls once a batch is ALREADY
  // terminal — dismissing here must first CANCEL it (only still-queued
  // items are affected; anything already preparing/filling/saving
  // finishes or fails on its own, exactly like the existing "×" on a
  // terminal batch box never touches in-flight work). Only once the
  // cancel has made the batch genuinely terminal does dismiss_box succeed
  // server-side (see the PATCH route's own "must be terminal" gate) —
  // this is what makes the alert's disappearance a real, final state
  // (no longer claimable/resumable) rather than merely hiding a batch
  // that could otherwise still finish, or block a fresh attempt at the
  // same listings, unseen.
  const [stuckDismissTarget, setStuckDismissTarget] = useState<RecoverableBatchInfo | null>(null);
  const [stuckDismissConfirmOpen, setStuckDismissConfirmOpen] = useState(false);
  const [stuckDismissing, setStuckDismissing] = useState(false);
  const [stuckDismissError, setStuckDismissError] = useState("");
  function openStuckDismissConfirm(batch: RecoverableBatchInfo) { setStuckDismissTarget(batch); setStuckDismissConfirmOpen(true); setStuckDismissError(""); }
  async function confirmStuckDismiss() {
    if (!stuckDismissTarget || stuckDismissing) return;
    setStuckDismissing(true);
    setStuckDismissError("");
    try {
      await fetch(`/api/listing-studio/extension-batches/${stuckDismissTarget.batchId}`, { method: "DELETE" });
      await fetch(`/api/listing-studio/extension-batches/${stuckDismissTarget.batchId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss_box" }),
      });
      setRecoverableBatches(current => current.filter(b => b.batchId !== stuckDismissTarget.batchId));
      setActivityDismissedBatchIds(current => new Set(current).add(stuckDismissTarget.batchId));
      setActivityFilter(current => (current === stuckDismissTarget.batchId ? "all" : current));
      setStuckDismissConfirmOpen(false);
      setStuckDismissTarget(null);
      await refreshRecoverableBatches();
    } catch {
      setStuckDismissError("Could not dismiss this batch — please try again.");
    } finally {
      setStuckDismissing(false);
    }
  }

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

  // Follow-up correction (orphaned extension batch recovery) — best-effort
  // refresh of the "recoverable" list alone (visibleBatchIds/batchMetaById
  // are deliberately left untouched here — this never re-resumes a batch
  // the session had already decided not to track).
  const refreshRecoverableBatches = useCallback(async () => {
    try {
      const response = await fetch("/api/listing-studio/extension-batches");
      if (!response.ok) return;
      const body = await response.json() as { recoverable?: RecoverableBatchInfo[] };
      setRecoverableBatches(body.recoverable ?? []);
    } catch { /* best-effort */ }
  }, []);

  // Opens the recovery dialog for one batch — reuses the SAME owner-scoped
  // batch-detail GET every live poll already uses, so the affected
  // listings/completed/unfinished counts shown are always the batch's
  // real, current, persisted state, never invented client-side.
  const openRecoverDialog = useCallback(async (info: RecoverableBatchInfo | BlockingBatchInfo) => {
    setRecoverError(""); setRecoverMessage(""); setRecoverStillActiveWarning(false);
    setRecoverDialogLoading(true);
    setRecoverDialogBatch({
      batchId: info.batchId, displayNumber: info.displayNumber, status: info.status, isHidden: info.isHidden,
      lastExtensionActivityAt: info.lastExtensionActivityAt, completedCount: 0, unfinishedCount: 0,
    });
    setRecoverDialogListings([]);
    try {
      const response = await fetch(`/api/listing-studio/extension-batches/${info.batchId}`);
      if (!response.ok) { setRecoverError("Could not load this batch's current details."); return; }
      const body = await response.json() as ExtensionBatchStatus;
      const completedCount = body.items.filter(item => item.status === "completed").length;
      const unfinishedCount = body.items.filter(item => item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled").length;
      setRecoverDialogBatch(current => current && current.batchId === info.batchId
        ? { ...current, status: body.status, completedCount, unfinishedCount } : current);
      setRecoverDialogListings(body.items.map(item => ({ draftId: item.draftId, title: item.generatedTitle ?? "", sku: item.sku })));
    } catch {
      setRecoverError("Could not load this batch's current details.");
    } finally {
      setRecoverDialogLoading(false);
    }
  }, []);

  const closeRecoverDialog = useCallback(() => {
    if (recovering) return; // never let a click-away close the dialog mid-request
    setRecoverDialogBatch(null); setRecoverDialogListings([]); setRecoverError(""); setRecoverStillActiveWarning(false);
  }, [recovering]);

  // Confirmation text (verbatim, per this feature's own requirement):
  // "Recover this stuck batch? Unfinished draft attempts will be released
  // and can be sent again. Confirmed Vinted drafts will be preserved." —
  // rendered by RecoverStuckBatchDialog itself; this handler only ever
  // fires on an explicit button click, never automatically.
  const handleRecoverBatch = useCallback(async (force: boolean) => {
    if (!recoverDialogBatch || recovering) return;
    setRecovering(true); setRecoverError("");
    try {
      const response = await fetch(`/api/listing-studio/extension-batches/${recoverDialogBatch.batchId}/recover`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.stillActive) {
          setRecoverStillActiveWarning(true);
          setRecoverError(body.error || "This batch still shows genuine, recent extension activity.");
          return;
        }
        setRecoverError(body.error || "Could not recover this batch.");
        return;
      }

      const releasedCount: number = body.releasedCount ?? 0;
      setRecoverMessage(body.wasNoop
        ? "This batch was already recovered — nothing left to release."
        : `${releasedCount} listing${releasedCount === 1 ? "" : "s"} released — you can send ${releasedCount === 1 ? "it" : "them"} to the extension again.`);

      const recoveredBatchId = recoverDialogBatch.batchId;
      // The recovered batch is now terminal — drop it from live tracking
      // (mirroring handleDismissBatchBox's own cleanup) and clear any
      // now-stale selection of the listings it was holding, so they can be
      // selected and sent again immediately without a stray leftover pick.
      setVisibleBatchIds(current => { if (!current.has(recoveredBatchId)) return current; const next = new Set(current); next.delete(recoveredBatchId); return next; });
      setBatchStatusById(current => { if (!current.has(recoveredBatchId)) return current; const next = new Map(current); next.delete(recoveredBatchId); return next; });
      const releasedDraftIds = new Set(recoverDialogListings.map(l => l.draftId));
      setBulkSelectedIds(current => {
        if (![...releasedDraftIds].some(id => current.has(id))) return current;
        const next = new Set(current);
        for (const id of releasedDraftIds) next.delete(id);
        return next;
      });
      setBlockingBatch(current => (current && current.batchId === recoveredBatchId ? null : current));

      await Promise.all([loadListings(), refreshRecoverableBatches()]);
      setRecoverDialogBatch(null); setRecoverDialogListings([]); setRecoverStillActiveWarning(false);
    } catch {
      setRecoverError("Network error — could not recover this batch.");
    } finally {
      setRecovering(false);
    }
  }, [recoverDialogBatch, recoverDialogListings, recovering, loadListings, refreshRecoverableBatches]);

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

  // Stage 6 (eBay draft batches) — the eBay equivalent of the Vinted poll
  // loop just above: one self-rescheduling 4s poll covering every visible,
  // not-yet-known-terminal eBay batch, diffing each poll's items against
  // the previous one to synthesize real Live Activity events (never
  // fabricated) — simpler than the Vinted version above since an eBay
  // item's own persisted `status` IS already the full granular stage
  // (queued/uploading_photos/creating_inventory_item/creating_draft/
  // verifying_draft/completed/failed), with no separate currentStep/detail
  // sub-fields to track. Completely independent state from the Vinted loop
  // — polling/dismissing/completing an eBay batch never touches
  // batchStatusById, activityEvents, or any other Vinted-only state above.
  const hasVisibleEbayBatches = ebayVisibleBatchIds.size > 0;
  useEffect(() => {
    if (!hasVisibleEbayBatches) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    function applyEbayBatchResult(batchId: string, body: EbayBatchStatus) {
      // CORRECTIVE PASS (fourth real-submission audit — Phase 5/9) —
      // previousStatus reads the REF (ebayBatchStatusByIdRef), never
      // component state directly, so this stays correct even though
      // applyEbayBatchResult is recreated only when hasVisibleEbayBatches
      // changes (see this effect's own dependency array) — a plain state
      // read here would risk a stale snapshot from whenever the effect
      // last ran. The actual changed-at VALUE is real React state (see
      // that state's own comment on why — a ref would be unsafe to read
      // during render, which ebayStalledBatchAction's own useMemo does),
      // updated here via its functional setter form so this still never
      // needs to read that particular piece of state directly either.
      const previousStatus = ebayBatchStatusByIdRef.current.get(batchId)?.status;
      setEbayBatchStatusChangedAt(current => {
        if (previousStatus === body.status && current.has(batchId)) return current;
        return new Map(current).set(batchId, Date.now());
      });
      setEbayBatchStatusById(current => new Map(current).set(batchId, body));
      const batchLabel = `Batch ${body.displayNumber}`;
      const previousItems = ebayPreviousItemsByBatchRef.current.get(batchId) ?? null;
      if (previousItems === null) {
        setEbayActivityEvents(current => [
          { id: `${batchId}:sent`, batchId, batchLabel, tone: "sent", message: `${body.items.length} listing${body.items.length === 1 ? "" : "s"} sent for Seller Hub drafting`, timestampIso: body.createdAt },
          ...current,
        ]);
      } else {
        const newEvents: ActivityEvent[] = [];
        for (const item of body.items) {
          const prev = previousItems.get(item.itemId);
          if (!prev || item.status === prev.status) continue;
          const label = item.generatedTitle || item.sku || "Listing";
          if (item.status === "succeeded") {
            newEvents.push({ id: `${item.itemId}:succeeded`, batchId, batchLabel, tone: "success", message: `${label} — Seller Hub draft created`, timestampIso: item.completedAt ?? new Date().toISOString() });
          } else if (item.status === "failed") {
            newEvents.push({ id: `${item.itemId}:failed`, batchId, batchLabel, tone: "failure", message: `${label} — failed: ${item.errorMessage ?? "Unknown error"}`, timestampIso: item.completedAt ?? new Date().toISOString() });
          } else {
            const stageLabel = EBAY_FEED_ITEM_STATUS_LABELS[item.status] ?? item.status;
            newEvents.push({ id: `${item.itemId}:${item.status}`, batchId, batchLabel, tone: "progress", message: `${label} — ${stageLabel.toLowerCase()}`, timestampIso: item.startedAt ?? new Date().toISOString() });
          }
        }
        if (newEvents.length > 0) setEbayActivityEvents(current => [...newEvents, ...current]);
      }
      ebayPreviousItemsByBatchRef.current.set(batchId, new Map(body.items.map(item => [item.itemId, item])));

      if (isEbayFeedBatchStatusTerminal(body.status) && !ebayCompletedBatchesLoggedRef.current.has(batchId)) {
        ebayCompletedBatchesLoggedRef.current.add(batchId);
        const succeededCount = body.items.filter(item => item.status === "succeeded").length;
        const failedCount = body.items.filter(item => item.status === "failed").length;
        // Truthful batch-summary wording (Phase 5's explicit requirement):
        // never claims success unless the result file actually confirmed
        // it, never omits a real partial failure.
        const message = body.status === "failed"
          ? `Batch failed — no Seller Hub drafts created${body.errorMessage ? `: ${body.errorMessage}` : ""}`
          : succeededCount === 0
            ? "No Seller Hub drafts created"
            : failedCount > 0
              ? `${succeededCount} Seller Hub draft${succeededCount === 1 ? "" : "s"} created, ${failedCount} need${failedCount === 1 ? "s" : ""} attention`
              : `${succeededCount} Seller Hub draft${succeededCount === 1 ? "" : "s"} created`;
        setEbayActivityEvents(current => [
          {
            id: `${batchId}:batch-complete`, batchId, batchLabel, tone: body.status === "failed" || failedCount > 0 ? "failure" : "success", message,
            timestampIso: body.completedAt ?? new Date().toISOString(),
            // CORRECTIVE PASS (second real submission — Phase 7/8) — only a
            // genuinely FAILED batch is retryable this way; a
            // completed_with_errors batch's own failed rows need a
            // different flow (see feed-batches.ts's own retryEbayFeedBatch
            // header) and are not offered "Retry Seller Hub draft" here.
            retryableBatchId: body.status === "failed" ? batchId : null,
          },
          ...current,
        ]);
        // Refreshes ebayDrafts so each completed row's Seller Hub draft
        // timestamp/readiness reflects the server's own final state
        // (mirrors the Vinted loop's own reliance on a fresh row load
        // after a batch completes — see handleRecoverBatch's own
        // loadListings() call).
        loadListings();
      }
    }

    async function poll() {
      const idsToPoll = [...ebayVisibleBatchIdsRef.current].filter(id => {
        const known = ebayBatchStatusByIdRef.current.get(id);
        return !known || !isEbayFeedBatchStatusTerminal(known.status);
      });
      if (idsToPoll.length === 0) { if (!cancelled) timeoutId = setTimeout(poll, 4000); return; }

      // POST .../process, not GET: this same call both advances real,
      // bounded, persisted work (advances the batch by exactly one Feed
      // pipeline stage) AND returns the batch's fresh full status, so
      // every poll tick this page is open is itself the client-triggered
      // driver of forward progress (see
      // lib/listing-studio/ebay-feed/feed-batches.ts's own header
      // comment) — never a read-only observer of work happening
      // somewhere else. A closed tab simply stops driving progress until
      // the once-daily cron sweep resumes it (see
      // app/api/cron/ebay-feed-processing/route.ts's own disclosed
      // limitation).
      const results = await Promise.all(idsToPoll.map(async id => {
        try {
          const response = await fetch(`/api/listing-studio/ebay-feed-batches/${id}/process`, { method: "POST" });
          if (!response.ok) return { id, ok: false as const, status: response.status };
          return { id, ok: true as const, body: await response.json() as EbayBatchStatus };
        } catch { return { id, ok: false as const, status: 0 }; }
      }));
      if (cancelled) return;

      for (const result of results) {
        if (!result.ok) {
          if (result.status === 404) {
            setEbayVisibleBatchIds(current => { const next = new Set(current); next.delete(result.id); return next; });
            setEbayBatchStatusById(current => { const next = new Map(current); next.delete(result.id); return next; });
          }
          continue;
        }
        applyEbayBatchResult(result.id, result.body);
      }
      if (!cancelled) timeoutId = setTimeout(poll, 4000);
    }
    poll();
    return () => { cancelled = true; if (timeoutId !== undefined) clearTimeout(timeoutId); };
  }, [hasVisibleEbayBatches, loadListings]);

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

  // Stage 6 (eBay draft batches) — the eBay equivalents of
  // batchBoxViewModels/anyBatchLive/activityFilterOptions/
  // visibleActivityEvents above. Reuses ExtensionBatchGrid.tsx directly:
  // an eBay batch's status is always 'pending'/'in_progress'/'completed'/
  // 'cancelled' — 'pending' renders that component's own "Preparing
  // batch…" state, 'in_progress' renders its "Processing — X of Y" +
  // Cancel state (the box's own generic wording never claims a
  // Vinted-specific "Vinted drafts" outcome), 'completed'/'cancelled'
  // render its terminal summary — its "waiting for pairing" branch is
  // simply never reached, since no eBay batch ever has status
  // 'pending_claim' and pairingCode is always null here.
  const ebayBatchBoxViewModels: BatchBoxViewModel[] = useMemo(() => [...ebayVisibleBatchIds].map(id => {
    const status = ebayBatchStatusById.get(id);
    if (!status) return { batchId: id, displayNumber: 0, browserLabel: null, status: "pending", listingCount: 0, completedCount: 0, failedCount: 0, cancelledCount: 0, currentItemLabel: null, pairingCode: null, expiresAt: null, codeCopied: false };
    const completedCount = status.items.filter(item => item.status === "succeeded").length;
    const failedCount = status.items.filter(item => item.status === "failed").length;
    const cancelledCount = status.items.filter(item => item.status === "cancelled").length;
    const inProgressItem = status.items.find(item => item.status !== "queued" && item.status !== "succeeded" && item.status !== "failed" && item.status !== "cancelled");
    const currentItemLabel = inProgressItem ? `${inProgressItem.generatedTitle || inProgressItem.sku || "Listing"} — ${EBAY_FEED_ITEM_STATUS_LABELS[inProgressItem.status] ?? inProgressItem.status}` : null;
    const isTerminal = isEbayFeedBatchStatusTerminal(status.status);
    // Truthful, per-batch terminal summary — see
    // components/listings-review/ExtensionBatchGrid.tsx's own
    // corrective-pass comment: never reuses that component's default
    // Vinted-specific wording ("saved to Vinted drafts") for an eBay batch.
    const terminalSummaryOverride = status.status === "failed"
      ? `Failed — no Seller Hub drafts created${status.errorMessage ? `: ${status.errorMessage}` : ""}.`
      : status.status === "cancelled"
        ? "Cancelled — no Seller Hub drafts created."
        : failedCount === 0
          ? `Completed — ${completedCount} Seller Hub draft${completedCount === 1 ? "" : "s"} created.`
          : `Completed — ${completedCount} of ${status.listingCount} Seller Hub drafts created, ${failedCount} failed.`;
    return {
      batchId: id, displayNumber: status.displayNumber, browserLabel: null,
      status: status.status, listingCount: status.listingCount, completedCount, failedCount, cancelledCount,
      currentItemLabel, pairingCode: null, expiresAt: null, codeCopied: false,
      isTerminalOverride: isTerminal, isInProgressOverride: !isTerminal, terminalSummaryOverride: isTerminal ? terminalSummaryOverride : undefined,
    };
  }).sort((a, b) => a.displayNumber - b.displayNumber), [ebayVisibleBatchIds, ebayBatchStatusById]);

  const anyEbayBatchLive = useMemo(() => [...ebayBatchStatusById.values()].some(status => !isEbayFeedBatchStatusTerminal(status.status)), [ebayBatchStatusById]);

  // PHASE 5 — "Open Seller Hub Drafts" + a SKU/title reminder so the user
  // can actually locate their new drafts once there. This app never
  // auto-publishes, so this link is the required next step, not a
  // convenience shortcut past it. Only shows listings that genuinely
  // succeeded (a real, confirmed Seller Hub draft), never a queued/failed
  // one.
  const ebaySucceededItems = useMemo(() => {
    const items: Array<{ id: string; label: string }> = [];
    for (const status of ebayBatchStatusById.values()) {
      for (const item of status.items) if (item.status === "succeeded") items.push({ id: item.itemId, label: item.generatedTitle || item.sku || "Listing" });
    }
    return items;
  }, [ebayBatchStatusById]);

  const ebayActivityFilterOptions: ActivityBatchFilter[] = useMemo(() =>
    [...ebayBatchStatusById.entries()]
      .filter(([id]) => !ebayActivityDismissedBatchIds.has(id))
      .sort((a, b) => a[1].displayNumber - b[1].displayNumber)
      .map(([id, status]) => ({ batchId: id, label: `Batch ${status.displayNumber}` })),
  [ebayBatchStatusById, ebayActivityDismissedBatchIds]);

  const visibleEbayActivityEvents = useMemo(() => ebayActivityEvents.filter(event =>
    !ebayActivityDismissedBatchIds.has(event.batchId) && (ebayActivityFilter === "all" || event.batchId === ebayActivityFilter),
  ), [ebayActivityEvents, ebayActivityDismissedBatchIds, ebayActivityFilter]);

  // Corrective pass — which marketplaces to offer in the Workflow-column
  // toggle. "VINTED" is no longer unconditionally included: this page can
  // now genuinely contain ONLY eBay-only listings (see the listings-
  // review route's own unified-row-model header comment), in which case
  // showing a pointless Vinted option (with zero rows ever able to
  // display anything but "Not prepared" under it) would violate the
  // product spec's own "If it contains only eBay preparations, show no
  // unnecessary toggle and display eBay" rule just as much as the
  // reverse case would.
  const marketplaceToggleOptions: ListingMarketplaceView[] = useMemo(() => {
    const options: ListingMarketplaceView[] = [];
    if (listingRows.some(row => row.hasVintedPreparation)) options.push("VINTED");
    if (listingRows.some(row => row.hasEbayPreparation)) options.push("EBAY_UK");
    return options.length ? options : ["VINTED"]; // defensive — an empty page has nothing to toggle either way
  }, [listingRows]);

  // Auto-corrects the active Workflow/Live-Activity channel the instant
  // it stops being one of the genuinely available options (e.g. the last
  // Vinted-prepared row on the page gets deleted while eBay view isn't
  // already selected) — never leaves the page silently stuck showing a
  // channel with nothing real behind it.
  useEffect(() => {
    if (!marketplaceToggleOptions.includes(workflowMarketplaceView)) setWorkflowMarketplaceView(marketplaceToggleOptions[0]);
  }, [marketplaceToggleOptions, workflowMarketplaceView]);
  useEffect(() => {
    if (!marketplaceToggleOptions.includes(activityChannel)) setActivityChannel(marketplaceToggleOptions[0]);
  }, [marketplaceToggleOptions, activityChannel]);

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
        <div><strong>{channelListingsCount}</strong><span className="lr-kpi-label">Listings</span></div>
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
      {/* Error-message improvement (orphaned extension batch recovery) —
          identifies the actual owner-owned batch behind a
          "already part of another active batch" conflict, and offers the
          correct next step for it: a genuinely visible/active batch only
          ever offers "View active batch" (scroll to its box); a
          hidden/stale one offers "Recover stuck batch" directly. */}
      {blockingBatch && <span className="lr-blocking-batch-actions">
        {!blockingBatch.isHidden && !blockingBatch.isStale
          ? <button type="button" onClick={() => document.querySelector(`[role="group"][aria-label="Batch ${blockingBatch.displayNumber}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              View active batch #{blockingBatch.displayNumber}
            </button>
          : <button type="button" onClick={() => openRecoverDialog(blockingBatch)}>Recover stuck batch #{blockingBatch.displayNumber}</button>}
      </span>}
    </div>}

    {recoverMessage && <div className="lr-bulk-message" role="status">{recoverMessage}</div>}

    {/* Follow-up correction (orphaned extension batch recovery) — an
        active/nonterminal batch must never become permanently invisible
        just because its box was dismissed, or silently unrecoverable just
        because it went stale. Every batch GET /extension-batches reports
        as `recoverable` (hidden, stale, or both) gets a row here — this is
        the ONLY place a hidden active batch is ever surfaced again. */}
    {recoverableBatches.length > 0 && <section className="lr-hidden-batches-section" aria-label="Hidden or stuck active batches">
      <p className="lr-hidden-batches-title">Hidden active batch{recoverableBatches.length === 1 ? "" : "es"}</p>
      {recoverableBatches.map(batch => <div key={batch.batchId} className="lr-hidden-batch-row">
        <span className="lr-hidden-batch-label">
          Batch #{batch.displayNumber} — {batch.status}{batch.isHidden ? ", hidden" : ""}{batch.isStale ? ", stale" : ""} — {batch.listingCount} listing{batch.listingCount === 1 ? "" : "s"}
        </span>
        <span className="lr-hidden-batch-actions">
          <button type="button" className="lr-hidden-batch-recover-button" onClick={() => openRecoverDialog(batch)}>Recover stuck batch</button>
          <button
            type="button" className="lr-hidden-batch-dismiss" title={`Dismiss Batch #${batch.displayNumber}`}
            aria-label={`Dismiss Batch #${batch.displayNumber}`} onClick={() => openStuckDismissConfirm(batch)}
          >×</button>
        </span>
      </div>)}
    </section>}
    {stuckDismissConfirmOpen && stuckDismissTarget && <ConfirmDialog
      title={`Dismiss stuck Batch #${stuckDismissTarget.displayNumber}?`}
      message="This cancels the batch's remaining queued work (anything already sent to Vinted stays exactly as it is), releases its listings so Send to extension can be tried again, and removes the alert. The batch and its history are kept for reference, never deleted."
      confirmLabel="Cancel & dismiss batch"
      confirming={stuckDismissing}
      confirmingLabel="Dismissing…"
      error={stuckDismissError}
      onConfirm={confirmStuckDismiss}
      onCancel={() => { setStuckDismissConfirmOpen(false); setStuckDismissTarget(null); }}
    />}

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

    {recoverDialogBatch && !recoverDialogLoading && <RecoverStuckBatchDialog
      batch={recoverDialogBatch}
      listings={recoverDialogListings}
      stillActiveWarning={recoverStillActiveWarning}
      recovering={recovering}
      error={recoverError}
      onKeepWaiting={closeRecoverDialog}
      onRecover={handleRecoverBatch}
    />}

    {/* Stage 6 (eBay draft batches) — same full-width position/behaviour
        as the Vinted "Hidden active batch" section and batch grid just
        above, entirely independent state: dismissing/recovering an eBay
        batch never touches a Vinted one, and vice versa. */}
    {ebayStuckBatches.length > 0 && <section className="lr-hidden-batches-section" aria-label="Stuck Seller Hub draft batches">
      <p className="lr-hidden-batches-title">Stuck Seller Hub draft batch{ebayStuckBatches.length === 1 ? "" : "es"}</p>
      {ebayStuckBatches.map(batch => <div key={batch.batchId} className="lr-hidden-batch-row">
        <span className="lr-hidden-batch-label">Batch #{batch.displayNumber} — {batch.status} — {batch.listingCount} listing{batch.listingCount === 1 ? "" : "s"}</span>
        <button type="button" className="lr-hidden-batch-recover-button" onClick={() => openEbayStuckDismissConfirm(batch)}>Dismiss batch</button>
      </div>)}
    </section>}

    <ExtensionBatchGrid
      batches={ebayBatchBoxViewModels}
      onCancel={handleCancelEbayBatch}
      onDismissBox={handleDismissEbayBatchBox}
      onCopyCode={() => {}}
    />

    {ebaySucceededItems.length > 0 && <div className="lr-ebay-seller-hub-summary" role="status">
      <a href={SELLER_HUB_DRAFTS_URL} target="_blank" rel="noreferrer" className="button-secondary">Open Seller Hub Drafts ↗</a>
      <p>{ebaySucceededItems.length} listing{ebaySucceededItems.length === 1 ? "" : "s"} created — look for: {ebaySucceededItems.map(item => item.label).join(", ")}</p>
    </div>}

    {ebayStuckConfirmOpen && ebayDismissTarget && <ConfirmDialog
      title={`Dismiss stuck Seller Hub draft batch #${ebayDismissTarget.displayNumber}?`}
      message="This cancels the batch's remaining queued work (anything already created stays exactly as it is — no Seller Hub draft is ever undone), releases its listings so they can be tried again, and removes the alert. The batch and its history are kept for reference, never deleted."
      confirmLabel="Cancel & dismiss batch"
      confirming={ebayStuckDismissing}
      confirmingLabel="Dismissing…"
      onConfirm={confirmEbayStuckDismiss}
      onCancel={() => { setEbayStuckConfirmOpen(false); setEbayDismissTarget(null); }}
    />}

    {/* CORRECTIVE PASS — the pre-submission preview + confirmation dialog,
        driven entirely by ebayPreviewPhase. Shows exactly which values
        will transfer to each Seller Hub draft and which fields the user
        must complete themselves in Seller Hub afterward — never claims
        full field transfer. The confirmation wording states plainly: this
        creates drafts, never publishes them, and the user must open
        Seller Hub to review and list them. The submit button is enabled
        ONLY in the "ready" phase (at least one real, server-confirmed
        row) — a loading or failed preview, or one with zero eligible
        rows, can never show an enabled submit action, and its own count
        never renders as a bare "0" the moment before that's true. */}
    {ebayPreviewOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !ebayCreatingDrafts) setEbayPreviewOpen(false); }}>
      <div className="confirm-dialog lr-ebay-preview-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ebay-preview-title" aria-describedby="ebay-preview-body">
        <button className="dialog-close" type="button" onClick={() => setEbayPreviewOpen(false)} aria-label="Close" disabled={ebayCreatingDrafts}>×</button>

        {ebayPreviewPhase === "loading" && <div className="dialog-copy">
          <h2 id="ebay-preview-title">Preparing Seller Hub draft preview…</h2>
          <p id="ebay-preview-body" className="lr-bulk-message" role="status">Checking {ebayPreviewRequestedCount} listing{ebayPreviewRequestedCount === 1 ? "" : "s"}…</p>
        </div>}

        {ebayPreviewPhase === "failed" && <>
          <div className="dialog-copy">
            <h2 id="ebay-preview-title">Preview failed</h2>
            <p id="ebay-preview-body" className="import-select-error" role="alert">{ebayPreviewError || "Could not build a preview for these listings."}</p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="dialog-cancel" onClick={() => setEbayPreviewOpen(false)}>Close</button>
            <button type="button" className="button-secondary" onClick={handleRetryEbayPreview}>Try preview again</button>
          </div>
        </>}

        {(ebayPreviewPhase === "ready" || ebayPreviewPhase === "blocked") && <>
          <div className="dialog-copy">
            <h2 id="ebay-preview-title">
              {ebayPreviewRows.length > 0
                ? `Create ${ebayPreviewRows.length} Seller Hub draft${ebayPreviewRows.length === 1 ? "" : "s"}?`
                : "No listings are ready for a Seller Hub draft"}
            </h2>
            {ebayPreviewRows.length > 0 && <p id="ebay-preview-body">
              This creates {ebayPreviewRows.length === 1 ? "a draft" : "drafts"} in eBay Seller Hub. It does <strong>not</strong> publish{" "}
              {ebayPreviewRows.length === 1 ? "it" : "them"} — you must open Seller Hub yourself to review and list{" "}
              {ebayPreviewRows.length === 1 ? "it" : "them"}. Exactly {ebayPreviewRows.length} row{ebayPreviewRows.length === 1 ? "" : "s"} will be uploaded to eBay.
            </p>}
          </div>

          {ebayPreviewBlockers.length > 0 && <div className="lr-ebay-preview-blockers">
            <strong>{ebayPreviewRows.length > 0 ? `${ebayPreviewBlockers.length} listing${ebayPreviewBlockers.length === 1 ? "" : "s"} will be skipped:` : "Every selected listing is blocked:"}</strong>
            <ul>{ebayPreviewBlockers.map(b => <li key={b.draftId}>{b.reason}</li>)}</ul>
          </div>}

          {ebayPreviewRows.length > 0 && <div className="lr-ebay-preview-list">
            {ebayPreviewRows.map(row => (
              <div key={row.draftId} className="lr-ebay-preview-row">
                <p className="lr-ebay-preview-title">{row.fields.Title}</p>
                <dl className="lr-ebay-preview-fields">
                  <div><dt>Action</dt><dd>Draft</dd></div>
                  <div><dt>SKU</dt><dd>{row.fields["Custom label (SKU)"]}</dd></div>
                  <div><dt>Category ID</dt><dd>{row.fields["Category ID"]}</dd></div>
                  <div><dt>Price</dt><dd>£{row.fields.Price}</dd></div>
                  <div><dt>Quantity</dt><dd>{row.fields.Quantity}</dd></div>
                  <div><dt>Condition</dt><dd>{row.fields["Condition ID"]}</dd></div>
                  <div><dt>Photo</dt><dd>{row.fields["Item photo URL"]}</dd></div>
                </dl>
                {row.fields.Description && <p className="lr-ebay-preview-description">{row.fields.Description}</p>}
                {row.completeInSellerHub.length > 0 && <div className="lr-ebay-preview-complete-note">
                  <strong>Complete in Seller Hub:</strong>
                  <ul>{row.completeInSellerHub.map(note => <li key={note}>{note}</li>)}</ul>
                </div>}
              </div>
            ))}
          </div>}

          {/* Explicit acknowledgement required for a PARTIAL submission
              (some eligible, some blocked) — never implied merely by the
              dialog being open. Not shown when every selected listing is
              eligible (nothing partial to acknowledge), nor when NONE are
              (there is nothing to submit at all). */}
          {ebayPreviewRows.length > 0 && ebayPreviewBlockers.length > 0 && <label className="lr-ebay-preview-ack">
            <input type="checkbox" checked={ebayPreviewPartialAck} onChange={event => setEbayPreviewPartialAck(event.target.checked)} />
            I understand {ebayPreviewBlockers.length} listing{ebayPreviewBlockers.length === 1 ? "" : "s"} will be skipped and only {ebayPreviewRows.length} will be submitted.
          </label>}

          <div className="dialog-actions">
            <button type="button" className="dialog-cancel" onClick={() => setEbayPreviewOpen(false)} disabled={ebayCreatingDrafts}>Cancel</button>
            <button
              type="button" className="dialog-confirm"
              disabled={
                ebayCreatingDrafts
                || ebayPreviewRows.length === 0
                || (ebayPreviewBlockers.length > 0 && !ebayPreviewPartialAck)
              }
              onClick={handleCreateEbayDrafts}
            >
              {ebayCreatingDrafts ? "Creating…" : `Create ${ebayPreviewRows.length} Seller Hub draft${ebayPreviewRows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </>}
      </div>
    </div>}

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
          activeMarketplace={workflowMarketplaceView}
          marketplaceToggleOptions={marketplaceToggleOptions}
          onMarketplaceChange={setWorkflowMarketplaceView}
        />
        {/* CORRECTIVE PASS (fourth real-submission audit — Phase 7 action-
            area redesign). Two deliberately separate pieces, never one
            jumbled row:
              1. lr-bulk-bar — the SELECTION toolbar: who's selected, plus
                 a small, fixed set of ACTION CONTROLS (never long text,
                 never a variable-height explanation).
              2. lr-ebay-status-panel — a full-width block BELOW the
                 toolbar, shown only when there's something to explain
                 (blocked/needs-reconciliation/failed/stalled). Carries the
                 explanation AND that state's own single primary action
                 button, so the toolbar row itself never has to grow to fit
                 prose or hold more than one eBay action at a time. */}
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
            {/* REQUIREMENT (Phase 7): Vinted's Send to extension must never
                appear while the active selected workflow is eBay. */}
            {workflowMarketplaceView === "VINTED" && <button
              type="button"
              className="button"
              disabled={sendToExtensionRunning || bulkCount > MAX_EXTENSION_BATCH_LISTINGS}
              title={bulkCount > MAX_EXTENSION_BATCH_LISTINGS ? `Select at most ${MAX_EXTENSION_BATCH_LISTINGS} listings for the extension at once.` : "Fills Vinted's Create Listing form via the Chrome extension and saves each item as a draft — never publishes anything"}
              onClick={() => handleSendToExtension()}
            >
              {sendToExtensionRunning ? "Preparing batch…" : `Send ${bulkCount} to extension`}
            </button>}
            {/* Stage 6 (eBay draft batches) — sibling eBay actions, same
                design language, entirely independent of the Vinted button
                above (creating eBay drafts never touches Vinted state, and
                vice versa). REQUIREMENT (Phase 7): only shown while the
                active selected workflow is eBay — never a Vinted-mode
                leftover, and never more than ONE eBay primary action. */}
            {marketplaceToggleOptions.includes("EBAY_UK") && workflowMarketplaceView === "EBAY_UK" && ebayBatchingAvailable && <>
              <BulkEbayPolicyControl
                eligibleCount={eligibleEbayCount}
                policies={ebayPolicies}
                onApply={handleApplyBulkEbayPolicy}
              />
              {eligibleEbayCount > 0 && (
                <button
                  type="button"
                  className="button"
                  disabled={ebayCreatingDrafts}
                  title="Creates genuine, editable drafts in eBay Seller Hub — never publishes anything"
                  onClick={handleOpenEbayCreatePreview}
                >
                  {`Create ${eligibleEbayCount} Seller Hub draft${eligibleEbayCount === 1 ? "" : "s"}`}
                </button>
              )}
              {/* REQUIREMENT (Phase 7): a genuinely completed listing's one
                  primary action is opening Seller Hub itself — never a
                  disabled Create button, never squeezed beside Retry text. */}
              {eligibleEbayCount === 0 && ebayAlreadyDraftedSingleSelection && (
                <a className="button" href={SELLER_HUB_DRAFTS_URL} target="_blank" rel="noreferrer">Open Seller Hub Drafts ↗</a>
              )}
            </>}
          </div>
        </div>}
        {marketplaceToggleOptions.includes("EBAY_UK") && workflowMarketplaceView === "EBAY_UK" && bulkCount > 0 && !ebayBatchingAvailable && (
          <div className="lr-ebay-status-panel" role="status">
            <p className="lr-ebay-status-panel-title">Seller Hub draft database upgrade required</p>
            <p className="lr-ebay-status-panel-body">This database hasn&apos;t been upgraded to support Seller Hub drafts yet. Per-item eBay editing above is unaffected.</p>
          </div>
        )}
        {/* REQUIREMENT (Phase 7): a full-width panel, never squeezed into
            the button row — one clear title, the real reasons, and this
            state's own single primary action (Reconcile / Retry / Resume /
            View error), never combined, never overlapping the toolbar
            above. Never an unexplained "Create 0 Seller Hub drafts": every
            distinct reason blocking every selected, eBay-workflow,
            ineligible listing is shown here instead of guessing. */}
        {marketplaceToggleOptions.includes("EBAY_UK") && ebayBatchingAvailable && workflowMarketplaceView === "EBAY_UK" && bulkCount > 0 && eligibleEbayCount === 0 && !ebayAlreadyDraftedSingleSelection && ebayIneligibleBlockingReasons.length > 0 && (
          <div className="lr-ebay-status-panel" role="status">
            <p className="lr-ebay-status-panel-title">
              {ebayBlockingBatchAction?.kind === "needs_reconciliation" ? "Failed — local batch state needs reconciliation"
                : ebayBlockingBatchAction?.kind === "failed" ? "Failed"
                : ebayStalledBatchAction ? "Queued — processing has not started"
                : bulkCount === 1 ? "This listing isn't ready for a Seller Hub draft yet" : "None of the selected listings are ready for a Seller Hub draft yet"}
            </p>
            <ul className="lr-ebay-status-panel-reasons">
              {ebayIneligibleBlockingReasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>
            <div className="lr-ebay-status-panel-actions">
              {ebayBlockingBatchAction?.kind === "needs_reconciliation" && (
                <button type="button" className="button" onClick={() => handleOpenReconcileConfirm(ebayBlockingBatchAction.batchId)}>Reconcile failed batch</button>
              )}
              {ebayBlockingBatchAction?.kind === "failed" && <>
                <button type="button" className="button" onClick={() => handleOpenRetryConfirm(ebayBlockingBatchAction.batchId)}>Retry Seller Hub draft</button>
                <button type="button" className="button-secondary" onClick={() => handleViewEbayBatchError(ebayBlockingBatchAction.batchId)}>View error</button>
              </>}
              {ebayStalledBatchAction && (
                <button type="button" className="button" disabled={resumingBatchId === ebayStalledBatchAction.batchId} onClick={() => handleOpenResumeConfirm(ebayStalledBatchAction.batchId)}>
                  {resumingBatchId === ebayStalledBatchAction.batchId ? "Resuming…" : "Resume processing"}
                </button>
              )}
            </div>
          </div>
        )}
        {ebayCreateError && <div className="home-error" role="alert">{ebayCreateError}</div>}
        {ebayCreateMessage && <div className="lr-bulk-message" role="status">{ebayCreateMessage}</div>}
      </div>
      <div className="lr-rail">
        <ListingDetailsPanel
          listing={selectedListing}
          position={selectedListingPosition}
          markingReady={markingReadyId === selectedListingId}
          assigningCategory={assigningCategoryId === selectedListingId}
          reassessingAudience={reassessingAudienceId === selectedListingId}
          ebayPolicies={ebayPolicies}
          ebayLocations={ebayLocations}
          onEbaySettingsSaved={handleEbaySettingsSaved}
          activeWorkflowChannel={workflowMarketplaceView}
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
          events={activityChannel === "VINTED" ? visibleActivityEvents : visibleEbayActivityEvents}
          isLive={activityChannel === "VINTED" ? anyBatchLive : anyEbayBatchLive}
          filters={activityChannel === "VINTED" ? activityFilterOptions : ebayActivityFilterOptions}
          selectedFilter={activityChannel === "VINTED" ? activityFilter : ebayActivityFilter}
          onSelectFilter={activityChannel === "VINTED" ? setActivityFilter : setEbayActivityFilter}
          onDismissActivity={activityChannel === "VINTED" ? handleDismissBatchActivity : handleDismissEbayBatchActivity}
          channel={activityChannel}
          onChannelChange={setActivityChannel}
          showChannelToggle={marketplaceToggleOptions.includes("EBAY_UK")}
          onViewError={activityChannel === "EBAY_UK" ? handleViewEbayBatchError : undefined}
          onRetryBatch={activityChannel === "EBAY_UK" ? handleOpenRetryConfirm : undefined}
        />
      </div>
    </div>}

    {/* CORRECTIVE PASS (second real submission — Phase 8) — "View error":
        the FULL, un-truncated, already-sanitised error this app stored for
        the batch, never the CSS-truncated Live Activity row text, and
        never a raw eBay/database response. */}
    {viewErrorBatchId && (() => {
      const status = ebayBatchStatusById.get(viewErrorBatchId);
      return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setViewErrorBatchId(null); }}>
        <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="view-error-title" aria-describedby="view-error-body">
          <button className="dialog-close" type="button" onClick={() => setViewErrorBatchId(null)} aria-label="Close">×</button>
          <div className="dialog-copy">
            <h2 id="view-error-title">Batch {status?.displayNumber ?? "?"} — {status ? "no Seller Hub draft was created" : "details unavailable"}</h2>
            <p id="view-error-body" className="import-select-error" role="alert">
              {status?.errorMessage || "No further detail was recorded for this failure."}
            </p>
            {status?.errorCode && <p className="lr-bulk-message">Diagnostic code: {status.errorCode}</p>}
          </div>
          <div className="dialog-actions dialog-actions-single">
            <button type="button" className="dialog-cancel" onClick={() => setViewErrorBatchId(null)}>Close</button>
          </div>
        </div>
      </div>;
    })()}

    {/* CORRECTIVE PASS (second real submission — Phase 7) — a real
        confirmation step before ANY retry request is sent, explaining
        exactly what will (and will not) happen — this task's own explicit
        requirement. The actual retry is never triggered merely by opening
        this dialog. */}
    {retryConfirmBatchId && (() => {
      // CORRECTIVE PASS (third real-submission audit) — ebayBatchStatusById
      // is only ever populated by Live Activity's own session-scoped
      // polling (see this file's own header on that gap); when this
      // dialog was opened from the DURABLE blocking-reasons panel instead
      // (e.g. Batch #1, whose box was dismissed in an earlier session),
      // that map has nothing for this batchId — fall back to the
      // currently-selected row's own already-fetched feedBatchState/
      // errorMessage, which is always fresh regardless of session history.
      const status = ebayBatchStatusById.get(retryConfirmBatchId);
      const selectedRow = bulkSelectedIds.size === 1 ? listingsById.get([...bulkSelectedIds][0]) : undefined;
      const fallbackState = selectedRow?.ebay?.feedBatchState;
      const displayNumber = status?.displayNumber ?? (fallbackState && fallbackState.kind !== "none" && fallbackState.batchId === retryConfirmBatchId ? fallbackState.displayNumber : undefined);
      const errorMessage = status?.errorMessage ?? selectedRow?.ebay?.errorMessage ?? null;
      const retrying = retryingBatchId === retryConfirmBatchId;
      return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !retrying) setRetryConfirmBatchId(null); }}>
        <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="retry-title" aria-describedby="retry-body">
          <button className="dialog-close" type="button" onClick={() => setRetryConfirmBatchId(null)} aria-label="Close" disabled={retrying}>×</button>
          <div className="dialog-copy">
            <h2 id="retry-title">Retry Seller Hub Batch {displayNumber ?? "?"}?</h2>
            <p id="retry-body">
              Batch {displayNumber ?? "?"} previously failed{errorMessage ? `: ${errorMessage}` : "."} Retrying will first check
              whether eBay already has a record of this attempt, so it never creates a duplicate upload — it will not publish anything, and it will not
              create a new task if one already accepted this batch&apos;s file.
            </p>
          </div>
          {retryError && <p className="import-select-error" role="alert">{retryError}</p>}
          <div className="dialog-actions">
            <button type="button" className="dialog-cancel" onClick={() => setRetryConfirmBatchId(null)} disabled={retrying}>Cancel</button>
            <button type="button" className="dialog-confirm" onClick={handleConfirmRetryEbayBatch} disabled={retrying}>{retrying ? "Retrying…" : "Retry Seller Hub draft"}</button>
          </div>
        </div>
      </div>;
    })()}

    {/* CORRECTIVE PASS (third real-submission audit — Phase 4/5) —
        "Reconcile failed batch": a genuinely separate confirmation
        boundary from Retry. Explicitly states this makes NO eBay call. */}
    {reconcileConfirmBatchId && (() => {
      const status = ebayBatchStatusById.get(reconcileConfirmBatchId);
      const selectedRow = bulkSelectedIds.size === 1 ? listingsById.get([...bulkSelectedIds][0]) : undefined;
      const fallbackState = selectedRow?.ebay?.feedBatchState;
      const displayNumber = status?.displayNumber ?? (fallbackState && fallbackState.kind !== "none" && fallbackState.batchId === reconcileConfirmBatchId ? fallbackState.displayNumber : undefined);
      const reconciling = reconcilingBatchId === reconcileConfirmBatchId;
      return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !reconciling) setReconcileConfirmBatchId(null); }}>
        <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reconcile-title" aria-describedby="reconcile-body">
          <button className="dialog-close" type="button" onClick={() => setReconcileConfirmBatchId(null)} aria-label="Close" disabled={reconciling}>×</button>
          <div className="dialog-copy">
            <h2 id="reconcile-title">Reconcile Seller Hub Batch {displayNumber ?? "?"}?</h2>
            <p id="reconcile-body">
              Batch {displayNumber ?? "?"} already failed, but this listing&apos;s own local record was never fully updated to match. This step makes{" "}
              <strong>no request to eBay at all</strong> — it only corrects this application&apos;s own local record. Once reconciled, a separate,
              explicit &quot;Retry Seller Hub draft&quot; action becomes available if you want to try again.
            </p>
          </div>
          {reconcileError && <p className="import-select-error" role="alert">{reconcileError}</p>}
          <div className="dialog-actions">
            <button type="button" className="dialog-cancel" onClick={() => setReconcileConfirmBatchId(null)} disabled={reconciling}>Cancel</button>
            <button type="button" className="dialog-confirm" onClick={handleConfirmReconcileEbayBatch} disabled={reconciling}>{reconciling ? "Reconciling…" : "Reconcile failed batch"}</button>
          </div>
        </div>
      </div>;
    })()}

    {/* CORRECTIVE PASS (fifth real-submission audit) — REQUIREMENT: Resume
        processing must explain, before it ever fires, that it contacts
        eBay directly and may create a real Seller Hub draft — never an
        implication that a draft already exists (this batch's own
        ebay_task_id is still null; a resume from here can genuinely reach
        createTask/uploadFile for the first time). */}
    {resumeConfirmBatchId && (() => {
      const status = ebayBatchStatusById.get(resumeConfirmBatchId);
      const selectedRow = bulkSelectedIds.size === 1 ? listingsById.get([...bulkSelectedIds][0]) : undefined;
      const fallbackState = selectedRow?.ebay?.feedBatchState;
      const displayNumber = status?.displayNumber ?? (fallbackState && fallbackState.kind !== "none" && fallbackState.batchId === resumeConfirmBatchId ? fallbackState.displayNumber : undefined);
      const resuming = resumingBatchId === resumeConfirmBatchId;
      return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !resuming) setResumeConfirmBatchId(null); }}>
        <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="resume-title" aria-describedby="resume-body">
          <button className="dialog-close" type="button" onClick={() => setResumeConfirmBatchId(null)} aria-label="Close" disabled={resuming}>×</button>
          <div className="dialog-copy">
            <h2 id="resume-title">Resume Seller Hub Batch {displayNumber ?? "?"}?</h2>
            <p id="resume-body">
              No Seller Hub draft exists for this listing yet. Resuming will <strong>contact eBay directly</strong> to continue this batch —
              depending on how far it gets, this may create a real eBay Feed task and, eventually, a genuine Seller Hub draft. It will never
              publish a live listing, and it will never create a second task if one already exists for this batch.
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="dialog-cancel" onClick={() => setResumeConfirmBatchId(null)} disabled={resuming}>Cancel</button>
            <button type="button" className="dialog-confirm" onClick={handleConfirmResumeProcessing} disabled={resuming}>{resuming ? "Resuming…" : "Resume processing"}</button>
          </div>
        </div>
      </div>;
    })()}

    {carouselListing && <PhotoCarouselDialog
      title={carouselListing.generatedTitle || "Photos"}
      photos={carouselListing.photoIds.map(id => ({ id }))}
      initialPhotoId={carouselInitialPhotoId}
      onClose={() => setCarouselListingId(null)}
    />}

    {previewListing && <PreviewListingDialog
      productDraftId={previewListing.id}
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
