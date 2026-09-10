// @vitest-environment jsdom
//
// eBay Seller Hub extension drafter — publishing safety, proven both
// structurally (no publish-shaped function exists anywhere) and
// functionally (the forbidden-action guard actually rejects the REAL,
// live-verified eBay button text "List it for free" — not merely the
// generic "List item" wording ported from Vinted, which would NOT have
// matched it — see shared/ebay-fields.js's own top comment on this exact
// finding).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  isForbiddenActionName, assertNotForbiddenAction, isAllowedSaveForLaterName, safeClick,
} from "../vinted-draft-queue-extension/shared/ebay-fields.js";

const EXTENSION_DIR = "vinted-draft-queue-extension";
function read(path: string) { return readFileSync(`${EXTENSION_DIR}/${path}`, "utf8"); }
function allExtensionJsFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(`${EXTENSION_DIR}/${dir}`, { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith(".js")) files.push(relative);
    }
  }
  walk("");
  return files;
}

describe("eBay drafter — structural: no publish/save-draft function exists anywhere in this milestone's own code", () => {
  const jsFiles = allExtensionJsFiles();

  it("REGRESSION: no function or identifier anywhere in the eBay-prefixed files is named/shaped like a publish OR a save-draft action", () => {
    const ebayFiles = jsFiles.filter(f => f.includes("ebay") && !f.includes("ebay-description") && !f.startsWith("ebay-content-script"));
    for (const file of ebayFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/function\s+\w*publish\w*/i);
      expect(source, file).not.toMatch(/function\s+\w*saveDraft\w*/i);
      expect(source, file).not.toMatch(/clickPublish|clickListIt|clickSaveForLater|publishListing|listItemNow/i);
    }
  });

  it("REQUIREMENT (Phase 6): there is no stepSaveDraft-equivalent function in ebay-form-steps.js — Save Draft is never clicked by this milestone", () => {
    const source = read("shared/ebay-form-steps.js");
    expect(source).not.toMatch(/function\s+stepSave/i);
    // "Save for later" appears only in doc comments explaining this exact
    // safety property (see this file's own top comment) — never inside a
    // safeClick(...) call or any other real interaction.
    expect(source).not.toMatch(/safeClick\([^)]*[Ss]ave[^)]*\)/);
  });

  it("REQUIREMENT: runEbayItem's own success path ends at WAITING_FOR_REVIEW / stepVerifyPopulatedFields — never calls a save/click step afterwards", () => {
    const source = read("shared/ebay-form-steps.js");
    const runItemBody = source.slice(source.indexOf("export async function runEbayItem"));
    expect(runItemBody).toContain("stepVerifyPopulatedFields");
    expect(runItemBody).not.toMatch(/isAllowedSaveForLaterName|SAVE_FOR_LATER/);
  });
});

describe("eBay drafter — functional: the forbidden-action guard against a synthetic DOM built from the REAL, live-verified button text", () => {
  it("REQUIREMENT (critical live finding): 'List it for free' — eBay's REAL publish button text — is forbidden (a generic 'List item' pattern alone would NOT have caught this)", () => {
    expect(isForbiddenActionName("List it for free")).toBe(true);
  });

  it("'Save for later' — eBay's REAL save-draft button text — is NOT forbidden, but is also never clicked by this milestone (see the structural tests above)", () => {
    expect(isForbiddenActionName("Save for later")).toBe(false);
    expect(isAllowedSaveForLaterName("Save for later")).toBe(true);
  });

  it("safeClick refuses to click a real 'List it for free' button", () => {
    const dom = new JSDOM(`<button>List it for free</button>`);
    const button = dom.window.document.querySelector("button")!;
    expect(() => safeClick(button, "TEST")).toThrow(/SAFETY/);
  });

  it("safeClick allows clicking an ordinary, non-forbidden button (e.g. a condition option)", () => {
    const dom = new JSDOM(`<button>Pre-owned - Good</button>`);
    const button = dom.window.document.querySelector("button")!;
    expect(() => safeClick(button, "TEST")).not.toThrow();
  });

  it("every other verified forbidden pattern still matches (defence in depth, not a regression from the 'List it' fix)", () => {
    for (const name of ["Publish", "Submit listing", "Go live", "Activate listing", "List item"]) {
      expect(isForbiddenActionName(name), name).toBe(true);
    }
  });

  it("assertNotForbiddenAction throws for a forbidden name and is silent for an allowed one", () => {
    expect(() => assertNotForbiddenAction("List it for free")).toThrow();
    expect(() => assertNotForbiddenAction("Continue")).not.toThrow();
  });
});
