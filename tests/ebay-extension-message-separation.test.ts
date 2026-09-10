// eBay Seller Hub extension drafter — proves eBay and Vinted message types
// can never collide, structurally. See shared/ebay-messages.js's own top
// comment for the requirement.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EBAY_PANEL_TO_WORKER, EBAY_WORKER_TO_CONTENT, EBAY_CONTENT_TO_WORKER } from "../vinted-draft-queue-extension/shared/ebay-messages.js";
import { PANEL_TO_WORKER, WORKER_TO_CONTENT, CONTENT_TO_WORKER } from "../vinted-draft-queue-extension/shared/messages.js";

const EXTENSION_DIR = "vinted-draft-queue-extension";
function read(path: string) { return readFileSync(`${EXTENSION_DIR}/${path}`, "utf8"); }

function allValues(...objects: Record<string, string>[]): string[] {
  return objects.flatMap(o => Object.values(o));
}

describe("eBay/Vinted message type separation", () => {
  it("no eBay message type string collides with any Vinted message type string", () => {
    const ebayTypes = new Set(allValues(EBAY_PANEL_TO_WORKER, EBAY_WORKER_TO_CONTENT, EBAY_CONTENT_TO_WORKER));
    const vintedTypes = new Set(allValues(PANEL_TO_WORKER, WORKER_TO_CONTENT, CONTENT_TO_WORKER));
    for (const type of ebayTypes) expect(vintedTypes.has(type), `eBay type "${type}" collides with a Vinted type`).toBe(false);
  });

  it("every eBay message type is EBAY_-prefixed", () => {
    for (const type of allValues(EBAY_PANEL_TO_WORKER, EBAY_WORKER_TO_CONTENT, EBAY_CONTENT_TO_WORKER)) {
      expect(type.startsWith("EBAY_"), type).toBe(true);
    }
  });

  it("STRUCTURAL: shared/ebay-queue-state.js never imports shared/queue-state.js (or vice versa) — the two state machines are completely independent modules", () => {
    const ebayQueueState = read("shared/ebay-queue-state.js");
    const vintedQueueState = read("shared/queue-state.js");
    expect(ebayQueueState).not.toMatch(/from ["']\.\/queue-state\.js["']/);
    expect(vintedQueueState).not.toMatch(/from ["']\.\/ebay-queue-state\.js["']/);
  });

  it("STRUCTURAL: shared/ebay-form-steps.js never imports shared/form-steps.js (or vice versa)", () => {
    const ebayFormSteps = read("shared/ebay-form-steps.js");
    const vintedFormSteps = read("shared/form-steps.js");
    expect(ebayFormSteps).not.toMatch(/from ["']\.\/form-steps\.js["']/);
    expect(vintedFormSteps).not.toMatch(/from ["']\.\/ebay-form-steps\.js["']/);
  });

  it("STRUCTURAL: service-worker.js dispatches eBay message types to a SEPARATE handleEbayMessage function, never through handleMessage (the Vinted handler)", () => {
    const source = read("service-worker.js");
    const handleMessageBody = source.slice(source.indexOf("async function handleMessage("), source.indexOf("async function handleMessage(") + source.slice(source.indexOf("async function handleMessage(")).indexOf("\n}\n"));
    expect(handleMessageBody).not.toMatch(/EBAY_PANEL_TO_WORKER|EBAY_CONTENT_TO_WORKER/);
    expect(source).toContain("async function handleEbayMessage(");
    expect(source).toContain("EBAY_MESSAGE_TYPES.has(message?.type) ? handleEbayMessage : handleMessage");
  });

  it("STRUCTURAL: the eBay queue persists under a DIFFERENT chrome.storage.local key ('ebayDrafterState') than Vinted's own ('state') or the read-only importer's ('ebayImportState')", () => {
    const source = read("service-worker.js");
    expect(source).toContain('chrome.storage.local.get("ebayDrafterState")');
    expect(source).toContain('chrome.storage.local.get("state")');
    expect(source).toContain('chrome.storage.local.get("ebayImportState")');
  });

  it("STRUCTURAL: the side panel has its own 'eBay Drafter' tab, entirely separate from the Vinted and eBay-importer tabs", () => {
    const html = read("sidepanel.html");
    expect(html).toContain('id="ebay-drafter-tab"');
    expect(html).toContain('id="ebay-drafter-view"');
    const js = read("sidepanel.js");
    expect(js).toContain('EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH');
    expect(js).toContain('EBAY_PANEL_TO_WORKER.EBAY_START_ITEM');
  });
});
