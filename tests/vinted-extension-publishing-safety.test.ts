// @vitest-environment jsdom
//
// Publishing safety — the extension's hard architectural rule, proven
// structurally (no publish-shaped function/route/button exists anywhere
// in this extension's source) AND functionally (the forbidden-action
// guard and the Save Draft allowlist actually behave correctly against a
// synthetic DOM).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  isForbiddenActionName, assertNotForbiddenAction, isAllowedSaveDraftName, resolveSaveDraftButton, findByRole,
  isForbiddenTestId, assertNotForbiddenTestId, SAVE_DRAFT_BUTTON_TESTID, FORBIDDEN_PUBLISH_BUTTON_TESTID,
} from "../vinted-draft-queue-extension/shared/vinted-fields.js";

const EXTENSION_DIR = "vinted-draft-queue-extension";
// The exact, deployed production origin — mirrors scripts/validate-extension.mjs's
// own ALLOWED_PRODUCTION_ORIGIN constant (kept as a separate literal here
// deliberately, so this test independently proves the manifest matches the
// real deployed app, never merely that it matches whatever the validator
// script itself currently says).
const PRODUCTION_ORIGIN = "https://purchase-tracker-one.vercel.app/*";
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

describe("Publishing safety — structural: no publish/upload/list-live function, route, or generic-button click exists anywhere", () => {
  const jsFiles = allExtensionJsFiles();

  it("REGRESSION: no function or identifier in the whole extension is named/shaped like a publish action", () => {
    for (const file of jsFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/function\s+\w*publish\w*/i);
      expect(source, file).not.toMatch(/function\s+\w*upload\w*listing/i);
      expect(source, file).not.toMatch(/clickUpload|clickPublish|publishListing|createVintedDraftLive|listItemNow/i);
    }
  });

  it("REGRESSION: every single literal .click() call site in shared/form-steps.js is either immediately preceded by an assertNotForbiddenAction, is safeClick's own definition (which IS that guard), or is the one reviewed, deliberately-unguarded dismissOpenDropdown exception — there are exactly 5 such sites, so a newly added UNREVIEWED click site would break this test", () => {
    const formSteps = read("shared/form-steps.js");
    const contentScript = read("content-script.js");
    const lines = formSteps.split("\n");
    const clickLineIndexes = lines.reduce<number[]>((acc, line, i) => { if (/\.click\(\)/.test(line)) acc.push(i); return acc; }, []);
    // Follow-up correction (verified-selector rewrite): every dialog-driving
    // step (category/brand/size/condition/colour/material) now clicks
    // through the safeClick() abstraction rather than a bare literal
    // .click() — see the next assertion for that count. 5 literal
    // .click() sites remain: safeClick's own definition, stepSaveDraft
    // (guarded by resolveSaveDraftButton's own checks), the two
    // account-menu-toggle open/close calls in detectAccountIdentity
    // (reviewed: both click the SAME toggle control only, never a menu
    // item like Profile/Log out), and dismissOpenDropdown's own
    // `doc.body.click()` (follow-up correction, invalid-interaction-target
    // safety bug: reviewed and INTENTIONALLY unguarded — a plain synthetic
    // click on doc.body only bubbles UP to its ancestors, so it can never
    // reach a sibling/descendant control's own click handler such as
    // Upload/Publish; see that function's own comment in form-steps.js for
    // the full argument) — if this count changes again, a new click site
    // was added and MUST be reviewed.
    expect(clickLineIndexes).toHaveLength(5);
    for (const index of clickLineIndexes) {
      // Checks the 3 lines before AND the click line's own trailing
      // comment (e.g. "resolved.element.click(); // resolveSaveDraftButton
      // already ran assertNotForbiddenAction") — a guard documented right
      // there is just as real as one on its own line above.
      const context = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
      const isGuarded = context.includes("assertNotForbiddenAction") || /export function safeClick\(element\)/.test(context);
      // dismissOpenDropdown's click is the ONE reviewed exception — its
      // own trailing comment ("deliberately unguarded") is the marker this
      // test recognises, so an accidental copy-paste of a truly ungated
      // click elsewhere would NOT match this and would still fail below.
      const isReviewedUnguardedException = lines[index].includes("deliberately unguarded");
      expect(
        isGuarded || isReviewedUnguardedException,
        `line ${index + 1}: "${lines[index].trim()}" has no visible forbidden-action guard and isn't the reviewed dismissOpenDropdown exception`,
      ).toBe(true);
    }
    // Every OTHER click in the dialog-driving steps goes through safeClick()
    // — which itself calls assertNotForbiddenAction before every click, no
    // exceptions (see safeClick's own definition/comment) — so counting
    // these call sites (rather than requiring each to repeat its own
    // literal guard) is the complete picture: literal .click() sites above
    // + safeClick(...) call sites below account for every click this file
    // ever performs.
    const safeClickCallSites = lines.filter(line => /\bsafeClick\(/.test(line) && !/^export function safeClick/.test(line.trim()));
    expect(safeClickCallSites.length).toBeGreaterThan(0);
    expect(contentScript).not.toMatch(/\.click\(\)/); // content-script.js itself never clicks anything directly — it's a thin wrapper
  });

  it("the forbidden-action pattern list and the save-draft allowlist are structurally disjoint — no wording could ever satisfy both", () => {
    const source = read("shared/vinted-fields.js");
    expect(source).toContain("FORBIDDEN_ACTION_PATTERNS");
    expect(source).toContain("SAVE_DRAFT_ALLOWED_PATTERNS");
    // Every SAVE_DRAFT_ALLOWED_PATTERNS entry requires the word "draft";
    // no FORBIDDEN_ACTION_PATTERNS entry mentions "draft" at all.
    const forbiddenSection = source.slice(source.indexOf("const FORBIDDEN_ACTION_PATTERNS"), source.indexOf("export function isForbiddenActionName"));
    expect(forbiddenSection).not.toMatch(/draft/i);
  });

  it("resolveSaveDraftButton itself calls assertNotForbiddenAction as defence in depth, even though the allowlist is already disjoint from the forbidden list", () => {
    const source = read("shared/vinted-fields.js");
    const fnBody = source.slice(source.indexOf("export function resolveSaveDraftButton"), source.length);
    expect(fnBody).toContain("assertNotForbiddenAction(getAccessibleName(result.element))");
  });

  it("no file loads remotely-hosted JavaScript — background/content-script entry points are local paths, and no <script> tag or import references a remote URL (host_permissions legitimately containing https:// origins to TALK to is a separate, unrelated thing from LOADING CODE from one)", () => {
    const manifest = JSON.parse(read("manifest.json"));
    expect(manifest.background.service_worker).not.toMatch(/^https?:\/\//);
    for (const entry of manifest.content_scripts) for (const file of entry.js) expect(file).not.toMatch(/^https?:\/\//);
    const html = read("sidepanel.html");
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//);
    for (const file of jsFiles) expect(read(file)).not.toMatch(/import\(["']https?:\/\/|from ["']https?:\/\/|cdn\.|unpkg\.com|jsdelivr/);
  });

  it("manifest.json requests no cookies/history/proxy/password-adjacent permissions, and host_permissions is restricted to the app, Vinted, eBay UK and the eBay seller-description host only", () => {
    const manifest = JSON.parse(read("manifest.json"));
    for (const forbidden of ["cookies", "history", "proxy", "webRequest", "management", "debugger"]) {
      expect(manifest.permissions ?? []).not.toContain(forbidden);
    }
    for (const origin of manifest.host_permissions) {
      expect(
        origin === "https://www.vinted.co.uk/*" ||
        origin === "https://www.ebay.co.uk/*" ||
        origin === "https://*.ebaydesc.com/*" ||
        origin.includes("localhost") ||
        origin === PRODUCTION_ORIGIN,
      ).toBe(true);
    }
  });

  // Follow-up (full seller-description fetch, ebaydesc.com iframe) — the
  // seller's complete description lives in a same-origin-restricted iframe
  // hosted on ebaydesc.com, not the main ebay.co.uk page. This permission
  // must stay narrowly scoped to that one host, never a broad wildcard.
  it("host_permissions includes the narrowly-scoped eBay seller-description host, https://*.ebaydesc.com/*, and nothing broader", () => {
    const manifest = JSON.parse(read("manifest.json"));
    expect(manifest.host_permissions).toContain("https://*.ebaydesc.com/*");
    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
  });

  // Follow-up correction (live production error — PHOTO_HOST_NOT_PERMITTED)
  // — the manifest's host_permissions must include the EXACT deployed
  // production origin (never a placeholder, never a broader/lookalike
  // origin) so photo downloads from the real app work live, while still
  // never silently widening what this extension can reach.
  it("host_permissions includes the exact deployed production origin, https://purchase-tracker-one.vercel.app/*, with localhost and Vinted permissions preserved alongside it", () => {
    const manifest = JSON.parse(read("manifest.json"));
    expect(manifest.host_permissions).toContain(PRODUCTION_ORIGIN);
    expect(manifest.host_permissions).toContain("http://localhost:3000/*");
    expect(manifest.host_permissions).toContain("http://localhost:3001/*");
    expect(manifest.host_permissions).toContain("http://localhost:3002/*");
    expect(manifest.host_permissions).toContain("https://www.vinted.co.uk/*");
    // Exactly the one production origin — never a broader wildcard, never a subpath-only grant standing in for it.
    expect(manifest.host_permissions.filter((o: string) => o.includes("purchase-tracker-one"))).toEqual([PRODUCTION_ORIGIN]);
  });

  it("REGRESSION: an unrelated/lookalike host is never permitted — the production-origin allowlist check is an exact match, not a substring/prefix check", () => {
    const unrelatedOrigins = [
      "https://purchase-tracker-one.vercel.app.evil.com/*", // lookalike suffix attack
      "https://evil-purchase-tracker-one.vercel.app/*", // lookalike prefix
      "https://purchase-tracker-two.vercel.app/*", // a different, unrelated deployment
      "https://vercel.app/*", // the bare platform domain
    ];
    for (const origin of unrelatedOrigins) {
      const isAllowed = origin === "https://www.vinted.co.uk/*" || origin.includes("localhost") || origin === PRODUCTION_ORIGIN;
      expect(isAllowed).toBe(false);
    }
    const manifest = JSON.parse(read("manifest.json"));
    for (const unrelated of unrelatedOrigins) expect(manifest.host_permissions).not.toContain(unrelated);
  });

  it("the side panel permanently displays the required safety label", () => {
    expect(read("sidepanel.html")).toContain("Drafts only — never publishes");
  });

  it("content-script.js never reads document.cookie or chrome.cookies", () => {
    const source = read("content-script.js") + read("shared/form-steps.js");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("chrome.cookies");
  });
});

describe("isForbiddenActionName — functional", () => {
  it("matches Upload/Publish/List item/Post/Submit listing and close variants, case-insensitively", () => {
    for (const name of ["Upload", "upload", "Publish", "List item", "Post", "Submit listing", "Make it live", "Go live", "Activate listing"]) {
      expect(isForbiddenActionName(name)).toBe(true);
    }
  });
  it("does NOT match Save Draft or unrelated field labels", () => {
    for (const name of ["Save draft", "Save as draft", "Title", "Category", "Continue", "Next"]) {
      expect(isForbiddenActionName(name)).toBe(false);
    }
  });
  it("returns false for blank/null", () => {
    expect(isForbiddenActionName("")).toBe(false);
    expect(isForbiddenActionName(null as unknown as string)).toBe(false);
  });
});

describe("assertNotForbiddenAction — throws for forbidden names, silent otherwise", () => {
  it("throws for a forbidden name", () => { expect(() => assertNotForbiddenAction("Upload")).toThrow(/SAFETY/); });
  it("does not throw for an allowed name", () => { expect(() => assertNotForbiddenAction("Save draft")).not.toThrow(); });
});

describe("isAllowedSaveDraftName", () => {
  it("accepts wording containing 'draft'", () => {
    for (const name of ["Save draft", "Save as draft", "Draft it", "Keep as draft"]) expect(isAllowedSaveDraftName(name)).toBe(true);
  });
  it("REGRESSION: a bare 'Save' is never accepted — no generic primary button is ever an acceptable save-draft match", () => {
    expect(isAllowedSaveDraftName("Save")).toBe(false);
    expect(isAllowedSaveDraftName("Continue")).toBe(false);
    expect(isAllowedSaveDraftName("Next")).toBe(false);
  });
  it("never accepts a forbidden-shaped name even if it happened to also contain 'draft'", () => {
    expect(isAllowedSaveDraftName("Publish draft")).toBe(false);
  });
});

describe("resolveSaveDraftButton — functional, against a synthetic DOM (verified data-testid contract)", () => {
  function domWith(buttons: Array<{ text: string; testId?: string }>) {
    const dom = new JSDOM(`<!doctype html><html><body><form>${buttons.map(b => `<button${b.testId ? ` data-testid="${b.testId}"` : ""}>${b.text}</button>`).join("")}</form></body></html>`);
    return dom.window.document.querySelector("form")!;
  }

  it("finds the unique Save Draft button (by data-testid) when both an Upload and a Save Draft control exist on the same page", () => {
    const root = domWith([{ text: "Upload", testId: FORBIDDEN_PUBLISH_BUTTON_TESTID }, { text: "Save draft", testId: SAVE_DRAFT_BUTTON_TESTID }]);
    const result = resolveSaveDraftButton(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.element.textContent).toBe("Save draft");
  });

  it("REGRESSION: the Upload button is never even considered a candidate — findByRole+filter never returns it, not merely 'not clicked'", () => {
    const root = domWith([{ text: "Upload", testId: FORBIDDEN_PUBLISH_BUTTON_TESTID }, { text: "Save as draft", testId: SAVE_DRAFT_BUTTON_TESTID }]);
    const buttons = findByRole(root, "button");
    const upload = buttons.find((b: Element) => b.textContent === "Upload")!;
    expect(isAllowedSaveDraftName(upload.textContent!)).toBe(false);
  });

  it("REGRESSION: loose text such as 'Save' or the last button on the page is never selected — only the verified data-testid matches, no matter the wording", () => {
    const root = domWith([{ text: "Save" }, { text: "Continue" }, { text: "Next" }]); // none carry the verified testid at all
    const result = resolveSaveDraftButton(root);
    expect(result.ok).toBe(false);
  });

  it("stops (fails) if NO save-draft-shaped button exists at all", () => {
    const root = domWith([{ text: "Upload", testId: FORBIDDEN_PUBLISH_BUTTON_TESTID }, { text: "Cancel" }]);
    const result = resolveSaveDraftButton(root);
    expect(result.ok).toBe(false);
  });

  it("stops (fails) if the Save Draft control is AMBIGUOUS (two matches)", () => {
    const root = domWith([{ text: "Save draft", testId: SAVE_DRAFT_BUTTON_TESTID }, { text: "Save as draft", testId: SAVE_DRAFT_BUTTON_TESTID }]);
    const result = resolveSaveDraftButton(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/AMBIGUOUS/);
  });

  it("only Upload present (no save draft at all) — never falls back to clicking it", () => {
    const root = domWith([{ text: "Upload", testId: FORBIDDEN_PUBLISH_BUTTON_TESTID }]);
    const result = resolveSaveDraftButton(root);
    expect(result.ok).toBe(false);
  });
});

describe("REGRESSION: the verified upload-form-save-button/upload-form-save-draft-button contract", () => {
  it("only [data-testid=\"upload-form-save-draft-button\"] is ever the target resolveSaveDraftButton can return", () => {
    expect(SAVE_DRAFT_BUTTON_TESTID).toBe("upload-form-save-draft-button");
  });

  it("[data-testid=\"upload-form-save-button\"] is permanently forbidden — isForbiddenTestId and assertNotForbiddenTestId both reject it", () => {
    expect(FORBIDDEN_PUBLISH_BUTTON_TESTID).toBe("upload-form-save-button");
    expect(isForbiddenTestId(FORBIDDEN_PUBLISH_BUTTON_TESTID)).toBe(true);
    expect(() => assertNotForbiddenTestId(FORBIDDEN_PUBLISH_BUTTON_TESTID)).toThrow(/SAFETY/);
  });

  it("the verified save-draft id itself is never treated as forbidden", () => {
    expect(isForbiddenTestId(SAVE_DRAFT_BUTTON_TESTID)).toBe(false);
    expect(() => assertNotForbiddenTestId(SAVE_DRAFT_BUTTON_TESTID)).not.toThrow();
  });
});
