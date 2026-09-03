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
describe("STRUCTURAL — Defect 2/5: one authoritative eligibility calculation, not a duplicate", () => {
  it("the bulk eligibility count is computed by calling the SAME evaluateEbayDraftEligibility function the server uses — never a separate hand-rolled boolean check", () => {
    expect(workspaceSource).toContain('import { evaluateEbayDraftEligibility, type EbayDraftEligibilityResult } from "@/lib/listing-studio/ebay-draft-eligibility"');
    expect(workspaceSource).toContain("evaluateEbayDraftEligibility({");
  });

  it("REGRESSION GUARD: the client no longer has its own duplicate boolean eligibility expression requiring merchantLocationKey directly", () => {
    expect(workspaceSource).not.toMatch(/Boolean\(s\.merchantLocationKey\)/);
  });

  it("never shows an unexplained 'Create 0' — a distinct, deduplicated blocking-reason list renders whenever the selection is non-empty and nothing is eligible", () => {
    expect(workspaceSource).toContain("ebayIneligibleBlockingReasons");
    expect(workspaceSource).toContain("isn't ready for an eBay draft yet");
  });

  it("the client-side eligibility inputs mirror every field resolveEbayDraftEligibilityForProducts passes server-side (lib/listing-studio/ebay-draft-batches.ts), so the two can never silently diverge", () => {
    const serverSource = read("lib/listing-studio/ebay-draft-batches.ts");
    for (const field of ["hasEbayPreparation", "accountUsable", "alreadyHasOffer", "contentReady", "hasValidPrice", "hasPhoto", "hasSku", "hasQuantity", "fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId", "merchantLocationKey"]) {
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

  it("the panel is clamped to the viewport width", () => {
    expect(cssSource).toContain("max-width: calc(100vw - 24px)");
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
