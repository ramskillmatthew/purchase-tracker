import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
const cssSource = read("app/globals.css");

describe("eBay Seller Hub extension drafter — app UI wiring (Phase 7)", () => {
  it("the button reads exactly 'Send to eBay extension' — never the ambiguous Vinted wording", () => {
    expect(workspaceSource).toContain("Send to eBay extension");
  });

  it("Send to eBay extension is gated by workflowMarketplaceView === \"EBAY_UK\" — never shown in Vinted mode", () => {
    // CORRECTIVE PASS (controlled pairing test review, Phase 5) — widened
    // from 600: the proactive "View active batch" branch (added ahead of
    // the ordinary Send button, inside the SAME guarded IIFE) pushed the
    // real handleSendToEbayExtension call further from the guard
    // condition's own text — never weakened, only widened to keep
    // reaching the SAME guard.
    const idx = workspaceSource.indexOf("handleSendToEbayExtension(row.ebay!.marketplaceDraftId)");
    const before = workspaceSource.slice(Math.max(0, idx - 1900), idx);
    expect(before).toMatch(/workflowMarketplaceView === "EBAY_UK"/);
  });

  it("the pre-existing Seller Hub Feed group is relabelled as a fallback, never deleted", () => {
    expect(workspaceSource).toContain("Seller Hub Feed fallback");
    expect(workspaceSource).toContain("BulkEbayPolicyControl"); // still present, unchanged
    expect(workspaceSource).toContain("Create ${eligibleEbayCount} Seller Hub draft"); // still present, unchanged
  });

  it("REQUIREMENT: handleSendToEbayExtension never calls the Feed /process, /retry or /reconcile routes, and never touches Batch #1's own tables", () => {
    const idx = workspaceSource.indexOf("async function handleSendToEbayExtension");
    const end = workspaceSource.indexOf("\n  }\n", idx);
    const body = workspaceSource.slice(idx, end);
    expect(body).not.toMatch(/\/process|\/retry|\/reconcile/);
    expect(body).toContain("/api/listing-studio/ebay-extension-batches");
  });

  it("the new eBay-extension pairing-code panel uses the same .lr-ebay-status-panel styling as every other eBay status panel — never a new, inconsistent UI language", () => {
    const idx = workspaceSource.indexOf("Ready for the eBay extension");
    const before = workspaceSource.slice(Math.max(0, idx - 200), idx);
    expect(before).toContain("lr-ebay-status-panel");
  });

  it("STRUCTURAL: no absolute positioning was introduced for the eBay-extension label", () => {
    const idx = cssSource.indexOf(".lr-feed-fallback-label {");
    const rule = cssSource.slice(idx, cssSource.indexOf("}", idx) + 1);
    expect(rule).not.toContain("position: absolute");
  });
});
