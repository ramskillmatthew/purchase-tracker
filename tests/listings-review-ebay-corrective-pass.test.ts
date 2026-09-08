import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
const bulkPolicySource = read("components/listings-review/BulkEbayPolicyControl.tsx");
const tableSource = read("components/listings-review/ListingsTable.tsx");
const cssSource = read("app/globals.css");

/**
 * Corrective pass (Defects 1-7) — these are STRUCTURAL (source-text)
 * checks, not behavioural proof: this codebase's own vitest config runs
 * with `environment: "node"` and no DOM-rendering library, so genuine
 * click/mousedown/Escape/focus behaviour for these components cannot be
 * exercised as a jsdom test here. That behaviour was instead verified live
 * in a real browser this session (fresh dev server, zero console errors):
 * the popover's ×, Escape, and outside-click all closed it; a mousedown
 * inside its own <select> did not; focus returned to the trigger button
 * afterwards; the bulk button showed "Create 1 eBay draft" for the real,
 * fully-eligible "On Running Cloud 5" listing; and the Workflow column's
 * Vinted/eBay toggle was fully visible and clickable. These structural
 * tests exist to catch a REGRESSION in the exact mechanism that produced
 * that verified behaviour, not to reprove the behaviour itself.
 */
describe("STRUCTURAL — Defect 2/5: one authoritative eligibility calculation, not a duplicate (PHASE 4 update — now the Sell Feed API pipeline's own function)", () => {
  it("the bulk eligibility count is computed by calling the SAME evaluateEbayFeedDraftEligibility function the server uses — never a separate hand-rolled boolean check", () => {
    expect(workspaceSource).toContain('import { evaluateEbayFeedDraftEligibility, type EbayFeedDraftEligibilityResult } from "@/lib/listing-studio/ebay-feed/feed-draft-eligibility"');
    expect(workspaceSource).toContain("evaluateEbayFeedDraftEligibility({");
  });

  it("REGRESSION GUARD: the client has no duplicate boolean eligibility expression requiring policy/location fields directly (the Feed template has no column for either — see feed-draft-eligibility.ts's own header)", () => {
    expect(workspaceSource).not.toMatch(/Boolean\(s\.merchantLocationKey\)/);
    expect(workspaceSource).not.toMatch(/fulfillmentPolicyStale|returnPolicyStale|paymentPolicyStale/);
  });

  it("never shows an unexplained 'Create 0' — a distinct, deduplicated blocking-reason list renders whenever the selection is non-empty and nothing is eligible", () => {
    expect(workspaceSource).toContain("ebayIneligibleBlockingReasons");
    expect(workspaceSource).toContain("isn't ready for a Seller Hub draft yet");
  });

  it("the client-side eligibility inputs mirror every field resolveEbayFeedDraftEligibilityForProducts passes server-side (lib/listing-studio/ebay-feed/feed-batches.ts), so the two can never silently diverge", () => {
    const serverSource = read("lib/listing-studio/ebay-feed/feed-batches.ts");
    for (const field of ["hasEbayPreparation", "accountUsable", "alreadyHasFeedDraft", "contentReady", "hasValidPrice", "hasPhoto", "hasSku", "hasQuantity", "hasCategoryId"]) {
      expect(serverSource, `server input field: ${field}`).toContain(field);
      expect(workspaceSource, `client input field: ${field}`).toContain(field);
    }
  });
});

describe("STRUCTURAL — Defect 4: Workflow column toggle is never clipped", () => {
  it("the table header toggle is scoped its own CSS rule dropping it onto a new line below the column heading, rather than sharing one line with 'Workflow' text inside a fixed 148-190px overflow:hidden column", () => {
    expect(cssSource).toContain(".lr-table th .lr-marketplace-toggle { display: flex;");
  });

  it("the toggle renders both Vinted and eBay labels in full text, never an icon-only/clipped abbreviation", () => {
    expect(tableSource).toContain('{marketplace === "VINTED" ? "Vinted" : "eBay"}');
  });

  it("switching marketplace via the table toggle is wired straight to the shared onMarketplaceChange callback — the same state drives price/profit/status display for the whole row", () => {
    expect(tableSource).toContain("onClick={event => { event.stopPropagation(); onMarketplaceChange(marketplace); }}");
  });
});

describe("STRUCTURAL — Defect 1: bulk policy popover close affordances", () => {
  it("has a visible, labelled × close button", () => {
    expect(bulkPolicySource).toContain('aria-label="Close"');
    expect(bulkPolicySource).toContain("lr-bulk-ebay-policy-close");
  });

  it("closes on Escape via a document keydown listener, added only while open", () => {
    expect(bulkPolicySource).toMatch(/document\.addEventListener\("keydown", handleKeyDown\)/);
    expect(bulkPolicySource).toMatch(/event\.key !== "Escape"/);
  });

  it("closes on an outside click via a document mousedown listener checking the container ref — mirrors components/listing-studio/OverflowMenu.tsx's own established pattern", () => {
    expect(bulkPolicySource).toContain('document.addEventListener("mousedown", handlePointerDown)');
    expect(bulkPolicySource).toContain("containerRef.current?.contains(event.target as Node)");
  });

  it("both listeners are removed on cleanup — never leaked once closed", () => {
    expect(bulkPolicySource).toContain('document.removeEventListener("mousedown", handlePointerDown)');
    expect(bulkPolicySource).toContain('document.removeEventListener("keydown", handleKeyDown)');
  });

  it("focus returns to the trigger button on every close path (×, Escape, and a successful Apply)", () => {
    expect(bulkPolicySource).toMatch(/function closePanel\(\) \{\s*setOpen\(false\);\s*triggerRef\.current\?\.focus\(\);/);
    expect(bulkPolicySource).toContain("onClick={closePanel}");
    expect(bulkPolicySource).toContain("if (outcome.appliedCount > 0) closePanel();");
  });

  it("a failed/all-skipped Apply does NOT auto-close — the result stays visible so the user can see why and retry", () => {
    expect(bulkPolicySource).toMatch(/if \(outcome\.appliedCount > 0\) closePanel\(\);/);
    expect(bulkPolicySource).not.toMatch(/setResult\(outcome\);\s*closePanel\(\);/);
  });

  it("the trigger button has aria-expanded and aria-haspopup for keyboard/screen-reader users", () => {
    expect(bulkPolicySource).toContain("aria-expanded={open}");
    expect(bulkPolicySource).toContain('aria-haspopup="dialog"');
  });

  // CORRECTIVE PASS (action-bar rebuild) — REPLACES the old "clamped to
  // the viewport width" check: that property existed only because the
  // panel used to be an absolutely-positioned floating overlay that could
  // otherwise overflow the viewport edge. It is now a normal, full-width
  // block inside its own flex line (see the "no absolutely positioned
  // overlay" describe block below), which is inherently bounded by its
  // container — a viewport-relative clamp no longer applies or is needed.
  it("the panel is a full-width block, never wider than its own row (width: 100%, max-width: 100%) — no viewport-relative sizing", () => {
    const idx = cssSource.indexOf(".lr-bulk-ebay-policy-panel {");
    const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
    expect(rule).toContain("width: 100%");
    expect(rule).toContain("max-width: 100%");
    expect(rule).not.toContain("100vw");
  });
});

describe("STRUCTURAL — Defect 6/7: stuck-batch dismissal cancels BEFORE dismissing (never leaves a hidden batch still claimable)", () => {
  it("Vinted stuck-batch dismissal calls DELETE (cancel) before the dismiss_box PATCH", () => {
    const stuckDismissBlock = workspaceSource.slice(workspaceSource.indexOf("async function confirmStuckDismiss()"), workspaceSource.indexOf("async function confirmStuckDismiss()") + 1200);
    const deleteInBlock = stuckDismissBlock.indexOf("method: \"DELETE\"");
    const patchInBlock = stuckDismissBlock.indexOf("dismiss_box");
    expect(deleteInBlock).toBeGreaterThan(-1);
    expect(patchInBlock).toBeGreaterThan(deleteInBlock);
  });

  it("eBay stuck-batch dismissal ALSO cancels before dismissing — the corrective-pass fix to a real latent bug (the previous version only dismissed, leaving items still claimable by a future batch/cron tick)", () => {
    const block = workspaceSource.slice(workspaceSource.indexOf("async function confirmEbayStuckDismiss()"), workspaceSource.indexOf("async function confirmEbayStuckDismiss()") + 900);
    const deleteInBlock = block.indexOf("method: \"DELETE\"");
    expect(deleteInBlock).toBeGreaterThan(-1);
    expect(block).toContain("await handleDismissEbayBatchBox(ebayDismissTarget.batchId);");
    expect(block.indexOf("handleDismissEbayBatchBox")).toBeGreaterThan(deleteInBlock);
  });

  it("both stuck-batch confirmation dialogs explain cancel + release + preserve-history, never merely 'removes the alert'", () => {
    expect(workspaceSource).toMatch(/cancels the batch's remaining queued work/);
    expect(workspaceSource).toMatch(/kept for reference, never deleted/g);
  });

  it("the Vinted recovery panel now has a visible, accessible per-row dismiss control distinct from Recover", () => {
    expect(workspaceSource).toContain("lr-hidden-batch-dismiss");
    expect(workspaceSource).toContain("`Dismiss Batch #${batch.displayNumber}`");
    expect(workspaceSource).toContain("lr-hidden-batch-recover-button");
  });

  it("dismissal is idempotent server-side — the extension-batches PATCH/DELETE routes both guard on current status (already-terminal DELETE short-circuits; dismiss_box's own owner+status-scoped UPDATE only ever affects a still-null box_dismissed_at row)", () => {
    const routeSource = read("app/api/listing-studio/extension-batches/[batchId]/route.ts");
    expect(routeSource).toContain('if (batch.status === "completed" || batch.status === "cancelled" || batch.status === "expired")');
    expect(routeSource).toContain("box_dismissed_at=is.null");
  });
});

describe("STRUCTURAL — no publish-capable eBay operation was introduced by this pass", () => {
  it("the new cancel-then-dismiss flows only ever call the existing DELETE/PATCH batch routes — never an Inventory API publish path", () => {
    for (const source of [workspaceSource, bulkPolicySource]) {
      expect(source).not.toMatch(/publishOffer|bulkPublishOffer|publishOfferByInventoryItemGroup/);
    }
  });
});

// PHASE 3 (hard-retire legacy Inventory API writes) — the "genuine retry
// UI" describe block that used to live here is REMOVED, not merely
// updated: it tested the per-item "Retry failed draft" flow, which this
// task retires entirely (see
// components/listings-review/ListingDetailsPanel.tsx's own
// EbayFailedDraftActions corrective-pass comment, and
// tests/ebay-feed-listings-review-wiring.test.ts's own "retry is
// genuinely gone from the UI" proof, which replaces this coverage).
describe("STRUCTURAL — 'Drafts only — never publishes' wording is untouched by this pass", () => {
  it("still present", () => {
    expect(workspaceSource).toContain("Drafts only — never publishes");
  });
});

/**
 * CORRECTIVE PASS (action-bar rebuild — real-submission audit of a live
 * screenshot showing the "Set eBay shipping policy" popover as an
 * absolutely-positioned overlay covering the table row). Genuine pixel-
 * level non-overlap was verified live this session (fresh dev server,
 * getBoundingClientRect() on "Clear selection"/"Delete"/the panel at
 * 1536×864, 1280×720, 768×1024 and 375×812 — no overlap at any of the
 * four); these structural checks exist to catch a regression in the exact
 * CSS mechanism that produced that verified result, not to reprove it.
 */
describe("STRUCTURAL — action-bar rebuild: no absolutely positioned overlay covering other controls", () => {
  it("the 'Set eBay shipping policy' panel is no longer position: absolute — it reserves real space in the flex flow (flex-basis: 100%, position: static)", () => {
    const idx = cssSource.indexOf(".lr-bulk-ebay-policy-panel {");
    const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
    expect(rule).toContain("position: static");
    expect(rule).toContain("flex-basis: 100%");
    expect(rule).not.toContain("position: absolute");
  });

  it("the panel's wrapper uses display: contents so the trigger and panel are direct flex items of .lr-bulk-bar-actions (the flex-basis: 100% wrap technique requires this)", () => {
    const idx = cssSource.indexOf(".lr-bulk-ebay-policy {");
    const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
    expect(rule).toContain("display: contents");
    expect(rule).not.toContain("position: relative");
  });

  it("the bulk bar top-aligns its children (flex-start), not center — so 'N selected / Clear selection' stays pinned to the top of the row instead of floating into the middle of a taller wrapped panel", () => {
    const idx = cssSource.indexOf(".lr-bulk-bar {");
    const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
    expect(rule).toContain("align-items: flex-start");
  });

  it("no rule in the bulk-bar/policy-panel action area uses a negative margin", () => {
    for (const selector of [".lr-bulk-bar {", ".lr-bulk-bar-selection {", ".lr-bulk-bar-actions {", ".lr-bulk-ebay-policy-panel {"]) {
      const idx = cssSource.indexOf(selector);
      const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
      expect(rule).not.toMatch(/margin[^:]*:\s*-/);
    }
  });

  it("long blocker reason text wraps beneath the controls rather than overflowing (overflow-wrap: anywhere on .lr-ebay-status-panel-reasons li)", () => {
    const idx = cssSource.indexOf(".lr-ebay-status-panel-reasons li {");
    const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
    expect(rule).toContain("overflow-wrap: anywhere");
  });
});
