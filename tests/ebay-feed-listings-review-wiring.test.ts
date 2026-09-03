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
    expect(workspaceSource).toContain("{`Create ${ebayPreviewRows.length} Seller Hub draft${ebayPreviewRows.length === 1 ? \"\" : \"s\"}?`}");
  });
});

describe("PHASE 9.6 — a preview is shown before any real batch is created", () => {
  it("the button opens a preview first (handleOpenEbayCreatePreview), never creating a batch directly on click", () => {
    expect(workspaceSource).toContain("onClick={handleOpenEbayCreatePreview}");
  });

  it("the preview fetch is read-only (POST to /preview, a distinct route from batch creation)", () => {
    expect(workspaceSource).toContain('"/api/listing-studio/ebay-feed-batches/preview"');
  });

  it("the preview dialog shows the real fields the acceptance criteria require: title, SKU, category, price, quantity, condition, description, photo", () => {
    const dialogBody = workspaceSource.slice(workspaceSource.indexOf('id="ebay-preview-title"'), workspaceSource.indexOf("dialog-actions"));
    for (const field of ["Title", "Custom label (SKU)", "Category ID", "Price", "Quantity", "Condition ID", "Item photo URL", "Description"]) {
      expect(dialogBody, field).toContain(field);
    }
  });

  it("the preview dialog surfaces the completeInSellerHub list — fields that do NOT transfer", () => {
    expect(workspaceSource).toContain("row.completeInSellerHub");
    expect(workspaceSource).toContain("Complete in Seller Hub");
  });

  it("the actual create call only fires from the dialog's own confirm button, never from opening the preview", () => {
    const dialogStart = workspaceSource.indexOf('id="ebay-preview-title"');
    const dialogBody = workspaceSource.slice(dialogStart, dialogStart + 3000);
    expect(dialogBody).toContain("onClick={handleCreateEbayDrafts}");
    // handleOpenEbayCreatePreview (which only builds the read-only preview)
    // is called by the OUTER bulk-action button, never by anything inside
    // this dialog itself.
    expect(dialogBody).not.toContain("handleOpenEbayCreatePreview");
  });
});

describe("PHASE 9.7/9.8 — confirmation states plainly: creates drafts, never publishes, must open Seller Hub, exact row count — and no publish capability exists anywhere in the UI", () => {
  it("the confirmation message states all four required facts", () => {
    const dialogBody = workspaceSource.slice(workspaceSource.indexOf('id="ebay-preview-title"'), workspaceSource.indexOf("dialog-actions"));
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

describe("PHASE 9 — retry is genuinely gone from the UI, never a dead button pointing at a 410 route", () => {
  it("no retry-batch-item fetch call exists anywhere in the workspace", () => {
    expect(workspaceSource).not.toMatch(/\/items\/\$\{.*\}\/retry/);
  });

  it("EbayFailedDraftActions only offers View error, never a Retry button", () => {
    const fnBody = detailsPanelSource.slice(detailsPanelSource.indexOf("function EbayFailedDraftActions"), detailsPanelSource.indexOf("export type ListingDetails"));
    expect(fnBody).not.toContain("Retry failed draft");
    expect(fnBody).toContain("View error");
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
