import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
const detailsPanelSource = read("components/listings-review/ListingDetailsPanel.tsx");
const tableSource = read("components/listings-review/ListingsTable.tsx");

/**
 * PHASE 9 — structural (source-text) proofs that the Listings Review UI is
 * wired to the ACTIVE Sell Feed API pipeline, never the retired Inventory
 * API one. These cannot exercise the real React render tree (no jsdom
 * harness exists for this component in this codebase), so they verify the
 * exact source that WOULD run — matching this repo's own established
 * pattern for every other UI-wiring proof (see tests/listings-review-ui.test.ts).
 */
describe("PHASE 9.1 — the UI calls only the new Feed batch route, never the retired one", () => {
  it("every eBay batch fetch in the workspace targets /api/listing-studio/ebay-feed-batches", () => {
    expect(workspaceSource).not.toContain("/api/listing-studio/ebay-draft-batches");
    expect(workspaceSource).toContain('fetch("/api/listing-studio/ebay-feed-batches")');
    expect(workspaceSource).toContain('fetch("/api/listing-studio/ebay-feed-batches", {');
    expect(workspaceSource).toContain("fetch(`/api/listing-studio/ebay-feed-batches/${id}/process`");
  });

  it("the create-batch handler posts to the new route, never the retired one", () => {
    const fnBody = workspaceSource.slice(workspaceSource.indexOf("async function handleCreateEbayDrafts"), workspaceSource.indexOf("async function handleCreateEbayDrafts") + 1200);
    expect(fnBody).toContain('/api/listing-studio/ebay-feed-batches"');
  });
});

describe("PHASE 9.4/9.5 — the button says 'Seller Hub draft', correctly singular/plural, never 'eBay draft'", () => {
  it("the button label uses the Create N Seller Hub draft(s) template", () => {
    expect(workspaceSource).toContain('`Create ${eligibleEbayCount} Seller Hub draft${eligibleEbayCount === 1 ? "" : "s"}`');
  });

  it("never labels the button 'Create eBay draft(s)' anywhere in the bulk-action area", () => {
    expect(workspaceSource).not.toMatch(/Create \$\{eligibleEbayCount\} eBay draft/);
  });

  it("the preview/confirm dialog title also uses the correct singular/plural Seller Hub draft wording", () => {
    expect(workspaceSource).toContain('`Create ${ebayPreviewRows.length} Seller Hub draft${ebayPreviewRows.length === 1 ? "" : "s"}?`');
  });
});

// Anchors every "ready"/"blocked" phase assertion to that SPECIFIC branch
// of the dialog — never the first "ebay-preview-title" occurrence, which
// (since the corrective pass) is now the LOADING phase's own heading, a
// wholly different branch with none of the real preview content.
const readyPhaseAnchor = 'ebayPreviewPhase === "ready" || ebayPreviewPhase === "blocked"';

describe("PHASE 9.6 — a preview is shown before any real batch is created", () => {
  it("the button opens a preview first (handleOpenEbayCreatePreview), never creating a batch directly on click", () => {
    expect(workspaceSource).toContain("onClick={handleOpenEbayCreatePreview}");
  });

  it("the preview fetch is read-only (POST to /preview, a distinct route from batch creation)", () => {
    expect(workspaceSource).toContain('"/api/listing-studio/ebay-feed-batches/preview"');
  });

  it("the preview dialog shows the real fields the acceptance criteria require: title, SKU, category, price, quantity, condition, description, photo", () => {
    const dialogBody = workspaceSource.slice(workspaceSource.indexOf(readyPhaseAnchor), workspaceSource.indexOf(readyPhaseAnchor) + 4800);
    for (const field of ["Title", "Custom label (SKU)", "Category ID", "Price", "Quantity", "Condition ID", "Item photo URL", "Description"]) {
      expect(dialogBody, field).toContain(field);
    }
  });

  it("the preview dialog surfaces the completeInSellerHub list — fields that do NOT transfer", () => {
    expect(workspaceSource).toContain("row.completeInSellerHub");
    expect(workspaceSource).toContain("Complete in Seller Hub");
  });

  it("the actual create call only fires from the dialog's own confirm button, never from opening the preview", () => {
    const dialogStart = workspaceSource.indexOf(readyPhaseAnchor);
    const dialogBody = workspaceSource.slice(dialogStart, dialogStart + 4800);
    expect(dialogBody).toContain("onClick={handleCreateEbayDrafts}");
    // handleOpenEbayCreatePreview (which only builds the read-only preview)
    // is called by the OUTER bulk-action button, never by anything inside
    // this dialog itself.
    expect(dialogBody).not.toContain("handleOpenEbayCreatePreview");
  });
});

describe("PHASE 9.7/9.8 — confirmation states plainly: creates drafts, never publishes, must open Seller Hub, exact row count — and no publish capability exists anywhere in the UI", () => {
  it("the confirmation message states all four required facts", () => {
    const dialogBody = workspaceSource.slice(workspaceSource.indexOf(readyPhaseAnchor), workspaceSource.indexOf(readyPhaseAnchor) + 4800);
    expect(dialogBody).toMatch(/creates.*(?:a draft|drafts).*eBay Seller Hub/i);
    expect(dialogBody).toMatch(/does\s*<strong>not<\/strong>\s*publish/i);
    expect(dialogBody).toMatch(/open Seller Hub yourself/i);
    expect(dialogBody).toMatch(/row.*will be uploaded to eBay/i);
  });

  it("no publish-capable action exists anywhere in the workspace, details panel, or table (publishOffer/bulkPublishOffer/LMS_ADD/withdrawOffer)", () => {
    for (const source of [workspaceSource, detailsPanelSource, tableSource]) {
      expect(source).not.toMatch(/publishOffer|bulkPublishOffer|LMS_ADD_FIXED_PRICE_ITEM|LMS_ADD_ITEM|withdrawOffer/);
    }
  });

  it("the new preview/confirm dialog and Seller Hub summary never claim a listing is 'Published' or 'Live' (scoped narrowly to this feature's own new text, to avoid false positives from unrelated existing prose like this file's own 'Live Activity' panel name)", () => {
    const dialogStart = workspaceSource.indexOf('id="ebay-preview-title"');
    const dialogEnd = workspaceSource.indexOf("{!loading && !hasAnyData", dialogStart);
    const dialogAndSummary = workspaceSource.slice(dialogStart, dialogEnd) + workspaceSource.slice(workspaceSource.indexOf("lr-ebay-seller-hub-summary"), workspaceSource.indexOf("lr-ebay-seller-hub-summary") + 400);
    expect(dialogAndSummary).not.toMatch(/\bpublished\b/i);
    expect(dialogAndSummary).not.toMatch(/\blive\b/i);
  });
});

describe("PHASE 9.30/9.31 — the retired legacy pipeline's own historical label is truthful, and never counted as a Seller Hub draft", () => {
  it("the legacy offer note (rendered in the eBay tab) uses the exact required wording", () => {
    expect(detailsPanelSource).toContain("Legacy unpublished API offer — not visible in Seller Hub");
  });

  it("the KPI/eligibility computations key off feedDraftCreatedAt (the ACTIVE pipeline's own signal), never the legacy offerId, for 'already has a draft'", () => {
    expect(workspaceSource).toContain("alreadyHasFeedDraft: row.ebay.feedDraftCreatedAt !== null");
    expect(workspaceSource).not.toMatch(/alreadyHasOffer: row\.ebay\.(offerId|legacyOfferId)/);
  });

  it("the succeeded-drafts count (driving the Drafts KPI tab and Open Seller Hub Drafts summary) is computed from the Feed pipeline's own item status, never the legacy offerId", () => {
    expect(workspaceSource).toContain('row.ebayWorkflowStatus === "succeeded"');
  });
});

describe("PHASE 9 — the retired legacy PER-ITEM retry is genuinely gone from the UI, never a dead button pointing at a 410 route", () => {
  it("no legacy per-item retry-batch-item fetch call exists anywhere in the workspace", () => {
    expect(workspaceSource).not.toMatch(/\/items\/\$\{.*\}\/retry/);
  });

  it("EbayFailedDraftActions (the per-listing inspector panel) offers View error, never its own per-item 'Retry failed draft' button", () => {
    const fnBody = detailsPanelSource.slice(detailsPanelSource.indexOf("function EbayFailedDraftActions"), detailsPanelSource.indexOf("export type ListingDetails"));
    expect(fnBody).not.toContain("Retry failed draft");
    expect(fnBody).toContain("View error");
  });
});

// CORRECTIVE PASS (second real submission — Phase 6/7) — a genuine,
// deliberate BATCH-level retry now exists (Live Activity, not the
// per-listing inspector panel above) — the opposite of "retry is gone".
describe("PHASE 7/8 — the new, deliberate BATCH-level 'Retry Seller Hub draft' exists in Live Activity, wired to the batch route (never the legacy per-item one)", () => {
  it("the workspace posts to the batch-level retry route, never a per-item one", () => {
    expect(workspaceSource).toContain("/retry`, { method: \"POST\" }");
    expect(workspaceSource).not.toMatch(/\/items\/\$\{.*\}\/retry/);
  });

  it("DraftActivityPanel renders 'Retry Seller Hub draft' only when the event carries retryableBatchId", () => {
    const panelSource = read("components/listings-review/DraftActivityPanel.tsx");
    expect(panelSource).toContain("Retry Seller Hub draft");
    expect(panelSource).toContain("event.retryableBatchId");
  });

  it("a batch-complete event is only ever marked retryableBatchId for a genuinely FAILED batch, never a completed/completed_with_errors one", () => {
    expect(workspaceSource).toContain('retryableBatchId: body.status === "failed" ? batchId : null');
  });

  it("the per-listing inspector's own failed-draft hint no longer claims re-selecting and clicking Create again will work (it is now correctly blocked) — it points to Live Activity's Retry instead", () => {
    const fnBody = detailsPanelSource.slice(detailsPanelSource.indexOf("function EbayFailedDraftActions"), detailsPanelSource.indexOf("export type ListingDetails"));
    expect(fnBody).not.toMatch(/click.*Create Seller Hub draft.*to try again/i);
    expect(fnBody).toMatch(/Retry Seller Hub draft/);
  });

  it("the retry confirmation dialog explains reconciliation and never-publishes before any retry request is sent", () => {
    const dialogStart = workspaceSource.indexOf('id="retry-title"');
    const dialogBody = workspaceSource.slice(dialogStart, dialogStart + 1200);
    expect(dialogBody).toMatch(/eBay already has a record/i);
    expect(dialogBody).toMatch(/will not publish/i);
    expect(dialogBody).toMatch(/will not[\s\S]*create a new task/i);
  });
});

describe("PHASE 9 — Open Seller Hub Drafts link is present and points at the real, confirmed URL", () => {
  it("both the eBay tab and the batch summary link via the shared SELLER_HUB_DRAFTS_URL constant (the real, confirmed URL — see feed-workflow-status.test.ts's own proof of its exact value), never a re-typed literal that could drift", () => {
    expect(detailsPanelSource).toContain("href={SELLER_HUB_DRAFTS_URL}");
    expect(detailsPanelSource).toMatch(/import\s*\{[^}]*SELLER_HUB_DRAFTS_URL[^}]*\}\s*from ["']@\/lib\/listing-studio\/ebay-feed\/feed-workflow-status["']/);
    expect(workspaceSource).toContain("href={SELLER_HUB_DRAFTS_URL}");
    expect(workspaceSource).toMatch(/import\s*\{[^}]*SELLER_HUB_DRAFTS_URL[^}]*\}\s*from ["']@\/lib\/listing-studio\/ebay-feed\/feed-workflow-status["']/);
  });
});

/**
 * CORRECTIVE PASS (require valid Seller Hub draft preview) — Phase 8's own
 * dialog-state-machine requirements (items 19-24). This codebase has no
 * jsdom/React-render test harness for this component (see this file's own
 * header comment), so these verify the exact CODE that drives each
 * required state, matching the file's own established pattern.
 */
describe("PHASE 8.19-24 — the preview dialog state machine never shows a false/contradictory count or an enabled submission it shouldn't", () => {
  it("REQUIREMENT 19: the loading phase renders a real progress message, never a bare row/draft count — no ebayPreviewRows.length is read anywhere inside the loading branch", () => {
    const loadingStart = workspaceSource.indexOf('ebayPreviewPhase === "loading" &&');
    const loadingEnd = workspaceSource.indexOf('ebayPreviewPhase === "failed"', loadingStart);
    const loadingBody = workspaceSource.slice(loadingStart, loadingEnd);
    expect(loadingBody).toContain("Preparing Seller Hub draft preview");
    expect(loadingBody).not.toContain("ebayPreviewRows.length");
  });

  it("REQUIREMENT 20: the failed phase never renders the row list or the submit button — only Close and Try preview again", () => {
    const failedStart = workspaceSource.indexOf('ebayPreviewPhase === "failed" &&');
    const failedEnd = workspaceSource.indexOf('(ebayPreviewPhase === "ready"', failedStart);
    const failedBody = workspaceSource.slice(failedStart, failedEnd);
    expect(failedBody).toContain("Try preview again");
    expect(failedBody).not.toContain("handleCreateEbayDrafts");
    expect(failedBody).not.toContain("dialog-confirm");
  });

  it("REQUIREMENT 21/24: the submit button's disabled expression includes ebayPreviewRows.length === 0 — a zero-row (or still-loading, or failed) preview can never show an enabled submit action, and the button's own displayed count is always ebayPreviewRows.length (the server-authoritative row count), never a client-side selection count", () => {
    const dialogStart = workspaceSource.indexOf(readyPhaseAnchor);
    const dialogBody = workspaceSource.slice(dialogStart, dialogStart + 4800);
    expect(dialogBody).toMatch(/disabled=\{[\s\S]*ebayPreviewRows\.length === 0[\s\S]*\}/);
    expect(dialogBody).toContain("Create ${ebayPreviewRows.length} Seller Hub draft${ebayPreviewRows.length === 1");
  });

  it("REQUIREMENT 22: a ready preview (at least one row) enables the submit button — the disabled expression is not permanently true", () => {
    const dialogStart = workspaceSource.indexOf(readyPhaseAnchor);
    const dialogBody = workspaceSource.slice(dialogStart, dialogStart + 4800);
    // The ONLY conditions that disable submission are: currently
    // submitting, zero rows, or an un-acknowledged partial submission —
    // never an unconditional `disabled` on the confirm button.
    expect(dialogBody).toMatch(/disabled=\{\s*\n\s*ebayCreatingDrafts\s*\n\s*\|\|\s*ebayPreviewRows\.length === 0\s*\n\s*\|\|\s*\(ebayPreviewBlockers\.length > 0 && !ebayPreviewPartialAck\)\s*\n\s*\}/);
  });

  it("REQUIREMENT 23: the button's displayed row count and the actual submitted draftIds both come from the SAME ebayPreviewRows array — they can never diverge", () => {
    const createFnBody = workspaceSource.slice(workspaceSource.indexOf("async function handleCreateEbayDrafts"), workspaceSource.indexOf("async function handleCreateEbayDrafts") + 600);
    expect(createFnBody).toContain("const ids = ebayPreviewRows.map(row => row.draftId);");
  });

  it("REQUIREMENT 24 (client tampering): the create-batch request body is built from ebayPreviewRows (server-derived), never from bulkSelectedIds or any other client-only selection state, inside handleCreateEbayDrafts", () => {
    const createFnBody = workspaceSource.slice(workspaceSource.indexOf("async function handleCreateEbayDrafts"), workspaceSource.indexOf("async function handleCreateEbayDrafts") + 1200);
    expect(createFnBody).not.toContain("bulkSelectedIds");
  });

  it("the Close/Cancel button remains available and enabled during a preview failure", () => {
    const failedStart = workspaceSource.indexOf('ebayPreviewPhase === "failed" &&');
    const failedEnd = workspaceSource.indexOf('(ebayPreviewPhase === "ready"', failedStart);
    const failedBody = workspaceSource.slice(failedStart, failedEnd);
    expect(failedBody).toMatch(/<button type="button" className="dialog-cancel" onClick=\{\(\) => setEbayPreviewOpen\(false\)\}>Close<\/button>/);
  });

  it("opening the preview always resets partial-acknowledgement, rows, and blockers from any PREVIOUS dialog session — a stale acknowledgement can never silently carry over", () => {
    const openFnBody = workspaceSource.slice(workspaceSource.indexOf("async function handleOpenEbayCreatePreview"), workspaceSource.indexOf("async function handleOpenEbayCreatePreview") + 900);
    expect(openFnBody).toContain("setEbayPreviewPartialAck(false)");
    expect(openFnBody).toContain("setEbayPreviewRows([])");
    expect(openFnBody).toContain("setEbayPreviewBlockers([])");
  });
});
