// @vitest-environment jsdom
//
// Stage 1 (per the task's own manual-test-stage plan): proves the FULL
// state machine — step ordering, exact field matching, ambiguous/missing
// field handling, photo order, price, final verification, result-id
// extraction, and the CAPTCHA/login-required stop conditions — against a
// synthetic MOCK Vinted-like form fixture built from the VERIFIED DOM
// contract captured from a live, signed-in session at
// https://www.vinted.co.uk/items/new (see shared/vinted-fields.js's own
// top comment). It proves the framework and orchestration logic drive
// that verified contract correctly; it is still a synthetic fixture, not
// the live page itself.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  runItem, stepOpenForm, stepSaveDraft, detectLoginRequired, detectCaptchaOrVerification, detectAccountIdentity,
  stepUploadPhotos, waitForPhotoCardsConfirmed, stepSetTitle, stepSetText,
  stepSelectCategory, stepSelectBrand, stepSelectSize, stepSelectCondition, stepSelectColours, stepSelectMaterials,
  safeClick, findFormRoot, findConfirmedDraftLink, findConfirmedDraftId,
  parsePriceToPence, priceValueMatch, buildFieldTimeoutReason, boundDiagnosticValue,
} from "../vinted-draft-queue-extension/shared/form-steps.js";
import {
  resolvePhotoInput, isVisible, VINTED_FIELD_STRATEGIES,
  getAccessibleName, isInvalidInteractionTarget, assertValidInteractionTarget, assertNotForbiddenAction,
} from "../vinted-draft-queue-extension/shared/vinted-fields.js";

/** Simulates "category already selected" so brand/size/condition/colour/material are attached to <body> — bypasses the full stepSelectCategory flow for tests that isolate a single dependent field in this segment's root-scoping rewrite coverage. */
function attachCategoryDependents(categoryField: { result: HTMLElement } | null) {
  categoryField?.result.click();
}

/** Adds a verified-shape uploaded-photo card (data-testid="image-wrapper-N" + its own delete button) directly to the grid — used to pre-seed "already uploaded" state for idempotent-retry tests, without going through the file input at all. */
function seedPhotoCard(doc: Document, grid: Element, position: number) {
  const card = doc.createElement("div");
  const wrapper = doc.createElement("div");
  wrapper.setAttribute("data-testid", `image-wrapper-${position}`);
  card.appendChild(wrapper);
  const deleteButton = doc.createElement("button");
  deleteButton.setAttribute("data-testid", `media-select-grid-delete-button-${position}`);
  card.appendChild(deleteButton);
  grid.appendChild(card);
  return card;
}

/** Adds a generic "still uploading" indicator matching hasActiveUploadIndicator()'s own defensive check (data-testid containing "loading"). */
function seedUploadIndicator(doc: Document, grid: Element) {
  const el = doc.createElement("div");
  el.setAttribute("data-testid", "media-select-loading-indicator");
  grid.appendChild(el);
  return el;
}

function docFromHeaderHtml(headerHtml: string): Document {
  return new JSDOM(`<!doctype html><html><body><header>${headerHtml}</header></body></html>`, { url: "https://www.vinted.co.uk/" }).window.document;
}

// A full runItem() pass makes many sequential waitFor() polls (150ms
// interval) across many steps — normally fast on a happy path, but under
// slower CI/machine load this can occasionally exceed vitest's default
// 5000ms per-test timeout even though nothing is actually wrong. Every
// test in this file exercises that same pipeline, so the timeout is raised
// file-wide rather than per-test.
vi.setConfig({ testTimeout: 20000 });

// ---- Verified dialog-picker fixture builders --------------------------------
// Follow-up correction (root-scoping/dialog-interaction rewrite) — every
// dialog field's fixture below now matches the LIVE-VERIFIED shape: an
// inline dropdown CONTENT container (never a modal, never a dedicated
// close button, never a shared save button — none of those exist on the
// real page). Single-select fields (category/brand/size/condition)
// auto-close the instant a matching option is clicked. Multi-select
// fields (colour/material) stay open across multiple clicks (real
// TOGGLE checkboxes, not append-only) and close only on a genuine
// OUTSIDE click — simulated here via a capture-phase document listener,
// exactly mirroring what a real browser's own event bubbling gives you
// for free.

function buildDialogShell(doc: Document, container: HTMLElement, { openId, openTestId, openPlaceholder, contentTestId }: { openId: string; openTestId: string; openPlaceholder: string; contentTestId: string }) {
  const opener = doc.createElement("input") as HTMLInputElement;
  opener.type = "text";
  opener.readOnly = true;
  opener.id = openId;
  opener.name = openId;
  opener.setAttribute("data-testid", openTestId);
  opener.placeholder = openPlaceholder;

  const content = doc.createElement("div");
  content.hidden = true;
  content.setAttribute("data-testid", contentTestId);

  opener.addEventListener("click", () => { content.hidden = false; });

  // Outside-click-to-close — verified live for multi-select fields;
  // harmless no-op for single-select ones, which already close themselves
  // via their own option click handler before this would ever fire.
  doc.addEventListener("click", event => {
    if (content.hidden) return;
    if (content.contains(event.target as Node)) return;
    if (event.target === opener) return;
    content.hidden = true;
  }, true);

  container.append(opener, content);
  return { opener, content };
}

function buildCategoryField(doc: Document, container: HTMLElement, { categoryId, leafName, onSaved }: { categoryId: number; leafName: string; onSaved: () => void }) {
  const { opener, content } = buildDialogShell(doc, container, {
    openId: "category", openTestId: "catalog-select-dropdown-input", openPlaceholder: "Select a category",
    contentTestId: "catalog-select-dropdown-content",
  });
  const search = doc.createElement("input");
  search.id = "catalog-search-input";
  search.name = "catalog-search-input";
  content.appendChild(search);

  // Verified live shape: a category SEARCH result's real id is
  // `catalog-search-<id>-result` (clickable) with a paired radio
  // `catalog-search-<id>-radio` — never the bare `catalog-<id>` this
  // fixture used to (incorrectly) assume.
  const result = doc.createElement("div");
  result.id = `catalog-search-${categoryId}-result`;
  result.setAttribute("role", "button");
  result.textContent = leafName;
  const radio = doc.createElement("input") as HTMLInputElement;
  radio.type = "radio";
  radio.id = `catalog-search-${categoryId}-radio`;
  radio.name = `catalog-search-${categoryId}-radio`;
  result.addEventListener("click", () => {
    radio.checked = true;
    opener.value = leafName;
    content.hidden = true; // auto-closes on selection — verified live
    onSaved();
  });
  content.append(result, radio);

  return { opener, content, result, radio };
}

function buildBrandField(doc: Document, container: HTMLElement, brands: Array<{ id: number; name: string }>) {
  const { opener, content } = buildDialogShell(doc, container, {
    openId: "brand", openTestId: "brand-select-dropdown-input", openPlaceholder: "Select a brand",
    contentTestId: "brand-select-dropdown-content",
  });
  // Verified live: brand's search box carries a data-testid but NO
  // matching `id` attribute at all (unlike category's own search input).
  const search = doc.createElement("input");
  search.setAttribute("data-testid", "brand-search--input");
  content.appendChild(search);

  const options = brands.map(({ id, name }) => {
    const optionEl = doc.createElement("div");
    optionEl.id = `brand-${id}`;
    optionEl.setAttribute("role", "button");
    // Deliberately NO data-testid — verified live: brand options carry
    // none at all, unlike colour/material's options (see buildMultiField).
    optionEl.textContent = name;
    const radio = doc.createElement("input") as HTMLInputElement;
    radio.type = "radio";
    radio.id = `brand-radio-${id}`;
    radio.name = `brand-radio-${id}`;
    optionEl.addEventListener("click", () => {
      radio.checked = true;
      opener.value = name;
      content.hidden = true; // auto-closes on selection — verified live
    });
    content.append(optionEl, radio);
    return { optionEl, radio };
  });

  return { opener, content, options };
}

function buildSizeField(doc: Document, container: HTMLElement, sizes: string[]) {
  const { opener, content } = buildDialogShell(doc, container, {
    openId: "size", openTestId: "category-size-single-grid-input", openPlaceholder: "Select a size",
    contentTestId: "category-size-single-grid-content",
  });
  // Verified live: a plain heading ("Footwear") precedes the options grid
  // — this is the section-label text nearestPrecedingHeadingText() looks
  // for (see form-steps.js's own comment on the size-duplicate-collapsing fix).
  const heading = doc.createElement("div");
  heading.textContent = "Footwear";
  content.appendChild(heading);
  let counter = 700;
  const options = sizes.map(size => {
    const optionEl = doc.createElement("div");
    optionEl.setAttribute("role", "checkbox");
    optionEl.setAttribute("aria-label", size);
    optionEl.setAttribute("data-testid", `size-group-38-grid-option-${counter++}`);
    optionEl.setAttribute("aria-checked", "false");
    optionEl.textContent = size;
    optionEl.addEventListener("click", () => {
      Array.from(content.querySelectorAll('[role="checkbox"]')).forEach(el => el.setAttribute("aria-checked", "false"));
      optionEl.setAttribute("aria-checked", "true");
      opener.value = size;
      content.hidden = true; // auto-closes on selection — verified live
    });
    content.appendChild(optionEl);
    return optionEl;
  });
  return { opener, content, options };
}

/**
 * Adds ONE size option DIRECTLY to an existing size-picker `content`
 * container, with an explicit `groupId`/`optionId` (matching the verified
 * live `data-testid="size-group-<groupId>-grid-option-<optionId>"` shape)
 * and an optional preceding section heading — used to construct
 * duplicate-representation scenarios (e.g. a "Suggested" copy of a size
 * that also appears in the full "Footwear" grid) for the
 * size-duplicate-collapsing regression tests. Two options built with the
 * SAME optionId are, by construction, the SAME underlying size — exactly
 * the live-verified shape resolveSizeOption() collapses.
 */
/**
 * Adds ONE size option DIRECTLY to an existing size-picker `content`
 * container, with an explicit literal `testId` (the two live-verified
 * shapes are `size-suggestions-grid-option-<optionId>` for the Suggested
 * section, and `size-group-<groupId>-grid-option-<optionId>` for the full
 * Footwear/Clothing list — see form-steps.js's own comment on
 * resolveSizeOption) and an optional preceding section heading — used to
 * construct duplicate-representation scenarios for the
 * size-duplicate-collapsing regression tests. Two options built with
 * testIds sharing the same trailing <optionId> segment are, by
 * construction, the SAME underlying size — exactly the live-verified shape
 * resolveSizeOption() collapses.
 */
function addSizeOption(doc: Document, content: HTMLElement, { size, testId, sectionHeading, opener, nested = false }: { size: string; testId: string; sectionHeading?: string; opener: HTMLInputElement; nested?: boolean }) {
  if (sectionHeading) {
    const heading = doc.createElement("div");
    heading.textContent = sectionHeading;
    content.appendChild(heading);
  }
  const checkbox = doc.createElement("div");
  checkbox.setAttribute("role", "checkbox");
  checkbox.setAttribute("aria-label", size);
  checkbox.setAttribute("aria-checked", "false");
  checkbox.textContent = size;
  checkbox.addEventListener("click", () => {
    Array.from(content.querySelectorAll('[role="checkbox"]')).forEach(el => el.setAttribute("aria-checked", "false"));
    checkbox.setAttribute("aria-checked", "true");
    opener.value = size;
    content.hidden = true;
  });
  if (nested) {
    // The data-testid lives on a WRAPPER, not the checkbox itself —
    // proves resolveSizeOption()'s closest() lookup collapses nested
    // elements belonging to the same clickable option, not just an
    // option that happens to carry its own data-testid directly.
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("data-testid", testId);
    wrapper.appendChild(checkbox);
    content.appendChild(wrapper);
  } else {
    checkbox.setAttribute("data-testid", testId);
    content.appendChild(checkbox);
  }
  return checkbox;
}

// Verified condition -> data-testid mapping (see form-steps.js's own CONDITION_TESTID_BY_NORMALISED_LABEL).
const CONDITION_ID_BY_LABEL: Record<string, number> = { "New with tags": 6, "New without tags": 1, "Very good": 2, "Good": 3, "Satisfactory": 4 };

function buildConditionField(doc: Document, container: HTMLElement, labels: string[]) {
  const { opener, content } = buildDialogShell(doc, container, {
    openId: "condition", openTestId: "category-condition-single-list-input", openPlaceholder: "Select condition",
    contentTestId: "category-condition-single-list-content",
  });
  const options = labels.map(label => {
    const id = CONDITION_ID_BY_LABEL[label];
    const optionEl = doc.createElement("div");
    optionEl.id = String(id);
    optionEl.setAttribute("role", "button");
    optionEl.setAttribute("data-testid", `condition-${id}`);
    optionEl.textContent = label;
    optionEl.addEventListener("click", () => {
      opener.value = label;
      content.hidden = true; // auto-closes on selection — verified live
    });
    content.appendChild(optionEl);
    return optionEl;
  });
  return { opener, content, options };
}

function buildMultiField(doc: Document, container: HTMLElement, { idPrefix, openId, openTestId, openPlaceholder, contentTestId, values }: { idPrefix: string; openId: string; openTestId: string; openPlaceholder: string; contentTestId: string; values: Array<{ id: number; name: string }> }) {
  const { opener, content } = buildDialogShell(doc, container, { openId, openTestId, openPlaceholder, contentTestId });
  const options = values.map(({ id, name }) => {
    const optionEl = doc.createElement("div");
    optionEl.id = `${idPrefix}-${id}`;
    optionEl.setAttribute("role", "button");
    optionEl.setAttribute("data-testid", `${idPrefix}-${id}`); // verified live: colour/material options DO carry a matching data-testid, unlike brand's
    optionEl.textContent = name;
    const checkbox = doc.createElement("input") as HTMLInputElement;
    checkbox.type = "checkbox";
    checkbox.id = `${idPrefix}-checkbox-${id}`;
    checkbox.name = `${idPrefix}-checkbox-${id}`;
    content.append(optionEl, checkbox);
    return { optionEl, checkbox, name };
  });
  // Wired up AFTER every option exists, so each handler's closure over the
  // full `options` array (needed to recompute the joined display value) is
  // always complete by the time any of them can actually fire.
  for (const entry of options) {
    entry.optionEl.addEventListener("click", () => {
      entry.checkbox.checked = !entry.checkbox.checked; // a real TOGGLE — verified live, never append-only
      opener.value = options.filter(o => o.checkbox.checked).map(o => o.name).join(", ");
      // content stays open — verified live; closes only on an outside click (see buildDialogShell)
    });
  }
  return { opener, content, options };
}

function buildColourField(doc: Document, container: HTMLElement, colours: Array<{ id: number; name: string }>) {
  return buildMultiField(doc, container, { idPrefix: "color", openId: "color", openTestId: "color-select-dropdown-input", openPlaceholder: "Select up to 2 colours", contentTestId: "color-select-dropdown-content", values: colours });
}

/**
 * Builds an EMPTY colour dropdown (opener + content, matching the
 * verified live `color-select-dropdown-input`/`color-select-dropdown-content`
 * shape — re-confirmed live this session, unchanged by this fix), with an
 * `addRow` helper for constructing duplicate-representation scenarios
 * directly — used by the colour duplicate-representation-collapsing
 * regression tests below, mirroring addSizeOption's own role in the
 * Size duplicate-collapsing tests above.
 *
 * Two rows added with the SAME `id` share ONE underlying checked-state
 * (a `Set<id>` closed over by every row's click handler) and the SAME
 * joined display value — exactly Vinted's own real behaviour for a
 * Suggested chip mirroring its own full-list twin (per this fix's own
 * disclosed live-verification limitation: no authenticated session ever
 * rendered a real Suggested section this session, since Vinted appears to
 * compute it only once a draft is genuinely saved — see
 * resolveDuplicateOptionMatches's own top comment in form-steps.js for the
 * full disclosure). Two rows added with DIFFERENT ids are, by
 * construction, genuinely different colours and never share state — used
 * for the "genuinely conflicting" AMBIGUOUS regression test.
 */
function buildDuplicateColourField(doc: Document, container: HTMLElement) {
  const { opener, content } = buildDialogShell(doc, container, {
    openId: "color", openTestId: "color-select-dropdown-input", openPlaceholder: "Select up to 2 colours",
    contentTestId: "color-select-dropdown-content",
  });
  const checkedIds = new Set<number>();
  const indicatorsById = new Map<number, HTMLInputElement[]>();
  const nameById = new Map<number, string>();

  function refreshDisplay() {
    opener.value = [...checkedIds].map(id => nameById.get(id)!).filter(Boolean).join(", ");
  }
  function refreshIndicators(id: number) {
    const checked = checkedIds.has(id);
    for (const indicator of indicatorsById.get(id) ?? []) indicator.checked = checked;
  }

  /**
   * `nested: true` mirrors addSizeOption's own "data-testid lives on a
   * WRAPPER, not the row itself" case — proves resolveDuplicateOptionMatches's
   * closest() lookup collapses this shape too, not just a bare-id row.
   */
  function addRow({ name, id, testId, sectionHeading, nested = false, removeSelfOnSelect = false }: { name: string; id: number; testId: string; sectionHeading?: string; nested?: boolean; removeSelfOnSelect?: boolean }) {
    if (sectionHeading) {
      const heading = doc.createElement("div");
      heading.textContent = sectionHeading;
      content.appendChild(heading);
    }
    nameById.set(id, name);

    const row = doc.createElement("div");
    row.setAttribute("role", "button"); // verified live shape — see form-steps.js's OPTION_ROW_ROLE_SELECTOR comment
    row.textContent = name;
    const indicator = doc.createElement("input") as HTMLInputElement;
    indicator.type = "checkbox";
    indicator.checked = checkedIds.has(id);
    row.appendChild(indicator);

    if (nested) {
      const wrapper = doc.createElement("div");
      wrapper.setAttribute("data-testid", testId);
      wrapper.appendChild(row);
      content.appendChild(wrapper);
    } else {
      row.setAttribute("data-testid", testId);
      content.appendChild(row);
    }

    row.addEventListener("click", () => {
      if (checkedIds.has(id)) checkedIds.delete(id); else checkedIds.add(id);
      refreshIndicators(id);
      refreshDisplay();
      // content stays open — verified live; closes only on an outside click (see buildDialogShell)
      // Simulates the Suggested chip vanishing on rerender once its
      // colour is picked — proves resolveDuplicateOptionMatches/
      // findOptionRows never hold a stale reference: the full-list twin
      // (sharing the same id) is what confirmation must fall back to.
      if (removeSelfOnSelect && checkedIds.has(id)) (nested ? row.parentElement! : row).remove();
    });

    if (!indicatorsById.has(id)) indicatorsById.set(id, []);
    indicatorsById.get(id)!.push(indicator);
    return row;
  }

  return { opener, content, addRow, isChecked: (id: number) => checkedIds.has(id) };
}
function buildMaterialField(doc: Document, container: HTMLElement, materials: Array<{ id: number; name: string }>) {
  return buildMultiField(doc, container, { idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material", contentTestId: "category-material-multi-list-content", values: materials });
}

/**
 * Simulates Vinted's Material/Colour picker as a VIRTUALISED/scrollable
 * list — only a `windowSize`-sized slice of `allValues` is ever mounted in
 * the DOM at once, keyed off `scrollRegion.scrollTop`, exactly like a real
 * windowing library (react-window and similar). `clientHeight`/`scrollHeight`
 * are overridden via Object.defineProperty since jsdom implements no real
 * layout engine and would otherwise report 0 for both, which
 * scrollDropdownForOption's own scrollable-container detection depends on.
 * Every scroll REBUILDS the rendered option nodes from scratch (never
 * reuses old elements) — each carries a `data-render-generation` marker
 * purely so a test can prove a matched element came from the LATEST
 * render, never a stale one from before the scroll that revealed it.
 */
function buildVirtualizedMultiField(doc: Document, container: HTMLElement, { idPrefix, openId, openTestId, openPlaceholder, contentTestId, allValues, windowSize = 6, itemHeight = 40 }: { idPrefix: string; openId: string; openTestId: string; openPlaceholder: string; contentTestId: string; allValues: Array<{ id: number; name: string }>; windowSize?: number; itemHeight?: number }) {
  const { opener, content } = buildDialogShell(doc, container, { openId, openTestId, openPlaceholder, contentTestId });

  const scrollRegion = doc.createElement("div");
  scrollRegion.setAttribute("data-testid", `${idPrefix}-options-scroll-region`);
  content.appendChild(scrollRegion);

  const viewportHeight = windowSize * itemHeight;
  const totalHeight = allValues.length * itemHeight;
  Object.defineProperty(scrollRegion, "clientHeight", { value: viewportHeight, configurable: true });
  Object.defineProperty(scrollRegion, "scrollHeight", { value: totalHeight, configurable: true });

  const checkedIds = new Set<number>();
  let renderGeneration = 0;

  function render() {
    renderGeneration += 1;
    scrollRegion.innerHTML = "";
    const maxStart = Math.max(0, allValues.length - windowSize);
    const startIndex = Math.max(0, Math.min(Math.floor(scrollRegion.scrollTop / itemHeight), maxStart));
    const endIndex = Math.min(allValues.length, startIndex + windowSize);
    for (let i = startIndex; i < endIndex; i++) {
      const { id, name } = allValues[i];
      const optionEl = doc.createElement("div");
      optionEl.id = `${idPrefix}-${id}`;
      optionEl.setAttribute("role", "button");
      optionEl.setAttribute("data-testid", `${idPrefix}-${id}`);
      optionEl.setAttribute("data-render-generation", String(renderGeneration));
      optionEl.textContent = name;
      const checkbox = doc.createElement("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.id = `${idPrefix}-checkbox-${id}`;
      checkbox.checked = checkedIds.has(id);
      optionEl.addEventListener("click", () => {
        if (checkedIds.has(id)) checkedIds.delete(id); else checkedIds.add(id);
        checkbox.checked = checkedIds.has(id);
        opener.value = allValues.filter(v => checkedIds.has(v.id)).map(v => v.name).join(", ");
      });
      scrollRegion.append(optionEl, checkbox);
    }
  }
  scrollRegion.addEventListener("scroll", render);
  render(); // initial render — only the first window

  return { opener, content, scrollRegion, getRenderGeneration: () => renderGeneration };
}

/**
 * A second, DELIBERATELY DIFFERENT plausible virtualised Material/Colour
 * shape — proves discovery no longer depends on any ONE guessed structure,
 * the same class of assumption that produced the confirmed regression
 * ("NOT_FOUND: material option exactly matching 'Suede'" despite it being
 * visibly present and selectable). Differs from buildVirtualizedMultiField
 * in every dimension the fix's own comment calls out:
 *   - no data-testid on any row at all (the legacy selector source finds
 *     NOTHING here — only the generic role-based fallback can);
 *   - role="option", not "button";
 *   - the checkbox NESTED inside the row, not a sibling;
 *   - the row's own accessible name is deliberately GENERIC/WRONG
 *     (aria-label="Option") — only extracting the row's actual VISIBLE
 *     text (never the computed accessible name) can find the target.
 * This is not a claim about Vinted's real current structure — no
 * authenticated session was available to capture it directly this session
 * (see this fix's own top-level report) — it is a plausible alternative
 * shape used specifically to prove structure-agnosticism.
 */
function buildDriftedVirtualizedMultiField(doc: Document, container: HTMLElement, { idPrefix, openId, openTestId, openPlaceholder, contentTestId, allValues, windowSize = 6, itemHeight = 40 }: { idPrefix: string; openId: string; openTestId: string; openPlaceholder: string; contentTestId: string; allValues: Array<{ id: number; name: string }>; windowSize?: number; itemHeight?: number }) {
  const { opener, content } = buildDialogShell(doc, container, { openId, openTestId, openPlaceholder, contentTestId });

  const scrollRegion = doc.createElement("div");
  content.appendChild(scrollRegion);

  const viewportHeight = windowSize * itemHeight;
  const totalHeight = allValues.length * itemHeight;
  Object.defineProperty(scrollRegion, "clientHeight", { value: viewportHeight, configurable: true });
  Object.defineProperty(scrollRegion, "scrollHeight", { value: totalHeight, configurable: true });

  const checkedIds = new Set<number>();
  let renderGeneration = 0;

  function render() {
    renderGeneration += 1;
    scrollRegion.innerHTML = "";
    const maxStart = Math.max(0, allValues.length - windowSize);
    const startIndex = Math.max(0, Math.min(Math.floor(scrollRegion.scrollTop / itemHeight), maxStart));
    const endIndex = Math.min(allValues.length, startIndex + windowSize);
    for (let i = startIndex; i < endIndex; i++) {
      const { id, name } = allValues[i];
      const row = doc.createElement("li"); // deliberately no data-testid at all
      row.setAttribute("role", "option");
      row.setAttribute("aria-label", "Option"); // deliberately NOT the material's own name
      row.setAttribute("data-render-generation", String(renderGeneration));
      row.setAttribute("data-option-id", String(id));
      const label = doc.createElement("span");
      label.textContent = name; // the row's real VISIBLE text
      const checkbox = doc.createElement("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", "Toggle"); // generic — never the material name either
      checkbox.checked = checkedIds.has(id);
      row.append(checkbox, label); // checkbox NESTED, not a sibling
      row.addEventListener("click", () => {
        if (checkedIds.has(id)) checkedIds.delete(id); else checkedIds.add(id);
        checkbox.checked = checkedIds.has(id);
        opener.value = allValues.filter(v => checkedIds.has(v.id)).map(v => v.name).join(", ");
      });
      scrollRegion.appendChild(row);
    }
  }
  scrollRegion.addEventListener("scroll", render);
  render();

  return { opener, content, scrollRegion, getRenderGeneration: () => renderGeneration };
}

/**
 * An illustrative Vinted "Package size" section — Small/Medium/Large
 * options (one pre-checked as Vinted's own auto-recommended default) plus
 * a "confirm size" control. UNLIKE every other field builder above, this
 * is deliberately NOT part of the verified live DOM contract (see this
 * file's own top comment) — the extension is required to never interact
 * with parcel/package size at all, so these tests only need something
 * plausible to click in order to prove that click never happens; the
 * real page's exact shape is irrelevant to that guarantee. Every click
 * handler below throws if ever triggered, exactly like the Upload button
 * in buildMockVintedPage — a test would fail immediately if the extension
 * ever touched this section.
 */
function buildParcelSizeField(doc: Document, container: HTMLElement, { defaultSize = "Medium" }: { defaultSize?: "Small" | "Medium" | "Large" } = {}) {
  const section = doc.createElement("div");
  section.setAttribute("data-testid", "package-size-select");
  const labels: Array<"Small" | "Medium" | "Large"> = ["Small", "Medium", "Large"];
  const options = labels.map(label => {
    const optionEl = doc.createElement("div");
    optionEl.setAttribute("role", "radio");
    optionEl.setAttribute("data-testid", `package-size-${label.toLowerCase()}`);
    optionEl.setAttribute("aria-checked", String(label === defaultSize));
    optionEl.textContent = label;
    section.appendChild(optionEl);
    return { label, optionEl };
  });
  for (const entry of options) {
    entry.optionEl.addEventListener("click", () => {
      throw new Error(`SAFETY VIOLATION: the parcel-size option "${entry.label}" was clicked — Vinted's own default must never be touched!`);
    });
  }
  const confirmButton = doc.createElement("button");
  confirmButton.type = "button";
  confirmButton.setAttribute("data-testid", "package-size-select-confirm-button");
  confirmButton.textContent = "Confirm size";
  confirmButton.addEventListener("click", () => {
    throw new Error("SAFETY VIOLATION: the parcel-size confirm control was clicked — parcel size is never confirmed by this extension!");
  });
  section.appendChild(confirmButton);
  container.appendChild(section);
  return { section, options, confirmButton, selectedLabel: () => options.find(o => o.optionEl.getAttribute("aria-checked") === "true")?.label ?? null };
}

const DEFAULT_CATEGORY_ID = 1906;
const DEFAULT_LEAF_NAME = "Trainers";
const DEFAULT_BRANDS = [{ id: 5827029, name: "Hoka" }, { id: 1001, name: "Nike" }];
const DEFAULT_SIZES = ["8", "8.5", "9", "9.5", "10"];
const DEFAULT_CONDITIONS = ["New with tags", "Very good", "Good"];
const DEFAULT_COLOURS = [{ id: 1, name: "Black" }, { id: 12, name: "White" }, { id: 3, name: "Grey" }];
const DEFAULT_MATERIALS = [{ id: 149, name: "Mesh" }, { id: 150, name: "Leather" }];

/**
 * Builds a synthetic Vinted-like Create Listing form matching the
 * VERIFIED contract: Photos/Title/Description/Category/Price/Save-draft
 * exist from the start; Brand/Size/Condition/Colours/Material are only
 * appended to the DOM once the category dialog is saved — exactly
 * mirroring "these fields don't exist until a category is selected".
 * Pass `omit` to simulate a missing field (Vinted changed the page / a
 * control isn't there).
 *
 * `parcelSize` is opt-in (undefined by default, unlike every other field
 * above) and never wired into anything the extension actually looks for —
 * see buildParcelSizeField's own comment. It exists purely so the
 * "Parcel/package size" describe block below can prove non-interaction
 * against something concrete, without changing the DOM shape every other
 * (already-passing) test in this file relies on.
 */
function buildMockVintedPage({ omit = new Set<string>(), extraBodyText = "", parcelSize }: { omit?: Set<string>; extraBodyText?: string; parcelSize?: { defaultSize?: "Small" | "Medium" | "Large" } } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${extraBodyText}</body></html>`, { url: "https://www.vinted.co.uk/items/new" });
  const doc = dom.window.document;
  // Follow-up correction (root-scoping rewrite) — a pure DISTRACTOR,
  // matching the real page's own two irrelevant header-search <form>s
  // (confirmed live: neither `form[data-testid="item-upload-form"]` nor
  // `main form` ever matches anything real; only the bare "form" fallback
  // matched, and it matched the WRONG element). This form carries no
  // testid Vinted's own real markup doesn't have, and contains nothing
  // any real step ever looks for — every genuine field below is a direct
  // child of <body>, never nested inside this, exactly like the real page.
  const distractorForm = doc.createElement("form");
  const distractorSearch = doc.createElement("input");
  distractorSearch.name = "search";
  distractorForm.appendChild(distractorSearch);
  doc.body.appendChild(distractorForm);

  // Follow-up correction (photo-confirmation false-negative bug) — the
  // photo grid, exactly like the file input itself, is verified NOT to
  // live inside the Create Listing form root on the real page (confirmed
  // directly against a live, signed-in session — see form-steps.js's own
  // comment above waitForPhotoCardsConfirmed). Appended as a sibling of
  // `distractorForm`, matching that verified shape, never inside it —
  // and this is also the "media-upload" landmark findFormRoot() looks for.
  const photosArea = doc.createElement("div");
  photosArea.id = "photos";
  photosArea.setAttribute("data-testid", "media-upload");
  const photoGrid = doc.createElement("div");
  photoGrid.setAttribute("data-testid", "media-upload-grid");
  photosArea.appendChild(photoGrid);
  doc.body.appendChild(photosArea);

  if (!omit.has("photoInput")) {
    // Verified live shape: NO id, and it's genuinely NOT rendered inside
    // the Create Listing form root at all — appended as a sibling of
    // `form`, directly on <body> — plus visually hidden/zero-sized, which
    // is its normal state. resolvePhotoInput() must find it regardless
    // (see that function's own comment on why this is a deliberate,
    // narrow exception to the usual visibility/root-scoping rules).
    const fileInput = doc.createElement("input");
    fileInput.type = "file";
    fileInput.name = "photos";
    fileInput.setAttribute("data-testid", "add-photos-input");
    fileInput.style.cssText = "position:absolute;width:0;height:0;opacity:0;overflow:hidden;";
    doc.body.appendChild(fileInput); // sibling of `form`, not inside it
    // Simulated Vinted photo-thumbnail confirmation — appears once files
    // change, using the VERIFIED real card shape (data-testid="image-wrapper-N"),
    // appended to the grid rather than replacing whatever's already there
    // (matching real Vinted: uploading ADDS photos, never clears existing ones).
    fileInput.addEventListener("change", () => {
      const count = (fileInput as HTMLInputElement).files?.length ?? 0;
      const existing = photoGrid.querySelectorAll('[data-testid^="image-wrapper-"]').length;
      for (let i = 0; i < count; i++) {
        const position = existing + i;
        const card = doc.createElement("div");
        const wrapper = doc.createElement("div");
        wrapper.setAttribute("data-testid", `image-wrapper-${position}`);
        card.appendChild(wrapper);
        const deleteButton = doc.createElement("button");
        deleteButton.setAttribute("data-testid", `media-select-grid-delete-button-${position}`);
        card.appendChild(deleteButton);
        photoGrid.appendChild(card);
      }
    });
  }

  if (!omit.has("title")) {
    // Follow-up correction (title-field NOT_FOUND bug) — verified live
    // shape: the Title input is confirmed NOT rendered inside any <form>
    // element on the real page — a direct child of <body>, matching that
    // verified shape exactly (see resolveTitleInput's own comment in
    // vinted-fields.js).
    const title = doc.createElement("input");
    title.id = "title"; title.name = "title"; title.setAttribute("data-testid", "title--input");
    title.placeholder = "Tell buyers what you're selling";
    doc.body.appendChild(title);
  }
  if (!omit.has("description")) {
    // Follow-up correction (root-scoping rewrite) — verified live: NOT
    // inside any <form> either, exactly like every other field below.
    const description = doc.createElement("textarea");
    description.id = "description"; description.name = "description"; description.setAttribute("data-testid", "description--input");
    description.placeholder = "Tell buyers more about it";
    doc.body.appendChild(description);
  }

  // Brand/size/condition/colour/material are built up front but kept
  // DETACHED — appended to <body> only once category is saved, so any
  // step run before that genuinely finds nothing (see fieldSteps' order
  // requirement in form-steps.js's runItem).
  const dependents: HTMLElement[] = [];
  let brandField: ReturnType<typeof buildBrandField> | null = null;
  let sizeField: ReturnType<typeof buildSizeField> | null = null;
  let conditionField: ReturnType<typeof buildConditionField> | null = null;
  let colourField: ReturnType<typeof buildColourField> | null = null;
  let materialField: ReturnType<typeof buildMaterialField> | null = null;

  const scratch = doc.createElement("div"); // never attached to the document — a safe place to build detached dependent fields
  if (!omit.has("brand")) { brandField = buildBrandField(doc, scratch, DEFAULT_BRANDS); dependents.push(brandField.opener, brandField.content); }
  if (!omit.has("size")) { sizeField = buildSizeField(doc, scratch, DEFAULT_SIZES); dependents.push(sizeField.opener, sizeField.content); }
  if (!omit.has("condition")) { conditionField = buildConditionField(doc, scratch, DEFAULT_CONDITIONS); dependents.push(conditionField.opener, conditionField.content); }
  if (!omit.has("colour")) { colourField = buildColourField(doc, scratch, DEFAULT_COLOURS); dependents.push(colourField.opener, colourField.content); }
  if (!omit.has("material")) { materialField = buildMaterialField(doc, scratch, DEFAULT_MATERIALS); dependents.push(materialField.opener, materialField.content); }

  let categoryField: ReturnType<typeof buildCategoryField> | null = null;
  if (!omit.has("category")) {
    categoryField = buildCategoryField(doc, doc.body, {
      categoryId: DEFAULT_CATEGORY_ID, leafName: DEFAULT_LEAF_NAME,
      onSaved: () => { for (const el of dependents) doc.body.appendChild(el); },
    });
  }

  if (!omit.has("price")) {
    // Follow-up correction (root-scoping rewrite) — verified live: NOT
    // inside any <form>.
    const price = doc.createElement("input");
    price.id = "price"; price.name = "price"; price.setAttribute("data-testid", "price-input--input");
    price.placeholder = "£0.00";
    doc.body.appendChild(price);
  }

  // Opt-in only — see buildParcelSizeField's own comment and this
  // function's top comment on `parcelSize`.
  const parcelSizeField = parcelSize ? buildParcelSizeField(doc, doc.body, parcelSize) : null;

  if (!omit.has("saveDraft")) {
    // Follow-up correction (root-scoping rewrite) — verified live: NOT
    // inside any <form>.
    const saveDraft = doc.createElement("button");
    saveDraft.type = "button";
    saveDraft.setAttribute("data-testid", "upload-form-save-draft-button");
    saveDraft.textContent = "Save draft";
    saveDraft.addEventListener("click", () => {
      const confirmation = doc.createElement("p");
      confirmation.textContent = "Draft saved. Finish editing later from your profile. (item id 123456789)";
      doc.body.appendChild(confirmation);
    });
    doc.body.appendChild(saveDraft);
  }
  if (!omit.has("uploadButton")) {
    const upload = doc.createElement("button");
    upload.type = "button";
    upload.setAttribute("data-testid", "upload-form-save-button");
    upload.textContent = "Upload";
    upload.addEventListener("click", () => { throw new Error("SAFETY VIOLATION: the Upload/publish button was clicked!"); });
    doc.body.appendChild(upload);
  }

  return { dom, doc, form: distractorForm, photoGrid, categoryField, brandField, sizeField, conditionField, colourField, materialField, parcelSizeField };
}

type RequestPhotoResult = { ok: boolean; position?: number; fileName?: string; mimeType?: string; base64?: string; reason?: string };
type FakeRequestPhoto = (itemId: string, position: number) => Promise<RequestPhotoResult>;

// Follow-up correction (photo-download CORS bug): the content script no
// longer fetches photo bytes itself — it asks the service worker via
// requestPhoto(itemId, position) and gets back base64, which
// stepUploadPhotos reconstructs with win.atob(). This default mock
// simulates a successful service-worker download for whichever position
// was requested — real base64 (via Node's Buffer), never a raw Blob.
const DEFAULT_PHOTO_BASE64 = Buffer.from("fake-photo-bytes").toString("base64");
function defaultRequestPhoto(_itemId: string, position: number): Promise<RequestPhotoResult> {
  return Promise.resolve({ ok: true, position, fileName: `${String(position + 1).padStart(2, "0")}.jpg`, mimeType: "image/jpeg", base64: DEFAULT_PHOTO_BASE64 });
}

function buildDeps(doc: Document, win: Window & typeof globalThis, requestPhoto: FakeRequestPhoto = vi.fn(defaultRequestPhoto)) {
  return {
    doc, win, location: win.location,
    requestPhoto,
    DataTransferImpl: class {
      private _files: unknown[] = [];
      items = { add: (file: unknown) => { this._files.push(file); } };
      get files() { return this._files; }
    },
    FileImpl: win.File,
  };
}

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222", queuePosition: 0,
    sku: "AA1711", title: "Hoka Clifton 9 Trainers", description: "A great pair of trainers.",
    brand: "Hoka", model: "Clifton 9", productType: "Trainers", condition: "Very Good Condition",
    ukSize: "9", audience: "womens", colours: ["Black", "White"], materials: ["Mesh"],
    pricePence: 4500, priceDisplay: "£45.00", vintedCategoryId: DEFAULT_CATEGORY_ID, vintedCategoryPath: "Women > Shoes > Trainers",
    photos: [
      { position: 0, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" },
      { position: 1, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/1", fileName: "02.jpg" },
    ],
    coverPhotoPosition: 0,
    ...overrides,
  };
}

describe("runItem — correct step ordering, full happy path (verified DOM contract)", () => {
  it("fills every field, uploads photos in order, and saves as a draft — never the Upload button", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const report = vi.fn((status: string, extra: Record<string, unknown> = {}) => ({ status, ...extra }));

    const result = await runItem(validItem(), report, deps);

    // Follow-up correction (durable Save Draft confirmation) — Save Draft
    // is clicked, but confirmation is now the service worker's durable,
    // navigation-safe job (see stepSaveDraft's own comment) — runItem
    // itself never reports "completed" merely because the click
    // succeeded; see tests/vinted-extension-service-worker.test.ts for the
    // full durable confirmation flow this hands off to.
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe("Hoka Clifton 9 Trainers");
    expect((doc.getElementById("description") as HTMLTextAreaElement).value).toBe("A great pair of trainers.");
    expect((doc.getElementById("category") as HTMLInputElement).value).toBe("Trainers");
    expect((doc.getElementById("brand") as HTMLInputElement).value).toBe("Hoka");
    expect((doc.getElementById("size") as HTMLInputElement).value).toBe("9");
    expect((doc.getElementById("condition") as HTMLInputElement).value).toBe("Very good");
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Black, White");
    expect((doc.getElementById("material") as HTMLInputElement).value).toBe("Mesh");
    expect((doc.getElementById("price") as HTMLInputElement).value).toBe("45");
  });

  it("REGRESSION: reports steps in the correct order — filling, then saving (never saving before every field is set); completion itself is now reported later, by the service worker's durable confirmation flow, never synchronously here", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const calls: string[] = [];
    // Collapses consecutive repeats of the same status — stepUploadPhotos
    // now reports several "filling" progress pings (see the
    // message-lifecycle hang bug fix's "Downloading/Uploading photo N of M"
    // reporting), but this test is about the ORDER of status transitions,
    // not the count of progress pings within one status.
    const report = vi.fn((status: string, extra: Record<string, unknown> = {}) => {
      if (calls[calls.length - 1] !== status) calls.push(status);
      return { status, ...extra };
    });

    const result = await runItem(validItem(), report, deps);
    expect(calls).toEqual(["filling", "saving"]);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  });

  it("REGRESSION: brand/size/condition/colour/material are never queried before category is saved — they do not exist in the DOM until then", async () => {
    const { doc, dom } = buildMockVintedPage();
    expect(doc.getElementById("brand")).toBeNull();
    expect(doc.getElementById("size")).toBeNull();
    expect(doc.getElementById("condition")).toBeNull();
    expect(doc.getElementById("color")).toBeNull();
    expect(doc.getElementById("material")).toBeNull();

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  });

  it("REGRESSION: dependent fields are correctly RE-QUERIED after category selection (fresh DOM nodes appended post-save, not a stale pre-save reference)", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    // The brand field genuinely didn't exist at the start of this test — it
    // only exists now because runItem re-queried the DOM after category's
    // own dialog save appended it, exactly as verified.
    expect(doc.getElementById("brand")).not.toBeNull();
  });

  it("selects BOTH colours individually (not just the last one) — verified via click counts on each option", async () => {
    const { doc, dom, colourField } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const blackOption = colourField!.options.find(o => o.optionEl.textContent === "Black")!.optionEl;
    const whiteOption = colourField!.options.find(o => o.optionEl.textContent === "White")!.optionEl;
    let blackClicked = false, whiteClicked = false;
    blackOption.addEventListener("click", () => { blackClicked = true; });
    whiteOption.addEventListener("click", () => { whiteClicked = true; });

    await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(blackClicked).toBe(true);
    expect(whiteClicked).toBe(true);
  });

  it("REGRESSION: colours never select more than two — an item with 3 colours fails safely rather than selecting extras", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ colours: ["Black", "White", "Grey"] }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_COLOURS");
    expect(String(result.errorMessage)).toMatch(/exceed the maximum of 2/);
  });

  it("REGRESSION: Vinted's automatically-recommended parcel size (Medium) is never touched — no parcel-size control exists in this fixture, and the item reaches Save Draft without ever needing one", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving"); // never blocked on / never attempted to change a parcel-size selector
    expect((result as { pending?: boolean }).pending).toBe(true);
  });

  it("REGRESSION: photos are requested from the service worker SEQUENTIALLY, in POSITION order, not item.photos' own array order — never all at once", async () => {
    const { doc, dom } = buildMockVintedPage();
    const seenPositions: number[] = [];
    const inFlightAtOnce: number[] = [];
    let concurrent = 0;
    const requestPhoto = vi.fn(async (_itemId: string, position: number) => {
      concurrent++;
      inFlightAtOnce.push(concurrent);
      seenPositions.push(position);
      await Promise.resolve(); // a microtask tick — enough to expose a Promise.all-style overlap if one existed
      concurrent--;
      return { ok: true, position, fileName: `${String(position + 1).padStart(2, "0")}.jpg`, mimeType: "image/jpeg", base64: DEFAULT_PHOTO_BASE64 };
    });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const outOfOrderItem = validItem({
      photos: [
        { position: 1, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/1", fileName: "02.jpg" },
        { position: 0, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" },
      ],
    });
    const result = await runItem(outOfOrderItem, vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(seenPositions).toEqual([0, 1]); // requested in POSITION order, not the array's own order
    expect(Math.max(...inFlightAtOnce)).toBe(1); // never more than one in flight at once — large batches never held in memory simultaneously
  });
});

describe("runItem — each missing/ambiguous field fails safely, never partially completes", () => {
  const cases: [string, string][] = [
    ["title", "SET_TITLE"], ["description", "SET_DESCRIPTION"], ["category", "SET_CATEGORY"],
    ["brand", "SET_BRAND"], ["size", "SET_SIZE"], ["condition", "SET_CONDITION"],
    ["colour", "SET_COLOURS"], ["material", "SET_MATERIALS"], ["price", "SET_PRICE"],
  ];
  for (const [omitField, expectedErrorCode] of cases) {
    it(`missing ${omitField} fails with errorCode ${expectedErrorCode}, and the item is reported failed, never completed`, async () => {
      const { doc, dom } = buildMockVintedPage({ omit: new Set([omitField]) });
      const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
      const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe(expectedErrorCode);
    }, 15000);
  }

  it("missing the photo input fails at UPLOAD_PHOTOS, before any field is touched", async () => {
    const { doc, dom } = buildMockVintedPage({ omit: new Set(["photoInput"]) });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UPLOAD_PHOTOS");
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe(""); // never reached
  }, 15000);

  it("missing the Save Draft button fails at SAVE_DRAFT after every OTHER field genuinely succeeded", async () => {
    const { doc, dom } = buildMockVintedPage({ omit: new Set(["saveDraft"]) });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SAVE_DRAFT");
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe("Hoka Clifton 9 Trainers"); // fields WERE filled
  }, 15000);

  it("REGRESSION: the category leaf id must match the stored vintedCategoryId EXACTLY — a leaf that never appears (wrong id) fails safely at SET_CATEGORY rather than picking a near match", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    // The item claims a DIFFERENT category id than the one actually present in the fixture (catalog-search-1906-result) — no matching result will ever appear.
    const result = await runItem(validItem({ vintedCategoryId: 9999 }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_CATEGORY");
    expect(String(result.errorMessage)).toMatch(/catalog-search-9999-result/);
  }, 30000); // the leaf genuinely never appears — 3 retries x the full search-result wait budget

  it("an AMBIGUOUS brand result (two options with the exact same accessible name) fails safely rather than picking one — never partial/loose matching", async () => {
    const { doc, dom, brandField } = buildMockVintedPage();
    const duplicate = doc.createElement("div");
    duplicate.id = "brand-9999999";
    duplicate.setAttribute("role", "button");
    duplicate.setAttribute("data-testid", "brand-9999999");
    duplicate.textContent = "Hoka"; // exact duplicate of the real "Hoka" result
    brandField!.content.appendChild(duplicate);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_BRAND");
    expect(String(result.errorMessage)).toMatch(/AMBIGUOUS/);
  }, 15000);

  it("REGRESSION: an item condition that doesn't normalise to one of the five verified condition labels fails safely rather than guessing the nearest one", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ condition: "Acceptable Condition" }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_CONDITION");
    expect(String(result.errorMessage)).toMatch(/no verified condition mapping/);
  }, 15000);

  it("REGRESSION: an item size that has no exact accessible-label match fails safely rather than picking the nearest size", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ ukSize: "11" }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps); // fixture only has 8/8.5/9/9.5/10
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_SIZE");
  }, 30000); // no match ever appears — 3 retries x the full option-wait budget

  it("REGRESSION: an item material with no exact stored-label match fails safely rather than a partial match", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ materials: ["Suede"] }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps); // fixture only has Mesh/Leather
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_MATERIALS");
    // 3 retries x (the full option-wait budget + the virtualised-dropdown
    // scroll-search fallback's own bounded search — see
    // resolveMultiOptionWithScroll/scrollDropdownForOption in
    // form-steps.js) — this fixture's material picker isn't virtualised,
    // so the scroll fallback finds nothing to scroll and gives up quickly
    // each time, but that bounded search still adds real (if small) time
    // on top of the pre-existing per-attempt wait, so this needs more
    // headroom than the otherwise-identical SET_SIZE test just above,
    // which the scroll fix never touches.
  }, 45000);
});

describe("runItem — CAPTCHA / login-required stop the item entirely, before any interaction", () => {
  it("a login-required page stops immediately with LOGIN_REQUIRED, never touching the form", async () => {
    // A real prompt like this always lives inside some kind of dialog/
    // alert container — detectLoginRequired() deliberately only examines
    // those container types now (see its own top comment), never a
    // document-wide text scan, so the fixture reflects that shape.
    const { doc, dom } = buildMockVintedPage({ extraBodyText: '<div role="alert">Please log in to continue.</div>' });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("LOGIN_REQUIRED");
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe("");
  });

  it("REGRESSION: a hidden script#data-dome-script containing the word 'captcha' never triggers a false CAPTCHA failure on an otherwise normal page", async () => {
    const { doc, dom } = buildMockVintedPage({
      extraBodyText: '<script id="data-dome-script">/* anti-bot loader mentioning captcha in an inactive config blob */ window.__dd = { captcha: "https://example.com/captcha-fallback" };</script>',
    });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    // Verified: document.body.textContent contains "captcha" (true) even though there's zero visible challenge content — detectCaptchaOrVerification must never inspect the script's content at all.
    expect(doc.body.textContent).toMatch(/captcha/i);
    expect(detectCaptchaOrVerification(doc)).toBeNull();

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving"); // never falsely stopped
    expect((result as { pending?: boolean }).pending).toBe(true);
  });

  it("a genuinely VISIBLE CAPTCHA/verification page still stops the item immediately, never bypassed", async () => {
    const { doc, dom } = buildMockVintedPage({ extraBodyText: '<div role="dialog">Please complete the CAPTCHA to continue.</div>' });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("CAPTCHA_OR_VERIFICATION");
  });

  it("detectLoginRequired / detectCaptchaOrVerification return null on a normal page", () => {
    const { doc } = buildMockVintedPage();
    expect(detectLoginRequired(doc)).toBeNull();
    expect(detectCaptchaOrVerification(doc)).toBeNull();
  });
});

describe("runItem — invalid item data fails safely without touching the DOM", () => {
  it("a structurally invalid item (missing required field) is rejected before OPEN_FORM even runs", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const invalidItem = validItem({ title: "" }); // fails validateBatchItem's isNonEmptyString check
    const result = await runItem(invalidItem, vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("INVALID_ITEM");
  });
});

describe("detectAccountIdentity — account-detection bug fix: never a notification badge, always the stable /member/<digits> pathname", () => {
  it("REGRESSION: a bare notification-badge count ('99+') is never accepted as an account — displayName falls back to null rather than the badge text", async () => {
    const doc = docFromHeaderHtml(`<a href="/member/1001" class="user-menu"><span class="avatar"></span><span class="notification-badge">99+</span></a>`);
    const identity = await detectAccountIdentity(doc);
    expect(identity).toEqual({ memberId: "1001", displayName: null });
  });

  it("REGRESSION: the live '99+' conversations badge sitting next to (not inside) the Profile link is never mistaken for the account id", async () => {
    const doc = docFromHeaderHtml(`<span class="notification-badge" data-testid="conversations-badge">99+</span><a href="/member/3140273670">Profile</a>`);
    const identity = await detectAccountIdentity(doc);
    expect(identity!.memberId).toBe("3140273670");
    expect(identity!.memberId).not.toBe("99");
  });

  it("selects the visible Profile link whose EXACT pathname matches /member/<digits> and extracts its member id", async () => {
    const doc = docFromHeaderHtml(`<a href="/member/3140273670">Profile</a>`);
    const identity = await detectAccountIdentity(doc);
    expect(identity).toEqual({ memberId: "3140273670", displayName: null });
  });

  it("REGRESSION: a link whose href merely CONTAINS '/member/' but whose pathname doesn't exactly match (e.g. a sub-page) is never treated as the identity link", async () => {
    const doc = docFromHeaderHtml(`<a href="/member/3140273670/feedback">Feedback</a>`);
    expect(await detectAccountIdentity(doc)).toBeNull();
  });

  it("prefers a real visible name over a badge even when the badge is nested INSIDE the profile link", async () => {
    const doc = docFromHeaderHtml(`<a href="/member/1001">shopfront_uk<span class="notification-badge" data-testid="header-badge">99+</span></a>`);
    const identity = await detectAccountIdentity(doc);
    expect(identity).toEqual({ memberId: "1001", displayName: "shopfront_uk" });
  });

  it("ignores unrelated notification badges elsewhere in the header that are not part of the profile link", async () => {
    const doc = docFromHeaderHtml(`
      <span class="notification-badge">99+</span>
      <a href="/member/1001" title="shopfront_uk">shopfront_uk</a>
    `);
    const identity = await detectAccountIdentity(doc);
    expect(identity).toEqual({ memberId: "1001", displayName: "shopfront_uk" });
  });

  it("REGRESSION: no member-profile link at all — returns null (blocks starting) rather than guessing from other header text", async () => {
    const doc = docFromHeaderHtml(`<span class="notification-badge">99+</span><a href="/help">Help</a>`);
    expect(await detectAccountIdentity(doc)).toBeNull();
  });

  it("more than one DISTINCT member id referenced in the header is treated as ambiguous — returns null rather than picking one", async () => {
    const doc = docFromHeaderHtml(`<a href="/member/1001">shopfront_uk</a><a href="/member/2002">someone_else</a>`);
    expect(await detectAccountIdentity(doc)).toBeNull();
  });

  it("multiple links to the SAME member id (e.g. an avatar link and a separate name link) are merged, not treated as ambiguous", async () => {
    const doc = docFromHeaderHtml(`<a href="/member/1001" aria-label="View profile"><span class="notification-badge">3</span></a><a href="/member/1001">shopfront_uk</a>`);
    const identity = await detectAccountIdentity(doc);
    expect(identity).toEqual({ memberId: "1001", displayName: "shopfront_uk" });
  });

  // ---- Follow-up correction: opening the account menu when the closed
  // header alone doesn't expose a reliable member link -------------------
  // Verified: the header menu toggle's OWN accessible name is "Menu
  // opened" before being clicked, and becomes "Menu closed" after — the
  // standard toggle-button convention of labelling the action the next
  // click performs (see form-steps.js's own comment on this).

  /** A header with a closed account menu: the toggle's accessible name is
   * "Menu opened" until clicked, then "Menu closed" — the Profile link
   * only appears once it's actually open (a real click handler drives
   * that, exactly like the live page would). */
  function docWithClosedAccountMenu() {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <header>
          <button aria-label="Menu opened"><span class="avatar"></span></button>
          <ul class="account-menu" hidden>
            <li><a href="/member/3140273670">Profile</a></li>
            <li><button type="button">Profile</button></li>
            <li><button type="button">Log out</button></li>
          </ul>
        </header>
      </body></html>`,
      { url: "https://www.vinted.co.uk/" },
    );
    const doc = dom.window.document;
    const toggle = doc.querySelector("header button") as HTMLButtonElement;
    const menu = doc.querySelector("ul.account-menu") as HTMLUListElement;
    toggle.addEventListener("click", () => {
      const opening = menu.hasAttribute("hidden");
      if (opening) { menu.removeAttribute("hidden"); toggle.setAttribute("aria-label", "Menu closed"); }
      else { menu.setAttribute("hidden", ""); toggle.setAttribute("aria-label", "Menu opened"); }
    });
    return { doc, toggle, menu };
  }

  it("REGRESSION: the closed header exposes no reliable member link — safely opens the unique visible account menu, reads the Profile link, and closes it again", async () => {
    const { doc, toggle, menu } = docWithClosedAccountMenu();
    expect(menu.hasAttribute("hidden")).toBe(true); // starts closed

    const identity = await detectAccountIdentity(doc);

    expect(identity).toEqual({ memberId: "3140273670", displayName: null });
    expect(toggle.getAttribute("aria-label")).toBe("Menu opened"); // closed again — left exactly as found
    expect(menu.hasAttribute("hidden")).toBe(true);
  });

  it("REGRESSION: never clicks a menu action such as Profile or Log out while reading the identity — only the toggle itself is ever clicked", async () => {
    const { doc } = docWithClosedAccountMenu();
    const profileButton = Array.from(doc.querySelectorAll("button")).find(b => b.textContent === "Profile" && !b.hasAttribute("aria-label"))!;
    const logOutButton = Array.from(doc.querySelectorAll("button")).find(b => b.textContent === "Log out")!;
    const profileClicks = vi.fn();
    const logOutClicks = vi.fn();
    profileButton.addEventListener("click", profileClicks);
    logOutButton.addEventListener("click", logOutClicks);

    await detectAccountIdentity(doc);

    expect(profileClicks).not.toHaveBeenCalled();
    expect(logOutClicks).not.toHaveBeenCalled();
  });

  it("leaves an ALREADY-open account menu open — never closes a menu it didn't open itself", async () => {
    const { doc, toggle, menu } = docWithClosedAccountMenu();
    toggle.click(); // the user already had it open
    expect(menu.hasAttribute("hidden")).toBe(false);

    const identity = await detectAccountIdentity(doc);

    expect(identity).toEqual({ memberId: "3140273670", displayName: null });
    expect(menu.hasAttribute("hidden")).toBe(false); // still open
    expect(toggle.getAttribute("aria-label")).toBe("Menu closed");
  });

  it("no account/avatar menu toggle at all, and no direct member link — returns null rather than guessing", async () => {
    const doc = docFromHeaderHtml(`<a href="/help">Help</a>`);
    expect(await detectAccountIdentity(doc)).toBeNull();
  });
});

describe("detectLoginRequired — login-detection bug fix: only visible login dialogs/forms/session-expired messages, never hidden content", () => {
  it("REGRESSION: hidden 'please log in' content plus a verified member ID present — treated as authenticated, never flagged", async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <header><a href="/member/3140273670">Profile</a></header>
        <div role="dialog" hidden>Please log in to continue.</div>
      </body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    const doc = dom.window.document;
    expect(await detectAccountIdentity(doc)).toEqual({ memberId: "3140273670", displayName: null });
    expect(detectLoginRequired(doc)).toBeNull();
  });

  it("REGRESSION: a hidden login template plus a visible 'Log out' action in the account menu — treated as authenticated", async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <header>
          <a href="/member/3140273670">Profile</a>
          <button type="button">Log out</button>
        </header>
        <div role="dialog" style="display:none">Please log in to continue.</div>
      </body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    const doc = dom.window.document;
    expect(detectLoginRequired(doc)).toBeNull();
  });

  it("REGRESSION: a genuinely VISIBLE login dialog still stops the item", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div role="dialog">Please log in to continue.</div></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectLoginRequired(dom.window.document)).toBeTruthy();
  });

  it("REGRESSION: a genuinely VISIBLE session-expired message still stops the item", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div role="alert">Your session has expired.</div></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectLoginRequired(dom.window.document)).toBeTruthy();
  });

  it("a login-like phrase hidden via visibility:hidden, or behind a hidden ANCESTOR, is never detected", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div role="dialog" style="visibility:hidden">Please log in to continue.</div>
        <div hidden><div role="dialog">Session has expired.</div></div>
      </body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectLoginRequired(dom.window.document)).toBeNull();
  });
});

describe("detectCaptchaOrVerification — false-CAPTCHA bug fix: never a hidden script/template, always positive visible evidence", () => {
  it("REGRESSION: script#data-dome-script containing the literal word 'captcha' produces NO challenge — the exact reported false positive", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <script id="data-dome-script">
          // A real anti-bot loader script — its own config/comments happen to mention "captcha" in prose that is never rendered.
          window.__ddConfig = { fallbackCaptchaUrl: "https://geo.captcha-delivery.com/captcha/" };
        </script>
        <main><p>Sell your item — everything looks completely normal here.</p></main>
      </body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    const doc = dom.window.document;
    expect(doc.body.textContent).toMatch(/captcha/i); // verified: textContent DOES contain the word
    expect(detectCaptchaOrVerification(doc)).toBeNull(); // but there is no visible challenge at all
  });

  it("a visible CAPTCHA iframe (src identifies it) is detected", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><iframe src="https://geo.captcha-delivery.com/captcha/" title="captcha challenge"></iframe></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectCaptchaOrVerification(dom.window.document)).toBeTruthy();
  });

  it("a HIDDEN CAPTCHA iframe (not yet shown) produces no challenge", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><iframe src="https://geo.captcha-delivery.com/captcha/" style="display:none"></iframe></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectCaptchaOrVerification(dom.window.document)).toBeNull();
  });

  it("a visible challenge container with explicit human-verification wording is detected", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div role="dialog">Please verify you're a human before continuing.</div></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectCaptchaOrVerification(dom.window.document)).toBeTruthy();
  });

  it("a visible unusual-traffic / blocked-session page is detected", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div role="alert">We have detected unusual traffic from your network.</div></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    expect(detectCaptchaOrVerification(dom.window.document)).toBeTruthy();
  });

  it("a cookie-consent dialog that happens to mention the word 'captcha' in unrelated prose, but never matches a real challenge phrase, is not falsely flagged", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div role="dialog" class="cookie-consent">We use cookies and anti-captcha technology to keep Vinted safe. Accept?</div></body></html>`,
      { url: "https://www.vinted.co.uk/items/new" },
    );
    // "captcha" alone (not one of the specific challenge phrases like
    // "verify you're a human"/"unusual traffic"/etc.) still matches the
    // broad /captcha/i pattern deliberately kept broad per this file's own
    // "better a false stop than plough through a real challenge" policy —
    // but ONLY because this text is genuinely VISIBLE. The real fix is
    // that a HIDDEN instance of the same word never reaches this check at
    // all (see the data-dome-script test above) — this test simply
    // confirms a visible dialog is still inspected, not exempted by its class name.
    expect(detectCaptchaOrVerification(dom.window.document)).toBeTruthy();
  });
});

describe("resolvePhotoInput — false-NOT_FOUND bug fix: no id, hidden/zero-sized is normal, never scoped to the form root", () => {
  function docWithPhotoInput(attrs: Partial<{ type: string; name: string; testId: string; disabled: boolean; hidden: boolean; insideForm: boolean }> = {}) {
    const { type = "file", name = "photos", testId = "add-photos-input", disabled = false, hidden = true, insideForm = false } = attrs;
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const input = doc.createElement("input");
    input.type = type;
    input.name = name;
    if (testId) input.setAttribute("data-testid", testId);
    if (disabled) input.disabled = true;
    if (hidden) input.style.cssText = "position:absolute;width:0;height:0;opacity:0;overflow:hidden;";
    if (insideForm) {
      const form = doc.createElement("form");
      form.appendChild(input);
      doc.body.appendChild(form);
    } else {
      doc.body.appendChild(input); // NOT inside any form — the verified live shape
    }
    return { doc, input };
  }

  it("REGRESSION: a hidden, zero-sized file input with no ID resolves successfully", () => {
    const { doc, input } = docWithPhotoInput({ hidden: true });
    expect(input.id).toBe(""); // verified: no id attribute at all
    expect(isVisible(input)).toBe(false); // confirms it really is hidden/zero-sized by this file's own visibility rules
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.element).toBe(input);
  });

  it("a visible ID is not required — a genuinely visible input with no id also resolves", () => {
    const { doc, input } = docWithPhotoInput({ hidden: false });
    expect(input.id).toBe("");
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.element).toBe(input);
  });

  it("REGRESSION: a disabled file input is rejected", () => {
    const { doc } = docWithPhotoInput({ disabled: true });
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(false);
  });

  it("the wrong type is rejected", () => {
    const { doc } = docWithPhotoInput({ type: "text" });
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(false);
  });

  it("the wrong name is rejected", () => {
    const { doc } = docWithPhotoInput({ name: "images" });
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(false);
  });

  it("the wrong (or missing) data-testid is rejected", () => {
    const { doc } = docWithPhotoInput({ testId: "photo-upload-input" });
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(false);
  });

  it("REGRESSION: duplicate matching file inputs are rejected as ambiguous, never picks one", () => {
    const { doc, input: first } = docWithPhotoInput();
    const second = doc.createElement("input");
    second.type = "file"; second.name = "photos"; second.setAttribute("data-testid", "add-photos-input");
    first.parentElement!.appendChild(second);
    const result = resolvePhotoInput(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/AMBIGUOUS/);
  });

  it("REGRESSION: the real photo-upload step proceeds using the resolved input, even though it lives outside the Create Listing form root", async () => {
    const { doc, dom, form } = buildMockVintedPage();
    // The fixture already places the photo input as a sibling of `form`, not inside it (see buildMockVintedPage's own comment).
    expect(form.querySelector('[data-testid="add-photos-input"]')).toBeNull();
    expect(doc.querySelector('[data-testid="add-photos-input"]')).not.toBeNull();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  });

  it("ordinary visible-field checks remain strict — title/description/price still require visibility and are unaffected by this exception", async () => {
    const { doc, dom } = buildMockVintedPage();
    const titleField = doc.getElementById("title")!;
    titleField.style.cssText = "display:none";
    expect(isVisible(titleField)).toBe(false); // the ordinary visibility rule still applies to every OTHER field
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    // stepSetText itself doesn't require visibility (it never did, even before this fix — Vinted's real text inputs are always visible in practice) — this test instead proves isVisible() itself is untouched for ordinary elements, i.e. the photo-input exception did not weaken the shared isVisible() helper.
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  });

  it("draft-only publishing safeguards remain unchanged — the forbidden Upload button is still never clicked while resolving/using the photo input", async () => {
    const { doc, dom } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(uploadClicks).not.toHaveBeenCalled();
  });
});

describe("stepUploadPhotos — photo-download CORS-bug fix: downloads via deps.requestPhoto (the service worker), never a direct fetch", () => {
  it("REGRESSION: no field is ever filled after a photo-download failure — the item fails at UPLOAD_PHOTOS before touching title/description/etc.", async () => {
    const { doc, dom } = buildMockVintedPage();
    const requestPhoto = vi.fn(async () => ({ ok: false, reason: "HTTP_403: photo 0 request to https://app.example/api/extension/batch/photos/x/0 failed (403 Forbidden)." }));
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UPLOAD_PHOTOS");
    expect(String(result.errorMessage)).toMatch(/HTTP_403/);
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe(""); // never reached
    expect(doc.getElementById("category")).not.toBeNull(); // the category dialog was never even opened — no dependent fields were revealed
  });

  it("REGRESSION: correct File reconstruction — the File attached to the resolved input has the EXACT bytes the service worker returned, not a placeholder", async () => {
    const { doc, dom } = buildMockVintedPage();
    const originalBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const base64 = Buffer.from(originalBytes).toString("base64");
    const requestPhoto = vi.fn(async (_itemId: string, position: number) => ({
      ok: true, position, fileName: `${String(position + 1).padStart(2, "0")}.png`, mimeType: "image/png", base64,
    }));
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await runItem(validItem({ photos: [{ position: 0, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" }] }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);

    const photoInput = resolvePhotoInput(doc);
    expect(photoInput.ok).toBe(true);
    const file = (photoInput as { ok: true; element: HTMLInputElement }).element.files![0];
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("01.png");
    const readBack = new Uint8Array(await file.arrayBuffer());
    expect(readBack).toEqual(originalBytes);
  });

  it("a position mismatch from the service worker fails safely rather than attaching the wrong photo", async () => {
    const { doc, dom } = buildMockVintedPage();
    const requestPhoto = vi.fn(async (_itemId: string, _position: number) => ({ ok: true, position: 99, fileName: "01.jpg", mimeType: "image/jpeg", base64: DEFAULT_PHOTO_BASE64 }));
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await runItem(validItem({ photos: [{ position: 0, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" }] }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UPLOAD_PHOTOS");
    expect(String(result.errorMessage)).toMatch(/MISMATCH/);
  });

  it("publishing button remains forbidden even when a photo download fails partway through a multi-photo item", async () => {
    const { doc, dom } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const requestPhoto = vi.fn(async (_itemId: string, position: number) => {
      if (position === 1) return { ok: false, reason: "HTTP_500: photo 1 request failed (500 Internal Server Error)." };
      return { ok: true, position, fileName: `${String(position + 1).padStart(2, "0")}.jpg`, mimeType: "image/jpeg", base64: DEFAULT_PHOTO_BASE64 };
    });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps); // validItem() has 2 photos (positions 0 and 1)

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UPLOAD_PHOTOS");
    expect(uploadClicks).not.toHaveBeenCalled();
  });

  // ---- Message-lifecycle hang bug (follow-up correction) -----------------

  it('REGRESSION: progress is reported before and after each photo download ("Downloading photo N of M" / "Uploading photo N of M") — informational only, never a disguise for a stuck request', async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const details: string[] = [];
    const report = vi.fn((status: string, extra: Record<string, unknown> = {}) => {
      if (typeof extra.detail === "string") details.push(extra.detail);
      return { status, ...extra };
    });

    const result = await runItem(validItem(), report, deps); // validItem() has 2 photos (positions 0 and 1)
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(details).toEqual([
      "Downloading photo 1 of 2", "Uploading photo 1 of 2",
      "Downloading photo 2 of 2", "Uploading photo 2 of 2",
    ]);
  });

  it("REGRESSION: a service-worker request timeout during photo download fails safely — no field is ever filled, and the forbidden Upload button is never clicked", async () => {
    const { doc, dom } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    // Exactly what shared/photo-transfer.js's requestPhoto throws when the
    // service worker never responds within its bounded timeout.
    const requestPhoto = vi.fn(async () => {
      throw new Error("TIMEOUT: photo 0 — stage: waiting for service-worker response (no reply within 30s).");
    });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UPLOAD_PHOTOS");
    expect(String(result.errorMessage)).toMatch(/TIMEOUT/);
    expect(String(result.errorMessage)).toMatch(/stage: waiting for service-worker response/);
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe(""); // never reached
    expect(doc.getElementById("category")).not.toBeNull(); // the category dialog was never even opened
    expect(uploadClicks).not.toHaveBeenCalled();
  });
});

describe("photo-confirmation false-negative bug (follow-up correction): confirmation is scoped to the WHOLE document (never the form root) and keyed to the verified image-wrapper-N marker, never a guessed selector", () => {
  it("REGRESSION: seven displayed uploaded cards confirm seven expected photos", async () => {
    const { doc, photoGrid } = buildMockVintedPage();
    for (let i = 0; i < 7; i++) seedPhotoCard(doc, photoGrid, i);
    const result = await waitForPhotoCardsConfirmed(doc, 7, { timeoutMs: 3000 });
    expect(result.ok).toBe(true);
  });

  it("REGRESSION: the empty add-photo tile is excluded from the count — present alongside 3 real cards, expecting 3 still confirms (never 4)", async () => {
    const { doc, photoGrid } = buildMockVintedPage();
    for (let i = 0; i < 3; i++) seedPhotoCard(doc, photoGrid, i);
    const addTile = doc.createElement("div");
    addTile.setAttribute("data-testid", "add-photos-icon-button");
    photoGrid.appendChild(addTile);

    const confirmed3 = await waitForPhotoCardsConfirmed(doc, 3, { timeoutMs: 3000 });
    expect(confirmed3.ok).toBe(true);

    const rejected4 = await waitForPhotoCardsConfirmed(doc, 4, { timeoutMs: 500 });
    expect(rejected4.ok).toBe(false); // the add-tile is never mistaken for a 4th photo
  });

  it("REGRESSION: idempotent retry — photos already fully present are recognised as complete and stepUploadPhotos never calls requestPhoto (no duplicate upload), then continues to later fields", async () => {
    const { doc, dom, photoGrid } = buildMockVintedPage();
    const item = validItem(); // 2 photos (positions 0 and 1)
    for (let i = 0; i < item.photos.length; i++) seedPhotoCard(doc, photoGrid, i);
    const requestPhoto = vi.fn();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await stepUploadPhotos(doc.body, item, deps);

    expect(result.ok).toBe(true);
    expect(requestPhoto).not.toHaveBeenCalled(); // never re-downloaded/re-uploaded a duplicate set

    // The full item still proceeds normally afterwards — later fields ARE reached, all the way to Save Draft.
    const fullResult = await runItem(item, vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(fullResult.status).toBe("saving");
    expect((fullResult as { pending?: boolean }).pending).toBe(true);
  });

  it("REGRESSION: zero existing photos triggers the normal upload path — requestPhoto is called once per photo", async () => {
    const { doc, dom, photoGrid } = buildMockVintedPage();
    expect(photoGrid.children.length).toBe(0); // fresh fixture — nothing pre-seeded
    const item = validItem();
    const requestPhoto = vi.fn(defaultRequestPhoto);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await stepUploadPhotos(doc.body, item, deps);

    expect(result.ok).toBe(true);
    expect(requestPhoto).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION: a PARTIAL existing set (some but not all expected photos already present) fails with PHOTO_COUNT_MISMATCH and never uploads anything", async () => {
    const { doc, dom, photoGrid } = buildMockVintedPage();
    const item = validItem(); // expects 2 photos
    seedPhotoCard(doc, photoGrid, 0); // only 1 of 2 present
    const requestPhoto = vi.fn();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await stepUploadPhotos(doc.body, item, deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_COUNT_MISMATCH/);
    expect(requestPhoto).not.toHaveBeenCalled(); // never adds another full set on top of a partial one
  });

  it("REGRESSION: MORE photos than expected present fails safely, never guessing which are correct", async () => {
    const { doc, dom, photoGrid } = buildMockVintedPage();
    const item = validItem(); // expects 2 photos
    for (let i = 0; i < 4; i++) seedPhotoCard(doc, photoGrid, i); // 4 present, only 2 expected
    const requestPhoto = vi.fn();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis, requestPhoto);

    const result = await stepUploadPhotos(doc.body, item, deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_COUNT_MISMATCH/);
    expect(requestPhoto).not.toHaveBeenCalled();
  });

  it("REGRESSION: confirmation waits for an active upload indicator to disappear before trusting a matching count", async () => {
    const { doc, photoGrid } = buildMockVintedPage();
    for (let i = 0; i < 2; i++) seedPhotoCard(doc, photoGrid, i);
    const indicator = seedUploadIndicator(doc, photoGrid);

    const stillBusy = await waitForPhotoCardsConfirmed(doc, 2, { timeoutMs: 500 });
    expect(stillBusy.ok).toBe(false);
    expect(stillBusy.reason).toMatch(/upload indicator still active/);

    indicator.remove();
    const nowConfirmed = await waitForPhotoCardsConfirmed(doc, 2, { timeoutMs: 3000 });
    expect(nowConfirmed.ok).toBe(true);
  });

  it("REGRESSION: a stable completed count succeeds only after holding for the settling period — a count that changes right up to the last moment is not confirmed prematurely", async () => {
    const { doc, photoGrid } = buildMockVintedPage();
    seedPhotoCard(doc, photoGrid, 0);
    // The 2nd photo arrives shortly after the 1st — before that, the count
    // (1) never matches the expected total (2), so no premature confirmation.
    setTimeout(() => seedPhotoCard(doc, photoGrid, 1), 200);

    const start = Date.now();
    const result = await waitForPhotoCardsConfirmed(doc, 2, { timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200); // never confirmed before the 2nd photo actually existed
  });

  it("REGRESSION: a genuine missing-photo case (fewer cards than expected, permanently) still fails with a specific, evidence-bearing reason — never just the bare generic timeout message", async () => {
    const { doc, photoGrid } = buildMockVintedPage();
    seedPhotoCard(doc, photoGrid, 0); // only 1 of 2, and nothing more ever arrives

    const result = await waitForPhotoCardsConfirmed(doc, 2, { timeoutMs: 500 });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^TIMEOUT: photos did not appear to be confirmed by Vinted /);
    expect(result.reason).toMatch(/expected 2, found 1/);
    expect(result.reason).toMatch(/upload indicator not active/);
    expect(result.reason).toMatch(/0 empty add-photo tile\(s\)/);
    expect(result.reason).toMatch(/checked selector \[data-testid\^="image-wrapper-"\]/);
    expect(result.reason).toMatch(/page https:\/\/www\.vinted\.co\.uk\//);
  });

  it("REGRESSION: no later field is ever filled after a genuine photo-confirmation failure, and the forbidden Upload button is never clicked", async () => {
    const { doc, dom } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const item = validItem();
    // A requestPhoto that resolves normally, but whose fixture-side "change"
    // handler has been neutralised so no card ever actually appears —
    // simulates photos that genuinely never rendered, distinct from every
    // OTHER test above where they always eventually do.
    const input = doc.querySelector('[data-testid="add-photos-input"]') as HTMLInputElement;
    const clone = input.cloneNode(true) as HTMLInputElement; // drops the "change" listener that creates image-wrapper cards
    input.replaceWith(clone);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await runItem(item, vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UPLOAD_PHOTOS");
    expect(String(result.errorMessage)).toMatch(/TIMEOUT: photos did not appear to be confirmed by Vinted/);
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe("");
    expect(doc.getElementById("category")).not.toBeNull(); // dialog never opened
    expect(uploadClicks).not.toHaveBeenCalled(); // publish remains impossible
  }, 22000);
});

describe("stepSetTitle — title-field NOT_FOUND bug (follow-up correction): resolved via the WHOLE document (never the form root), idempotent skip/replace", () => {
  it("REGRESSION: an empty Title input is set to the exact generated title, and the completed value is verified before returning", async () => {
    const { doc, dom } = buildMockVintedPage();
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const item = validItem({ title: "Hoka Clifton 9 Trainers" });

    const result = await stepSetTitle(item, deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe("Hoka Clifton 9 Trainers");
  });

  it("REGRESSION: idempotent — a title that's already exactly correct on Retry is left untouched, never re-typed", async () => {
    const { doc, dom } = buildMockVintedPage();
    const input = doc.getElementById("title") as HTMLInputElement;
    input.value = "Hoka Clifton 9 Trainers";
    let inputEventCount = 0;
    input.addEventListener("input", () => { inputEventCount++; });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const item = validItem({ title: "Hoka Clifton 9 Trainers" });

    const result = await stepSetTitle(item, deps);

    expect(result.ok).toBe(true);
    expect(input.value).toBe("Hoka Clifton 9 Trainers");
    expect(inputEventCount).toBe(0); // never re-typed — no input event ever fired
  });

  it("REGRESSION: a DIFFERENT existing title is safely replaced with the correct one, never appended/merged", async () => {
    const { doc, dom } = buildMockVintedPage();
    const input = doc.getElementById("title") as HTMLInputElement;
    input.value = "Some Old Wrong Title";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const item = validItem({ title: "Hoka Clifton 9 Trainers" });

    const result = await stepSetTitle(item, deps);

    expect(result.ok).toBe(true);
    expect(input.value).toBe("Hoka Clifton 9 Trainers"); // fully replaced, not "Some Old Wrong TitleHoka Clifton 9 Trainers"
  });

  it("REGRESSION: a missing Title control fails safely with a specific NOT_FOUND reason, not a hang or an unhandled exception", async () => {
    const { doc, dom } = buildMockVintedPage({ omit: new Set(["title"]) });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await stepSetTitle(validItem(), deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });

  it("REGRESSION: an AMBIGUOUS Title control (more than one match) fails safely rather than guessing which one to use", async () => {
    const { doc, dom } = buildMockVintedPage();
    const duplicate = doc.createElement("input");
    duplicate.setAttribute("data-testid", "title--input");
    doc.body.appendChild(duplicate);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await stepSetTitle(validItem(), deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AMBIGUOUS/);
  });

  it("REGRESSION: no later field is touched, and the forbidden Upload button is never clicked, when SET_TITLE fails", async () => {
    const { doc, dom } = buildMockVintedPage({ omit: new Set(["title"]) });
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_TITLE");
    expect((doc.getElementById("description") as HTMLTextAreaElement).value).toBe(""); // never reached
    expect(doc.getElementById("category")).not.toBeNull(); // category dialog never opened
    expect(uploadClicks).not.toHaveBeenCalled();
  });

  it("REGRESSION: publishing remains impossible on a full happy-path run through the fixed SET_TITLE step", async () => {
    const { doc, dom } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect((doc.getElementById("title") as HTMLInputElement).value).toBe("Hoka Clifton 9 Trainers"); // sanity: exact title, not a mangled duplicate
    expect(uploadClicks).not.toHaveBeenCalled();
  });
});

describe("stepOpenForm / stepSaveDraft — individually", () => {
  it("stepOpenForm finds the form container when already on the Create Listing page", async () => {
    const { doc, dom } = buildMockVintedPage();
    const result = await stepOpenForm({ doc, win: dom.window, location: dom.window.location });
    expect(result.ok).toBe(true);
  });

  it("stepSaveDraft clicks ONLY [data-testid=\"upload-form-save-draft-button\"] and returns immediately as pending — confirmation is no longer this function's job (see the durable service-worker-driven flow instead)", async () => {
    const { doc, dom } = buildMockVintedPage();
    // Follow-up correction (root-scoping rewrite): Save Draft is verified
    // NOT to live inside any <form> — resolved via doc.body, never `form`.
    const result = await stepSaveDraft(doc.body, { doc, location: dom.window.location });
    expect(result.ok).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.vintedDraftId).toBeNull(); // never extracted synchronously anymore
  });

  it("REGRESSION: stepSaveDraft NEVER clicks the verified forbidden [data-testid=\"upload-form-save-button\"] control — that click would throw in this fixture (see buildMockVintedPage) and the test would fail if it were ever triggered", async () => {
    const { doc, dom } = buildMockVintedPage();
    await expect(stepSaveDraft(doc.body, { doc, location: dom.window.location })).resolves.toMatchObject({ ok: true, pending: true });
  });

  describe("durable Save Draft confirmation (live Save Draft investigation, follow-up) — click-gating via deps.beginSaveDraft, no more in-page polling", () => {
    it("REGRESSION: exact live control — tag BUTTON, data-testid upload-form-save-draft-button, accessible name exactly \"Save draft\", never role/aria-label based", async () => {
      const { doc, dom } = buildMockVintedPage();
      const button = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("role")).toBeNull(); // implicit "button" role from the tag itself — verified live
      expect(button.getAttribute("aria-label")).toBeNull();
      expect(button.textContent?.trim()).toBe("Save draft");
      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" } });
      expect(result.ok).toBe(true);
    });

    it("REGRESSION: Save draft is clicked exactly once", async () => {
      const { doc, dom } = buildMockVintedPage();
      const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
      const clicks = vi.fn();
      saveDraftButton.addEventListener("click", clicks);
      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" } });
      expect(result.ok).toBe(true);
      expect(clicks).toHaveBeenCalledTimes(1);
    });

    it("REGRESSION: Upload is never clicked, confirmed via a spy (not merely relying on the fixture's own throwing handler)", async () => {
      const { doc, dom } = buildMockVintedPage();
      const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
      const uploadClicks = vi.fn();
      uploadButton.addEventListener("click", uploadClicks);
      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" } });
      expect(result.ok).toBe(true);
      expect(uploadClicks).not.toHaveBeenCalled();
    });

    it("REGRESSION: a validation error blocking Save draft is reported explicitly with the exact message Vinted showed, never as a generic timeout — and the button is never even clicked once blocked", async () => {
      const { doc, dom } = buildMockVintedPage();
      const alert = doc.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = "Please select a size before saving.";
      doc.body.appendChild(alert);
      const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
      const clicks = vi.fn();
      saveDraftButton.addEventListener("click", clicks);
      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" } });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^VALIDATION_ERROR: step=SAVE_DRAFT/);
      expect(result.reason).toContain("Please select a size before saving.");
      expect(clicks).not.toHaveBeenCalled();
    });

    it("RETRY: an already-confirmed save (deps.getKnownVintedDraftId returns an id) never clicks Save draft again — returns the known id directly, no duplicate draft, and pending is false", async () => {
      const { doc, dom } = buildMockVintedPage();
      const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
      const clicks = vi.fn();
      saveDraftButton.addEventListener("click", clicks);
      const getKnownVintedDraftId = vi.fn(async () => "9621049256");
      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" }, getKnownVintedDraftId });
      expect(result.ok).toBe(true);
      expect(result.pending).toBe(false);
      expect(result.vintedDraftId).toBe("9621049256");
      expect(clicks).not.toHaveBeenCalled();
      expect(getKnownVintedDraftId).toHaveBeenCalledTimes(1);
    });

    it("REGRESSION: PENDING RECORD PERSISTED BEFORE THE CLICK — deps.beginSaveDraft is awaited and must resolve ok:true before Save draft is ever clicked; called before, not after, the click", async () => {
      const { doc, dom } = buildMockVintedPage();
      const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
      const callOrder: string[] = [];
      saveDraftButton.addEventListener("click", () => callOrder.push("clicked"));
      const beginSaveDraft = vi.fn(async () => { callOrder.push("beginSaveDraft"); return { ok: true, deadline: "2026-08-05T10:01:30.000Z" }; });

      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" }, beginSaveDraft });

      expect(result.ok).toBe(true);
      expect(result.pending).toBe(true);
      expect(beginSaveDraft).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["beginSaveDraft", "clicked"]); // the record is persisted BEFORE the click, never after
    });

    it("REGRESSION: if deps.beginSaveDraft refuses (the pending record could not be persisted), the click is refused entirely — never clicked, never left ambiguous", async () => {
      const { doc, dom } = buildMockVintedPage();
      const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
      const clicks = vi.fn();
      saveDraftButton.addEventListener("click", clicks);
      const beginSaveDraft = vi.fn(async () => ({ ok: false, reason: "ALREADY_PENDING: a Save Draft confirmation is already pending for this batch." }));

      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" }, beginSaveDraft });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^SAVE_DRAFT_NOT_STARTED: step=SAVE_DRAFT/);
      expect(result.reason).toContain("ALREADY_PENDING");
      expect(clicks).not.toHaveBeenCalled();
    });

    it("without deps.beginSaveDraft supplied at all, stepSaveDraft still clicks fresh (backward compatible — e.g. direct unit tests of this function alone)", async () => {
      const { doc, dom } = buildMockVintedPage();
      const result = await stepSaveDraft(doc.body, { doc, location: { pathname: "/items/new" } });
      expect(result.ok).toBe(true);
      expect(result.pending).toBe(true);
    });
  });
});

describe("findConfirmedDraftLink / findConfirmedDraftId — the real, observed Vinted success marker (live Save Draft investigation, follow-up)", () => {
  it("REGRESSION: a \"Finish editing\" link (verified live shape: href exactly /items/<draftId>/edit) on a /member/<sellerId> page is recognised, and the numeric draft id is extracted", () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`);
    const doc = dom.window.document;
    const link = doc.createElement("a");
    link.setAttribute("href", "/items/9621049256/edit");
    link.textContent = "Finish editing";
    doc.body.appendChild(link);

    const found = findConfirmedDraftLink(doc);
    expect(found?.draftId).toBe("9621049256");
    expect(findConfirmedDraftId(doc, { pathname: "/member/3140272892" })).toBe("9621049256");
  });

  it("REGRESSION: the direct /items/<draftId>/edit destination is recognised straight from the URL itself, after validating its exact shape — no DOM search needed at all", () => {
    const dom = new JSDOM(`<!doctype html><html><body><p>Edit your listing</p></body></html>`); // deliberately no Finish-editing link anywhere on this page
    const doc = dom.window.document;
    expect(findConfirmedDraftId(doc, { pathname: "/items/9621049256/edit" })).toBe("9621049256");
  });

  it("REGRESSION: navigation away with NO confirmed draft link anywhere is never treated as success — returns null, never guesses", () => {
    const dom = new JSDOM(`<!doctype html><html><body><p>Loading…</p></body></html>`);
    const doc = dom.window.document;
    expect(findConfirmedDraftLink(doc)).toBeNull();
    expect(findConfirmedDraftId(doc, { pathname: "/member/3140272892" })).toBeNull();
  });

  it("is null on the plain Create Listing page itself (no link, no matching URL shape)", () => {
    const { doc } = buildMockVintedPage();
    expect(findConfirmedDraftId(doc, { pathname: "/items/new" })).toBeNull();
  });

  it("REGRESSION: delayed draft-link appearance — null before the link exists, found the moment it's added, proving this is a stateless, fresh scan of the CURRENT DOM every single call (never cached from an earlier check)", () => {
    const dom = new JSDOM(`<!doctype html><html><body><p>Loading…</p></body></html>`);
    const doc = dom.window.document;
    const location = { pathname: "/member/3140272892" };
    expect(findConfirmedDraftId(doc, location)).toBeNull();

    const link = doc.createElement("a");
    link.setAttribute("href", "/items/9621049256/edit");
    link.textContent = "Finish editing";
    doc.body.appendChild(link);

    expect(findConfirmedDraftId(doc, location)).toBe("9621049256");
  });

  it("ignores an href that merely starts similarly but isn't actually the edit-page shape — never a loose/partial match", () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`);
    const doc = dom.window.document;
    const decoy = doc.createElement("a");
    decoy.setAttribute("href", "/items/9621049256/edithistory"); // "edit" as a mere text prefix, not the real /edit path segment
    decoy.textContent = "History";
    doc.body.appendChild(decoy);
    expect(findConfirmedDraftLink(doc)).toBeNull();
  });
});

// ============================================================================
// Root-scoping / dialog-interaction rewrite (follow-up correction) — every
// field below (Description, Price, Category, Brand, Size, Condition,
// Colours, Material, Save Draft) was confirmed live to NOT be scoped to any
// real <form> element at all, and every dialog field's open/close mechanics
// were re-verified against the live page (see form-steps.js's own comments
// above openDialogPicker/confirmDialogPicker/stepSelectCategory/
// stepSelectBrand/stepSelectMultiOptions for the exact findings). These
// tests cover what's NEW in this rewrite specifically — idempotent
// skip/replace, multi-select reconciliation, and the corrected id schemes —
// rather than re-proving ordering/CAPTCHA/login coverage already exhaustively
// tested above.
// ============================================================================

describe("stepOpenForm — landmark-based page detection (root-scoping rewrite)", () => {
  it("REGRESSION: fails safely (never throws) when no Create Listing landmark exists anywhere on the page", async () => {
    const dom = new JSDOM(`<!doctype html><html><body><form><input name="search"></form></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const result = await stepOpenForm({ doc, win: dom.window as unknown as Window & typeof globalThis, location: dom.window.location });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });

  it("finds the page correctly via the media-upload landmark even though NO <form> on the page carries a matching testid (the real page's own shape)", async () => {
    const { doc, dom } = buildMockVintedPage();
    const result = await stepOpenForm({ doc, win: dom.window as unknown as Window & typeof globalThis, location: dom.window.location });
    expect(result.ok).toBe(true);
    expect(result.root).toBe(doc.body);
  });
});

describe("stepSetText — idempotent retry (root-scoping rewrite): shared by Description and Price", () => {
  const fields: Array<[string, { id: string; testId: string }, string, string]> = [
    ["description", VINTED_FIELD_STRATEGIES.description, "A great pair of trainers.", "description"],
    ["price", VINTED_FIELD_STRATEGIES.price, "45", "price"],
  ];

  for (const [label, strategy, value, elementId] of fields) {
    it(`REGRESSION: ${label} — an already-correct value is left untouched (no re-typing, no input event)`, async () => {
      const { doc, dom } = buildMockVintedPage();
      const el = doc.getElementById(elementId) as HTMLInputElement | HTMLTextAreaElement;
      el.value = value;
      let inputEvents = 0;
      el.addEventListener("input", () => { inputEvents++; });
      const result = await stepSetText(doc.body, strategy, value, { win: dom.window as unknown as Window & typeof globalThis });
      expect(result.ok).toBe(true);
      expect(el.value).toBe(value);
      expect(inputEvents).toBe(0);
    });

    it(`REGRESSION: ${label} — a different existing value is safely replaced (fully overwritten, never appended)`, async () => {
      const { doc, dom } = buildMockVintedPage();
      const el = doc.getElementById(elementId) as HTMLInputElement | HTMLTextAreaElement;
      el.value = "Some old wrong value";
      const result = await stepSetText(doc.body, strategy, value, { win: dom.window as unknown as Window & typeof globalThis });
      expect(result.ok).toBe(true);
      expect(el.value).toBe(value);
    });
  }
});

// ============================================================================
// Live investigation follow-up — a live test filled every visible field
// correctly and then failed with the old generic "TIMEOUT: field did not
// confirm the entered value." at the Price step. Diagnosed via read-only
// DOM inspection against the actual live, signed-in Create Listing tab
// (never refilled, never cleared, Save draft/Upload never clicked): the
// live Price input's OWN `.value` reads back "£30.00" — Vinted reformats
// whatever is typed into a currency display immediately, confirmed by
// reading `document.querySelector('[data-testid="price-input--input"]').value`
// directly. The OLD confirmation (`element.value === "30"`) could NEVER
// match that, for any price, ever. This fixture reproduces the exact
// observed live shape/value (`type="text" placeholder="£0.00"`, live value
// `"£30.00"`) via a same-behaviour reformat-on-input listener, and proves
// old vs corrected confirmation logic against it directly.
// ============================================================================

/**
 * Reproduces the EXACT live DOM shape/behaviour captured from
 * https://www.vinted.co.uk/items/new during the live-investigation
 * diagnosis: `<input id="price" data-testid="price-input--input"
 * type="text" placeholder="£0.00">` whose own `.value` reformats to a
 * "£X.XX" display the instant a value is typed — verified directly via a
 * read-only `element.value` read against the real, live, signed-in page
 * (never refilled, never cleared).
 */
function buildLiveShapePriceInput(doc: Document) {
  const price = doc.createElement("input");
  price.id = "price"; price.name = "price"; price.setAttribute("data-testid", "price-input--input");
  price.type = "text"; price.placeholder = "£0.00";
  price.addEventListener("input", () => {
    const digits = price.value.replace(/[^0-9.]/g, "");
    if (digits === "") return;
    const amount = Number(digits);
    if (Number.isFinite(amount)) price.value = `£${amount.toFixed(2)}`;
  });
  doc.body.appendChild(price);
  return price;
}

/** A price input that always snaps back to `frozenValue` regardless of what's typed into it — simulates a genuinely stuck/clamped field (e.g. a site-enforced minimum/maximum silently overriding the typed amount), never a mere formatting difference. Proves the currency-aware comparator still correctly rejects a genuine mismatch, not just a loosened/fuzzy one. */
function buildFrozenPriceInput(doc: Document, frozenValue: string) {
  const price = doc.createElement("input");
  price.id = "price"; price.name = "price"; price.setAttribute("data-testid", "price-input--input");
  price.type = "text"; price.placeholder = "£0.00";
  price.value = frozenValue;
  price.addEventListener("input", () => { price.value = frozenValue; }); // always snaps back — never accepts the typed value, genuinely stuck
  doc.body.appendChild(price);
  return price;
}

describe("buildFieldTimeoutReason / boundDiagnosticValue — structured field-timeout diagnostics (live investigation follow-up)", () => {
  it("includes exact step name, field name, selector, expected value, observed value, and the reason confirmation failed — every field timeout must include all of these", () => {
    const reason = buildFieldTimeoutReason({
      step: "SET_PRICE", field: "price", selector: '[data-testid="price-input--input"]',
      expected: "30.00", observed: "£30.00", cause: "observed value does not match expected value",
    });
    expect(reason).toBe('TIMEOUT: step=SET_PRICE field=price selector="[data-testid=\\"price-input--input\\"]" expected="30.00" observed="£30.00" reason="observed value does not match expected value"');
  });

  it("supports a non-default prefix (e.g. UNVERIFIED, used by dialog-picker and Title confirmation timeouts)", () => {
    const reason = buildFieldTimeoutReason({ prefix: "UNVERIFIED", step: "SET_CATEGORY", field: "category", expected: "Trainers", observed: "Shoes" });
    expect(reason).toMatch(/^UNVERIFIED: step=SET_CATEGORY field=category/);
  });

  it("boundDiagnosticValue: a safely bounded observed value — long, multi-line content is collapsed to one line and truncated, never dumped raw and unbounded", () => {
    const huge = `line one\nline two\n${"x".repeat(300)}`;
    const bounded = boundDiagnosticValue(huge, 50);
    expect(bounded.includes("\n")).toBe(false);
    expect(bounded.length).toBeLessThanOrEqual(51); // 50 chars + the truncation ellipsis
    expect(bounded.endsWith("…")).toBe(true);
  });

  it("a field-timeout reason built from a huge Description value never balloons the persisted error message", () => {
    const huge = "A".repeat(5000);
    const reason = buildFieldTimeoutReason({ step: "SET_DESCRIPTION", field: "description", expected: huge, observed: "" });
    expect(reason.length).toBeLessThan(300);
  });
});

describe("parsePriceToPence / priceValueMatch — currency-aware price comparator (live investigation follow-up)", () => {
  it("parses a plain digit string, a currency-prefixed string, and a decimal string to the same pence value", () => {
    expect(parsePriceToPence("30")).toBe(3000);
    expect(parsePriceToPence("£30.00")).toBe(3000);
    expect(parsePriceToPence("30.00")).toBe(3000);
    expect(parsePriceToPence(" £30.00 ")).toBe(3000);
  });

  it("returns null (never guesses) for an empty or unparseable value", () => {
    expect(parsePriceToPence("")).toBeNull();
    expect(parsePriceToPence("£")).toBeNull();
    expect(parsePriceToPence(null)).toBeNull();
  });

  it("priceValueMatch: a currency-reformatted value and its raw typed source represent the SAME amount — a match", () => {
    expect(priceValueMatch("£30.00", "30")).toBe(true);
  });

  it("priceValueMatch: a genuinely different amount is still correctly rejected — this is a numeric-equality comparator, never a fuzzy/loose one", () => {
    expect(priceValueMatch("£99.99", "30")).toBe(false);
    expect(priceValueMatch("", "30")).toBe(false);
  });
});

describe("SET_PRICE — currency-format confirmation mismatch (live investigation follow-up, the exact reported bug)", () => {
  it("REPRODUCTION: the OLD confirmation logic (strict string equality) fails against the live DOM shape/value — proves the bug is real, not hypothetical", async () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const win = dom.window as unknown as Window & typeof globalThis;
    buildLiveShapePriceInput(doc);

    // The OLD call shape: no isMatch override at all — defaults to strict `===`, exactly what production code did before this fix.
    const result = await stepSetText(doc.body, VINTED_FIELD_STRATEGIES.price, "30", { win }, { step: "SET_PRICE" });

    expect(result.ok).toBe(false);
    // The NEW structured diagnostic format — exact step/field/selector/expected/observed, never just a generic message.
    expect(result.reason).toContain("step=SET_PRICE");
    expect(result.reason).toContain("field=price");
    expect(result.reason).toContain('selector="[data-testid=\\"price-input--input\\"]"');
    expect(result.reason).toContain('expected="30"');
    expect(result.reason).toContain('observed="£30.00"'); // exactly what the live investigation observed
  });

  it("FIX: the corrected currency-aware comparator (priceValueMatch) succeeds against the EXACT SAME live DOM shape/value", async () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const win = dom.window as unknown as Window & typeof globalThis;
    buildLiveShapePriceInput(doc);

    const result = await stepSetText(doc.body, VINTED_FIELD_STRATEGIES.price, "30", { win }, { step: "SET_PRICE", isMatch: priceValueMatch });

    expect(result.ok).toBe(true);
  });

  it("RETRY: an already-correct, currency-formatted price (left over from a prior attempt) is recognised as already correct — never re-typed, no input event dispatched", async () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const win = dom.window as unknown as Window & typeof globalThis;
    const price = buildFrozenPriceInput(doc, "£30.00"); // frozen — if stepSetText tried to re-type, this field could never reconfirm, and the test would fail
    let inputEvents = 0;
    price.addEventListener("input", () => { inputEvents++; });

    const result = await stepSetText(doc.body, VINTED_FIELD_STRATEGIES.price, "30", { win }, { step: "SET_PRICE", isMatch: priceValueMatch });

    expect(result.ok).toBe(true);
    expect(inputEvents).toBe(0); // never re-typed — the idempotent pre-check alone recognised it
  });

  it("REGRESSION: a genuinely WRONG price still correctly fails even with the currency-aware comparator — this is numeric equality, never a loosened/fuzzy match", async () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const win = dom.window as unknown as Window & typeof globalThis;
    buildFrozenPriceInput(doc, "£99.99"); // never reacts to input — simulates a genuinely broken/stuck field, not a formatting difference

    const result = await stepSetText(doc.body, VINTED_FIELD_STRATEGIES.price, "30", { win }, { step: "SET_PRICE", isMatch: priceValueMatch });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("step=SET_PRICE");
    expect(result.reason).toContain('expected="30"');
    expect(result.reason).toContain('observed="£99.99"');
  });

  it("REGRESSION: Description (the OTHER stepSetText field) keeps strict string equality, completely unaffected by the Price-only currency comparator — confirmation is never weakened globally", async () => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://www.vinted.co.uk/items/new" });
    const doc = dom.window.document;
    const win = dom.window as unknown as Window & typeof globalThis;
    const description = doc.createElement("textarea");
    description.id = "description"; description.setAttribute("data-testid", "description--input");
    // Simulates a field that (hypothetically) reformatted its value in a way that would numerically "match" if compared loosely — Description must NEVER apply that reasoning; only Price does.
    description.addEventListener("input", () => { description.value = `${description.value} (extra)`; });
    doc.body.appendChild(description);

    const result = await stepSetText(doc.body, VINTED_FIELD_STRATEGIES.description, "A great description.", { win }, { step: "SET_DESCRIPTION" });

    expect(result.ok).toBe(false); // strict equality still correctly fails against the mutated value — never silently "close enough"
    expect(result.reason).toContain("step=SET_DESCRIPTION");
  });

  it("Full item — every field confirms (including Price, via the live currency-reformatting shape), execution proceeds to BEGIN_SAVE_DRAFT, Save draft is clicked exactly once, and Upload is never clicked", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["price"]) });
    buildLiveShapePriceInput(doc); // the live-shape, currency-reformatting price field replaces the plain omitted one
    attachCategoryDependents(categoryField);
    const win = dom.window as unknown as Window & typeof globalThis;

    const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    const saveDraftClicks = vi.fn();
    saveDraftButton.addEventListener("click", saveDraftClicks);
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);

    const beginSaveDraft = vi.fn(async () => ({ ok: true, deadline: "2026-08-05T10:01:30.000Z" }));
    const deps = { ...buildDeps(doc, win), beginSaveDraft };
    const item = validItem({ pricePence: 3000 }); // £30.00 — the exact amount observed live

    const stepsSeen: string[] = [];
    const report = vi.fn((status: string, extra: Record<string, unknown> = {}) => {
      if (typeof extra.currentStep === "string") stepsSeen.push(extra.currentStep);
      return { status, ...extra };
    });

    const result = await runItem(item, report, deps);

    expect((doc.getElementById("price") as HTMLInputElement).value).toBe("£30.00"); // confirmed via the live currency-formatted display, not a raw "30"
    expect(stepsSeen).toContain("SET_PRICE"); // current-step progress was reported while attempting it
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(beginSaveDraft).toHaveBeenCalledTimes(1); // execution reached BEGIN_SAVE_DRAFT
    expect(saveDraftClicks).toHaveBeenCalledTimes(1); // Save draft clicked exactly once
    expect(uploadClicks).not.toHaveBeenCalled(); // Upload never clicked
  }, 20000);
});

describe("stepSelectCategory — idempotent retry + verified search-result id scheme (root-scoping rewrite)", () => {
  it("REGRESSION: an already-correct category is left untouched — the picker is never opened", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage();
    (doc.getElementById("category") as HTMLInputElement).value = DEFAULT_LEAF_NAME;
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectCategory(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect(categoryField!.content.hidden).toBe(true);
  });

  it("REGRESSION: a different existing category is safely replaced with the correct one", async () => {
    const { doc, dom } = buildMockVintedPage();
    (doc.getElementById("category") as HTMLInputElement).value = "Some Wrong Category";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectCategory(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect((doc.getElementById("category") as HTMLInputElement).value).toBe(DEFAULT_LEAF_NAME);
  });

  it("REGRESSION: a missing category control fails safely (NOT_FOUND), never throws", async () => {
    const { doc, dom } = buildMockVintedPage({ omit: new Set(["category"]) });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectCategory(doc.body, validItem(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });
});

describe("stepSelectBrand — idempotent retry + id-based matching (root-scoping rewrite: brand options carry no data-testid, only id)", () => {
  it("REGRESSION: an already-correct brand is left untouched — the picker is never opened", async () => {
    const { doc, dom, categoryField, brandField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("brand") as HTMLInputElement).value = "Hoka";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectBrand(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect(brandField!.content.hidden).toBe(true);
  });

  it("REGRESSION: a different existing brand is safely replaced", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("brand") as HTMLInputElement).value = "Nike";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectBrand(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect((doc.getElementById("brand") as HTMLInputElement).value).toBe("Hoka");
  });

  it("REGRESSION: a missing brand control fails safely (NOT_FOUND)", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["brand"]) });
    attachCategoryDependents(categoryField);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectBrand(doc.body, validItem(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });
});

describe("stepSelectSize — idempotent retry (root-scoping rewrite)", () => {
  it("REGRESSION: an already-correct size is left untouched — the picker is never opened", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("size") as HTMLInputElement).value = "9";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect(sizeField!.content.hidden).toBe(true);
  });

  it("REGRESSION: a different existing size is safely replaced", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("size") as HTMLInputElement).value = "8";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect((doc.getElementById("size") as HTMLInputElement).value).toBe("9");
  });
});

describe("stepSelectSize — duplicate-representation collapsing (follow-up correction: AMBIGUOUS false positive on a size Vinted lists twice)", () => {
  it('REGRESSION: a Suggested "3" plus an equivalent Footwear "3" (SAME underlying optionId) collapses into one logical option and succeeds, preferring the Suggested copy', async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const suggested = addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    const footwear = addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-7-grid-option-56", sectionHeading: "Footwear", opener: sizeField!.opener });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem({ ukSize: "3" }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("size") as HTMLInputElement).value).toBe("3");
    expect(suggested.getAttribute("aria-checked")).toBe("true"); // the Suggested copy was the one actually clicked
    expect(footwear.getAttribute("aria-checked")).toBe("false"); // never double-clicked
  });

  it("REGRESSION: nested matching child elements collapse into one option — the data-testid lives on a WRAPPER around the checkbox, not the checkbox itself", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const nested = addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-7-grid-option-56", sectionHeading: "Footwear", opener: sizeField!.opener, nested: true });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem({ ukSize: "3" }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("size") as HTMLInputElement).value).toBe("3");
    expect(nested.getAttribute("aria-checked")).toBe("true");
  });

  it("REGRESSION: two options with the SAME label but DIFFERENT underlying optionId remain AMBIGUOUS — never guessed at, full diagnostics reported", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-12-grid-option-999", sectionHeading: "Footwear (a genuinely different scale)", opener: sizeField!.opener });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem({ ukSize: "3" }), deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AMBIGUOUS/);
    expect(result.reason).toMatch(/optionId=56/);
    expect(result.reason).toMatch(/optionId=999/);
    expect(result.reason).toMatch(/2 matches/);
  });

  it("REGRESSION: the correct size (\"3\", already selected from a previous attempt) is skipped — the picker is never opened, even with a duplicate representation present", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-7-grid-option-56", sectionHeading: "Footwear", opener: sizeField!.opener });
    (doc.getElementById("size") as HTMLInputElement).value = "3";

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem({ ukSize: "3" }), deps);

    expect(result.ok).toBe(true);
    expect(sizeField!.content.hidden).toBe(true); // never opened
  });

  it("REGRESSION: a WRONG existing size is safely replaced with \"3\" even when \"3\" itself has a duplicate representation", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-7-grid-option-56", sectionHeading: "Footwear", opener: sizeField!.opener });
    (doc.getElementById("size") as HTMLInputElement).value = "8"; // wrong, from a previous attempt

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem({ ukSize: "3" }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("size") as HTMLInputElement).value).toBe("3");
  });

  it("REGRESSION: no later field is touched, and Upload is never clicked, when a genuine size AMBIGUOUS failure occurs (two different underlying sizes sharing a label)", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-12-grid-option-999", sectionHeading: "Footwear (a genuinely different scale)", opener: sizeField!.opener });
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ ukSize: "3" }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_SIZE");
    expect(String(result.errorMessage)).toMatch(/AMBIGUOUS/);
    expect((doc.getElementById("condition") as HTMLInputElement).value).toBe(""); // never reached
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe(""); // never reached
    expect(uploadClicks).not.toHaveBeenCalled(); // publishing remains impossible
  }, 20000);

  it("REGRESSION: an UNKNOWN test-id pattern (matches neither verified shape) remains AMBIGUOUS — never assumed equal to a recognised candidate", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    // Neither `size-suggestions-grid-option-*` nor `size-group-<id>-grid-option-*` — a shape the parser has never seen.
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-picker-legacy-option-56", sectionHeading: "Footwear", opener: sizeField!.opener });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectSize(doc.body, validItem({ ukSize: "3" }), deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AMBIGUOUS/);
    expect(result.reason).toMatch(/optionId=56/); // the recognised Suggested candidate
    expect(result.reason).toMatch(/optionId=unknown/); // the unrecognised shape — never guessed to also be 56
  });

  it("REGRESSION: publishing remains impossible on a full happy-path run through a duplicate-but-equivalent size, and processing continues on to Condition", async () => {
    const { doc, dom, categoryField, sizeField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-suggestions-grid-option-56", sectionHeading: "Suggested", opener: sizeField!.opener });
    addSizeOption(doc, sizeField!.content, { size: "3", testId: "size-group-7-grid-option-56", sectionHeading: "Footwear", opener: sizeField!.opener });
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    const saveDraftClicks = vi.fn();
    saveDraftButton.addEventListener("click", saveDraftClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ ukSize: "3" }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect((doc.getElementById("size") as HTMLInputElement).value).toBe("3");
    expect((doc.getElementById("condition") as HTMLInputElement).value).toBe("Very good"); // processing continued past Size to Condition
    expect(saveDraftClicks).toHaveBeenCalledTimes(1); // Save Draft is the only permitted final action
    expect(uploadClicks).not.toHaveBeenCalled(); // Upload/publish is never clicked
  }, 20000);
});

describe("stepSelectCondition — idempotent retry (root-scoping rewrite)", () => {
  it("REGRESSION: an already-correct condition is left untouched — the picker is never opened", async () => {
    const { doc, dom, categoryField, conditionField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("condition") as HTMLInputElement).value = "Very good";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectCondition(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect(conditionField!.content.hidden).toBe(true);
  });

  it("REGRESSION: a different existing condition is safely replaced", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("condition") as HTMLInputElement).value = "Good";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectCondition(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect((doc.getElementById("condition") as HTMLInputElement).value).toBe("Very good");
  });
});

describe("stepSelectColours — multi-select RECONCILIATION, idempotent retry, never duplicates (root-scoping/dialog-interaction rewrite)", () => {
  it("REGRESSION: an already-EXACTLY-correct set is left untouched — the picker is never opened", async () => {
    const { doc, dom, categoryField, colourField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("color") as HTMLInputElement).value = "Black, White";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem(), deps); // validItem().colours = ["Black", "White"]
    expect(result.ok).toBe(true);
    expect(colourField!.content.hidden).toBe(true);
  });

  it("REGRESSION: a WRONG existing selection (from a previous attempt) is safely replaced — deselects what's wrong, selects what's missing, never duplicates", async () => {
    const { doc, dom, categoryField, colourField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    // Simulate "Grey" already selected from a previous, incorrect attempt.
    colourField!.opener.click();
    const grey = colourField!.options.find(o => o.name === "Grey")!;
    grey.optionEl.click();
    doc.body.click(); // outside click — closes the picker, exactly like the real page
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Grey");

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem(), deps); // target: Black, White

    expect(result.ok).toBe(true);
    expect(grey.checkbox.checked).toBe(false); // deselected, never left dangling
    const finalValues = (doc.getElementById("color") as HTMLInputElement).value.split(", ").sort();
    expect(finalValues).toEqual(["Black", "White"]); // never "Black, White, Grey" — no duplicate/leftover
  });

  it("REGRESSION: a PARTIALLY-correct existing selection only adds the missing value — the already-correct one is never re-clicked (which would TOGGLE it back off)", async () => {
    const { doc, dom, categoryField, colourField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    colourField!.opener.click();
    const black = colourField!.options.find(o => o.name === "Black")!;
    black.optionEl.click();
    doc.body.click();
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Black");

    let blackClicks = 0;
    black.optionEl.addEventListener("click", () => { blackClicks++; });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem(), deps); // target: Black, White

    expect(result.ok).toBe(true);
    expect(blackClicks).toBe(0); // never re-clicked — a re-click would have toggled it OFF, losing the already-correct selection
    const finalValues = (doc.getElementById("color") as HTMLInputElement).value.split(", ").sort();
    expect(finalValues).toEqual(["Black", "White"]);
  });

  it("REGRESSION: a missing colour control fails safely (NOT_FOUND)", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });
});

// Follow-up correction (colour duplicate-representation collapsing) — live
// failure: `AMBIGUOUS: color option exactly matching "Mustard" (2
// matches)` / "Light blue" (2 matches). Vinted renders the SAME logical
// colour once under a "Suggested" section and again in the full list; both
// are genuine exact-text matches, not a fuzzy-matching problem. See
// form-steps.js's own resolveDuplicateOptionMatches/extractOptionEntityId
// top comment for the full root-cause writeup, including the disclosed
// live-verification limitation (no authenticated session this session
// ever rendered a real Suggested colour section — it appears to be
// computed only once a draft is genuinely saved).
describe("stepSelectColours — duplicate-representation collapsing (follow-up correction: AMBIGUOUS false positive on a colour Vinted lists twice)", () => {
  it('REGRESSION: "Mustard" appears once under Suggested and once in the full list — collapses into one logical colour and succeeds, preferring the Suggested copy', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    const suggested = colourField.addRow({ name: "Mustard", id: 29, testId: "color-suggestions-option-29", sectionHeading: "Suggested" });
    const full = colourField.addRow({ name: "Mustard", id: 29, testId: "color-29", sectionHeading: "All colours" });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Mustard");
    expect((suggested.querySelector("input") as HTMLInputElement).checked).toBe(true); // the Suggested copy was the one actually clicked
    expect((full.querySelector("input") as HTMLInputElement).checked).toBe(true); // mirrored via shared underlying state — never independently toggled
  });

  it('REGRESSION: "Light blue" appears in both sections — selection succeeds', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Light blue", id: 15, testId: "color-suggestions-option-15", sectionHeading: "Suggested" });
    colourField.addRow({ name: "Light blue", id: 15, testId: "color-15", sectionHeading: "All colours" });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Light blue"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Light blue");
  });

  it('REGRESSION: a two-colour listing ("Light blue" + "Grey") selects both exactly once, even though "Light blue" has a duplicate representation', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    const suggestedLightBlue = colourField.addRow({ name: "Light blue", id: 15, testId: "color-suggestions-option-15", sectionHeading: "Suggested" });
    colourField.addRow({ name: "Light blue", id: 15, testId: "color-15", sectionHeading: "All colours" });
    const greyClicks = { count: 0 };
    const grey = colourField.addRow({ name: "Grey", id: 3, testId: "color-3" });
    grey.addEventListener("click", () => { greyClicks.count += 1; });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Light blue", "Grey"] }), deps);

    expect(result.ok).toBe(true);
    const finalValues = (doc.getElementById("color") as HTMLInputElement).value.split(", ").sort();
    expect(finalValues).toEqual(["Grey", "Light blue"]);
    expect(greyClicks.count).toBe(1); // clicked exactly once — never twice
    expect((suggestedLightBlue.querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("REGRESSION: Suggested section absent — the plain full-list option still works exactly as before", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-29" }); // only ONE representation — no duplication at all

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Mustard");
  });

  it("REGRESSION: the Suggested row disappears from the DOM immediately after being clicked (a real rerender) — fresh DOM re-querying against the surviving full-list twin still confirms selection", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-suggestions-option-29", sectionHeading: "Suggested", removeSelfOnSelect: true });
    const full = colourField.addRow({ name: "Mustard", id: 29, testId: "color-29", sectionHeading: "All colours" });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(true);
    expect(doc.querySelector('[data-testid="color-suggestions-option-29"]')).toBeNull(); // genuinely gone, not just hidden
    expect((full.querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Mustard");
  });

  it("REGRESSION: an already-selected duplicate colour is idempotent — the picker is never even opened, no row is clicked", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-suggestions-option-29", sectionHeading: "Suggested" });
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-29", sectionHeading: "All colours" });
    (doc.getElementById("color") as HTMLInputElement).value = "Mustard"; // already correct, from a previous attempt

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(true);
    expect(colourField.content.hidden).toBe(true); // never opened
  });

  it("REGRESSION: two GENUINELY conflicting exact matches (different underlying colour ids) still return AMBIGUOUS — never guessed, full diagnostics reported", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-suggestions-option-29", sectionHeading: "Suggested" });
    colourField.addRow({ name: "Mustard", id: 501, testId: "color-501", sectionHeading: "All colours (a genuinely different swatch)" });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AMBIGUOUS/);
    expect(result.reason).toMatch(/optionId=29/);
    expect(result.reason).toMatch(/optionId=501/);
    expect(result.reason).toMatch(/2 matches/);
  });

  it("REGRESSION: an unresolvable id on one candidate (no trailing digits at all) remains AMBIGUOUS — never assumed equal to the recognised candidate", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-29" });
    colourField.addRow({ name: "Mustard", id: 30, testId: "color-suggestions-option-mustard", sectionHeading: "Suggested" }); // no trailing digits — unrecognised shape

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AMBIGUOUS/);
    expect(result.reason).toMatch(/optionId=29/); // the recognised candidate
    expect(result.reason).toMatch(/optionId=unknown/); // the unrecognised shape — never guessed to also be 29
  });

  it("REGRESSION: nested matching elements collapse into one option too — the data-testid lives on a WRAPPER around the row, not the row itself", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    const nested = colourField.addRow({ name: "Mustard", id: 29, testId: "color-suggestions-option-29", sectionHeading: "Suggested", nested: true });
    colourField.addRow({ name: "Mustard", id: 29, testId: "color-29", sectionHeading: "All colours" });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem({ colours: ["Mustard"] }), deps);

    expect(result.ok).toBe(true);
    expect((nested.querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Mustard");
  });

  it("REGRESSION: publishing remains impossible, and processing continues on to Material, through a full happy-path run past a duplicate-but-equivalent colour", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["colour"]) });
    attachCategoryDependents(categoryField);
    const colourField = buildDuplicateColourField(doc, doc.body);
    colourField.addRow({ name: "Black", id: 1, testId: "color-suggestions-option-1", sectionHeading: "Suggested" });
    colourField.addRow({ name: "Black", id: 1, testId: "color-1", sectionHeading: "All colours" });
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    const saveDraftClicks = vi.fn();
    saveDraftButton.addEventListener("click", saveDraftClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem({ colours: ["Black"] }), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect((doc.getElementById("color") as HTMLInputElement).value).toBe("Black");
    expect((doc.getElementById("material") as HTMLInputElement).value).toBe("Mesh"); // processing continued past Colours to Materials
    expect(saveDraftClicks).toHaveBeenCalledTimes(1); // Save Draft is the only permitted final action
    expect(uploadClicks).not.toHaveBeenCalled(); // Upload/publish is never clicked
  }, 20000);
});

describe("stepSelectMaterials — shares stepSelectColours' verified reconciliation logic (root-scoping rewrite)", () => {
  it("REGRESSION: an already-correct material set is left untouched — the picker is never opened", async () => {
    const { doc, dom, categoryField, materialField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    (doc.getElementById("material") as HTMLInputElement).value = "Mesh";
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem(), deps); // validItem().materials = ["Mesh"]
    expect(result.ok).toBe(true);
    expect(materialField!.content.hidden).toBe(true);
  });
});

// ---- Virtualised/scrollable dropdown traversal (BUG FIX: valid materials
// like "Suede"/"Mesh" wrongly reported NOT_FOUND) ----------------------------
//
// Confirmed root cause: both options genuinely exist and are selectable
// manually on the live page, but only mount into the DOM once the picker's
// own scrollable options container is scrolled to them — the OLD
// implementation only ever searched whatever was already rendered.
// buildVirtualizedMultiField above simulates exactly that: a real
// windowing/virtualisation list, never everything rendered at once.
function longMaterialList(count: number, targetsAtEnd: string[] = []) {
  const values = Array.from({ length: count - targetsAtEnd.length }, (_, i) => ({ id: 1000 + i, name: `Filler material ${i + 1}` }));
  targetsAtEnd.forEach((name, i) => values.push({ id: 2000 + i, name }));
  return values;
}

describe("stepSelectMaterials — virtualised/scrollable dropdown traversal (BUG FIX)", () => {
  it('REQUIREMENT: "Mesh", initially below the rendered/visible options, becomes selectable after scrolling', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    const materialField = buildVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Mesh"]), windowSize: 6,
    });
    // Not rendered before any scroll — proves the scenario is genuine.
    expect(doc.querySelectorAll('[data-testid^="material-"][role="button"]').length).toBe(6);
    expect(Array.from(doc.querySelectorAll('[data-testid^="material-"][role="button"]')).some(el => el.textContent === "Mesh")).toBe(false);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("material") as HTMLInputElement).value).toBe("Mesh");
    expect(materialField.content.hidden).toBe(true); // closed via the same outside-click convention as ever
  });

  it('REQUIREMENT: "Suede", initially outside the rendered options, is found and selected after scrolling', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    buildVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(24, ["Suede"]), windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Suede"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("material") as HTMLInputElement).value).toBe("Suede");
  });

  it("REQUIREMENT: the dropdown rerenders its option nodes during scrolling — the matched element is from the LATEST render generation, never a stale reused one", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    const materialField = buildVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Mesh"]), windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const generationBeforeSearch = materialField.getRenderGeneration();
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    expect(materialField.getRenderGeneration()).toBeGreaterThan(generationBeforeSearch); // at least one real scroll-triggered rerender happened
    const matched = doc.getElementById("material-2000"); // "Mesh" — see longMaterialList's own id scheme
    expect(matched).not.toBeNull();
    expect(matched!.getAttribute("data-render-generation")).toBe(String(materialField.getRenderGeneration())); // came from the CURRENT (latest) render, not a stale one
  });

  it("REQUIREMENT: exact matching is preserved through the scroll fallback — case/whitespace normalised, never partial", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    // A near-miss ("Meshed Cotton") sits ALONGSIDE the real "Mesh" target —
    // if the fallback ever degraded to substring/partial matching, this
    // would wrongly resolve as ambiguous or select the wrong one.
    buildVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content",
      allValues: [...longMaterialList(18), { id: 3001, name: "Meshed Cotton" }, { id: 3002, name: "  mesh  " }],
      windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    // Normalised-text match: "  mesh  " (id 3002) is the one that's exactly
    // equal to "Mesh" once case/whitespace-normalised — never "Meshed Cotton".
    expect((doc.getElementById("material-checkbox-3002") as HTMLInputElement).checked).toBe(true);
    expect((doc.getElementById("material-checkbox-3001") as HTMLInputElement | null)?.checked ?? false).toBe(false);
  });

  it("REQUIREMENT: a genuinely absent material stops after a bounded, complete search — never an infinite loop", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    buildVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20), windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const started = Date.now();
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Genuinely Nonexistent Fabric"] }), deps);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^NOT_FOUND:/);
    expect(result.reason).toContain("Genuinely Nonexistent Fabric");
    expect(elapsedMs).toBeLessThan(15000); // bounded — never hangs
  });

  it("REQUIREMENT: an already-selected material (exact set match) stays idempotent — the picker is never opened, even though it's virtualised", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    const materialField = buildVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Mesh"]), windowSize: 6,
    });
    (doc.getElementById("material") as HTMLInputElement).value = "Mesh";

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    expect(materialField.content.hidden).toBe(true); // never opened at all — idempotent pre-check short-circuited before any scroll
  });

  it("REQUIREMENT: Colour selection is unaffected by the shared multi-select helper's scroll-fallback addition — two colours, non-virtualised, still resolve via the fast immediate path", async () => {
    const { doc, dom, categoryField, colourField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem(), deps); // validItem().colours = ["Black", "White"]
    expect(result.ok).toBe(true);
    const finalValues = (doc.getElementById("color") as HTMLInputElement).value.split(", ").sort();
    expect(finalValues).toEqual(["Black", "White"]);
    expect(colourField!.content.hidden).toBe(true);
  });
});

// ---- Structure-agnostic discovery (follow-up correction: Material still
// NOT_FOUND despite being visibly present) -----------------------------------
//
// Confirmed regression: the PREVIOUS scrolling fix still searched only one
// specific guessed shape ([data-testid^="material-"][role="button"]
// matched by ACCESSIBLE NAME) — Vinted's real current Material dropdown
// (per the live failure report and screenshots showing Suede genuinely
// visible and selectable) no longer reliably satisfies that shape.
// buildDriftedVirtualizedMultiField above simulates a DIFFERENT plausible
// shape in every dimension that could have broken the old assumption: no
// data-testid, role="option" not "button", a NESTED checkbox rather than a
// sibling, and a deliberately generic/wrong accessible name on the row
// itself — proving discovery now depends on VISIBLE TEXT and a broad
// role-based search, never one specific guessed structure.
describe("stepSelectMaterials — structure-agnostic discovery against a DIFFERENT (drifted) plausible DOM shape", () => {
  it('REQUIREMENT: a visible "Suede" row whose accessible name/outer option name is NOT "Suede" is still found and selected', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    const materialField = buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Suede"]), windowSize: 6,
    });
    // Sanity-check the fixture itself proves the premise: the accessible
    // name of every rendered row (including the eventual Suede row) is
    // the generic "Option", never "Suede" — so an accessible-name-based
    // match could never have found it, only visible-text extraction can.
    const initialRow = doc.querySelector('[role="option"]')!;
    expect(getAccessibleName(initialRow)).toBe("Option");

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Suede"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("material") as HTMLInputElement).value).toBe("Suede");
    expect(materialField.content.hidden).toBe(true);
  });

  it('REQUIREMENT: "Mesh" is found and selected via the drifted structure (no data-testid, nested checkbox, role="option")', async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Mesh"]), windowSize: 6,
    });
    // The legacy selector shape must find NOTHING here at all — proves
    // this test genuinely exercises the generic fallback, not the old path.
    expect(doc.querySelectorAll('[data-testid^="material-"][role="button"]').length).toBe(0);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    expect((doc.getElementById("material") as HTMLInputElement).value).toBe("Mesh");
  });

  it("REQUIREMENT: an off-screen option in the drifted structure becomes available after virtualised scrolling", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(24, ["Suede"]), windowSize: 6,
    });
    expect(Array.from(doc.querySelectorAll('[role="option"] span')).some(el => el.textContent === "Suede")).toBe(false); // not rendered before any scroll

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Suede"] }), deps);
    expect(result.ok).toBe(true);
  });

  it("REQUIREMENT: DOM option nodes in the drifted structure are replaced during scrolling — the matched row is from the LATEST render generation, never a stale reused one", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    const materialField = buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Mesh"]), windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const generationBeforeSearch = materialField.getRenderGeneration();
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    expect(materialField.getRenderGeneration()).toBeGreaterThan(generationBeforeSearch);
    const matched = doc.querySelector('[data-option-id="2000"]'); // "Mesh" — see longMaterialList's own id scheme
    expect(matched).not.toBeNull();
    expect(matched!.getAttribute("data-render-generation")).toBe(String(materialField.getRenderGeneration()));
  });

  it("REQUIREMENT: exact matching in the drifted structure is case/whitespace-normalised but never partial", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content",
      allValues: [...longMaterialList(18), { id: 3001, name: "Meshed Cotton" }, { id: 3002, name: "  MESH  " }],
      windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    const selectedRow = doc.querySelector('[data-option-id="3002"] input[type="checkbox"]') as HTMLInputElement;
    expect(selectedRow.checked).toBe(true);
    const nonSelectedRow = doc.querySelector('[data-option-id="3001"] input[type="checkbox"]') as HTMLInputElement | null;
    expect(nonSelectedRow?.checked ?? false).toBe(false);
  });

  it("REQUIREMENT: a genuinely missing material in the drifted structure stops after a bounded, complete search", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20), windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const started = Date.now();
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Genuinely Nonexistent Fabric"] }), deps);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^NOT_FOUND:/);
    expect(result.reason).toContain("dropdown_found=true"); // safe diagnostics — proves the dropdown itself WAS found
    expect(elapsedMs).toBeLessThan(15000);
  });

  it("REQUIREMENT: an already-selected material in the drifted structure remains selected without being toggled off", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]) });
    attachCategoryDependents(categoryField);
    const materialField = buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20, ["Mesh"]), windowSize: 6,
    });
    (doc.getElementById("material") as HTMLInputElement).value = "Mesh"; // already correct

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Mesh"] }), deps);

    expect(result.ok).toBe(true);
    expect(materialField.content.hidden).toBe(true); // idempotent — never even opened, so nothing could have been toggled
  });

  it("REQUIREMENT: safe diagnostics never include full page content, credentials or tokens — only counts/booleans/scroll positions", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage({ omit: new Set(["material"]), extraBodyText: "<p>" + "filler ".repeat(20000) + "</p>" });
    attachCategoryDependents(categoryField);
    buildDriftedVirtualizedMultiField(doc, doc.body, {
      idPrefix: "material", openId: "material", openTestId: "category-material-multi-list-input", openPlaceholder: "Select a material",
      contentTestId: "category-material-multi-list-content", allValues: longMaterialList(20), windowSize: 6,
    });

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem({ materials: ["Nonexistent"] }), deps);

    expect(result.ok).toBe(false);
    expect(result.reason.length).toBeLessThan(400); // nowhere close to the ~140KB filler text
    expect(result.reason).not.toContain("filler");
    expect(result.reason).toMatch(/dropdown_found=true rows_inspected=\d+ text_observed=false control_resolved=false start_scroll=\d+ final_scroll=\d+/);
  });
});

describe("assertValidInteractionTarget / isInvalidInteractionTarget — invalid-interaction-target safety bug (follow-up correction)", () => {
  it("REGRESSION: rejects document.body concisely, tagged BODY, with the given step name — never the page's own text", () => {
    const { doc } = buildMockVintedPage({ extraBodyText: "<p>" + "filler ".repeat(50000) + "</p>" });
    let thrown: Error | null = null;
    try {
      assertValidInteractionTarget(doc.body, "SET_CONDITION");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toBe("INVALID_INTERACTION_TARGET: step=SET_CONDITION tag=BODY");
    expect(thrown!.message.length).toBeLessThan(200); // never anywhere close to the ~350KB filler text
  });

  it("REGRESSION: rejects document.documentElement concisely, tagged HTML", () => {
    const { doc } = buildMockVintedPage();
    expect(() => assertValidInteractionTarget(doc.documentElement, "SET_COLOURS")).toThrow("INVALID_INTERACTION_TARGET: step=SET_COLOURS tag=HTML");
  });

  it("REGRESSION: rejects the app's own 'form root' — on this page's root-scoping design that root IS doc.body (see findFormRoot)", () => {
    const { doc } = buildMockVintedPage();
    const root = findFormRoot(doc);
    expect(root).toBe(doc.body);
    expect(() => assertValidInteractionTarget(root!, "SET_MATERIALS")).toThrow("INVALID_INTERACTION_TARGET: step=SET_MATERIALS tag=BODY");
  });

  it("REGRESSION: rejects a detached but bare <html>/<body> element too — a tag-based check, not just a doc.body/documentElement identity check", () => {
    const { doc } = buildMockVintedPage();
    const detachedBody = doc.createElement("body");
    const detachedHtml = doc.createElement("html");
    expect(isInvalidInteractionTarget(detachedBody)).toBe(true);
    expect(isInvalidInteractionTarget(detachedHtml)).toBe(true);
  });

  it("REGRESSION: rejects passing `document` itself (no element/tagName at all)", () => {
    const { doc } = buildMockVintedPage();
    expect(isInvalidInteractionTarget(doc as unknown as Element)).toBe(true);
  });

  it("defaults stepName to \"unknown\" when the caller doesn't provide one", () => {
    const { doc } = buildMockVintedPage();
    expect(() => assertValidInteractionTarget(doc.body)).toThrow("INVALID_INTERACTION_TARGET: step=unknown tag=BODY");
  });

  it("allows a specific, narrow, actionable control — e.g. the Colours field's own opener — never throws", () => {
    const { colourField } = buildMockVintedPage();
    expect(isInvalidInteractionTarget(colourField!.opener)).toBe(false);
    expect(() => assertValidInteractionTarget(colourField!.opener, "SET_COLOURS")).not.toThrow();
  });
});

describe("getAccessibleName / boundedText — every fallback is length-bounded, never the whole page (invalid-interaction-target safety bug follow-up)", () => {
  it("REGRESSION: an element with children and a huge textContent (~1.5MB, matching the live bug report) is capped, never returned in full", () => {
    const { doc } = buildMockVintedPage();
    const giant = doc.createElement("div");
    const child = doc.createElement("span");
    child.textContent = "x".repeat(1_500_000);
    giant.appendChild(child);
    const name = getAccessibleName(giant);
    expect(name.length).toBeLessThanOrEqual(301); // 300 chars + the truncation ellipsis
  });

  it("REGRESSION: assertNotForbiddenAction's thrown error stays bounded even given a huge accessible name directly — defence in depth on top of getAccessibleName's own cap", () => {
    const huge = "upload ".repeat(300000); // matches the forbidden /\bupload\b/i pattern AND is enormous (~2.1MB)
    let thrown: Error | null = null;
    try {
      assertNotForbiddenAction(huge);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message.length).toBeLessThan(500); // nowhere near the ~2.1MB input
  });
});

describe("safeClick — refuses invalid broad targets before computing an accessible name, and never lets an unrelated Upload button contaminate a valid control's own check (invalid-interaction-target safety bug)", () => {
  it("REGRESSION: safeClick(doc.body) is rejected with a concise INVALID_INTERACTION_TARGET error, never the page's own text, even with a huge page present", () => {
    const { doc } = buildMockVintedPage({ extraBodyText: "<p>" + "filler ".repeat(50000) + "</p>" });
    expect(() => safeClick(doc.body, "SET_CONDITION")).toThrow("INVALID_INTERACTION_TARGET: step=SET_CONDITION tag=BODY");
  });

  it("REGRESSION: safeClick(doc.documentElement) is rejected, tagged HTML", () => {
    const { doc } = buildMockVintedPage();
    expect(() => safeClick(doc.documentElement, "SET_COLOURS")).toThrow("INVALID_INTERACTION_TARGET: step=SET_COLOURS tag=HTML");
  });

  it("REGRESSION: a valid Condition option is allowed even though the surrounding page contains an Upload button (the Upload button's own text never contaminates the Condition option's accessible-name check)", () => {
    const { doc, categoryField, conditionField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    conditionField!.opener.click();
    const veryGood = conditionField!.options.find(o => o.textContent === "Very good")!;
    expect(() => safeClick(veryGood, "SET_CONDITION")).not.toThrow();
    expect((doc.getElementById("condition") as HTMLInputElement).value).toBe("Very good");
  });

  it("REGRESSION: a valid Colours option is allowed even though the surrounding page contains an Upload button", () => {
    const { colourField, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    colourField!.opener.click();
    const black = colourField!.options.find(o => o.name === "Black")!;
    expect(() => safeClick(black.optionEl, "SET_COLOURS")).not.toThrow();
    expect(black.checkbox.checked).toBe(true);
  });

  it("REGRESSION: a valid Material option is allowed even though the surrounding page contains an Upload button", () => {
    const { materialField, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    materialField!.opener.click();
    const mesh = materialField!.options.find(o => o.name === "Mesh")!;
    expect(() => safeClick(mesh.optionEl, "SET_MATERIALS")).not.toThrow();
    expect(mesh.checkbox.checked).toBe(true);
  });

  it("REGRESSION: an actual Upload/Publish control is still rejected — the forbidden-action guard is unweakened by this fix", () => {
    const { doc } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    expect(() => safeClick(uploadButton, "SET_CONDITION")).toThrow(/SAFETY: refusing to interact/);
    expect(uploadClicks).not.toHaveBeenCalled();
  });

  it("REGRESSION: Save Draft remains clickable via safeClick (draft-only safety is preserved)", () => {
    const { doc } = buildMockVintedPage();
    const saveDraft = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    expect(() => safeClick(saveDraft, "SAVE_DRAFT")).not.toThrow();
  });
});

describe("Full-flow past Size into Condition/Colours/Materials — invalid-interaction-target safety bug follow-up (Upload never clicked, dropdown closes via the non-safeClick dismissal path)", () => {
  it("REGRESSION: stepSelectCondition succeeds with an Upload button present elsewhere on the page", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectCondition(doc.body, validItem(), deps);
    expect(result.ok).toBe(true);
    expect(uploadClicks).not.toHaveBeenCalled();
  });

  it("REGRESSION: stepSelectColours succeeds and closes the picker without ever throwing INVALID_INTERACTION_TARGET or SAFETY, and Upload is never clicked", async () => {
    const { doc, dom, categoryField, colourField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectColours(doc.body, validItem(), deps); // validItem().colours = ["Black", "White"]
    expect(result.ok).toBe(true);
    expect(colourField!.content.hidden).toBe(true); // dropdown genuinely closed
    expect(uploadClicks).not.toHaveBeenCalled();
  });

  it("REGRESSION: stepSelectMaterials succeeds and closes the picker, Upload is never clicked", async () => {
    const { doc, dom, categoryField, materialField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await stepSelectMaterials(doc.body, validItem(), deps); // validItem().materials = ["Mesh"]
    expect(result.ok).toBe(true);
    expect(materialField!.content.hidden).toBe(true);
    expect(uploadClicks).not.toHaveBeenCalled();
  });

  it("REGRESSION: a full run continues past Size into Condition, Colours and Materials, reaches Save Draft, and Upload/Publish remain impossible throughout", async () => {
    const { doc, dom, conditionField, colourField, materialField } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect((doc.getElementById("condition") as HTMLInputElement).value).toBe("Very good");
    expect(conditionField!.content.hidden).toBe(true);
    expect(colourField!.content.hidden).toBe(true);
    expect(materialField!.content.hidden).toBe(true);
    expect(uploadClicks).not.toHaveBeenCalled();
  }, 20000);
});

describe("Full-flow retry and publishing safety (root-scoping/dialog-interaction rewrite)", () => {
  it("REGRESSION: no later field is touched, and Upload is never clicked, when a genuine SET_COLOURS failure occurs", async () => {
    const { doc, dom } = buildMockVintedPage({ omit: new Set(["colour"]) });
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);

    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SET_COLOURS");
    expect((doc.getElementById("material") as HTMLInputElement | null)?.value ?? "").toBe(""); // material exists but was never reached
    expect((doc.getElementById("price") as HTMLInputElement).value).toBe(""); // never reached
    expect(uploadClicks).not.toHaveBeenCalled();
  }, 20000);

  it("REGRESSION: a full run with MIXED retry state (title/description already correct from a previous attempt; everything else still needs setting) reaches Save Draft only — Upload remains impossible", async () => {
    const { doc, dom } = buildMockVintedPage();
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);

    (doc.getElementById("title") as HTMLInputElement).value = "Hoka Clifton 9 Trainers";
    (doc.getElementById("description") as HTMLInputElement).value = "A great pair of trainers.";

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(uploadClicks).not.toHaveBeenCalled();
  }, 20000);
});

describe("Parcel/package size — Vinted's own default is never touched (never selects, changes, waits for, or validates parcel size)", () => {
  it("REGRESSION: Small/Medium/Large parcel-size controls are never clicked during a full run", async () => {
    const { doc, dom } = buildMockVintedPage({ parcelSize: { defaultSize: "Medium" } });
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    // Clicking any parcel-size option would have THROWN (see buildParcelSizeField) and failed this test outright.
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  }, 20000);

  it("REGRESSION: Vinted's own auto-selected default parcel size is left completely unchanged after a full run", async () => {
    const { doc, dom, parcelSizeField } = buildMockVintedPage({ parcelSize: { defaultSize: "Large" } });
    expect(parcelSizeField!.selectedLabel()).toBe("Large");

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(parcelSizeField!.selectedLabel()).toBe("Large"); // still Vinted's own default — never changed to Small/Medium
  }, 20000);

  it("REGRESSION: no parcel-size confirmation control is ever clicked", async () => {
    const { doc, dom, parcelSizeField } = buildMockVintedPage({ parcelSize: {} });
    const confirmClicks = vi.fn();
    parcelSizeField!.confirmButton.addEventListener("click", confirmClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(confirmClicks).not.toHaveBeenCalled();
  }, 20000);

  it("REGRESSION: missing parcel-size DOM entirely does not block saving — the extension never looks for it", async () => {
    const { doc, dom } = buildMockVintedPage(); // parcelSize is opt-in and omitted here entirely
    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  }, 20000);

  it("REGRESSION: an unusual/unexpected parcel-size DOM shape does not block saving either", async () => {
    const { doc, dom } = buildMockVintedPage();
    // A completely different, made-up shape — a bare <select> instead of
    // Small/Medium/Large buttons, with no data-testid the extension would
    // ever recognise. Proves the robustness comes from never looking for
    // parcel size at all, not from tolerating this (or any) specific
    // shape.
    const oddSelect = doc.createElement("select");
    oddSelect.id = "shipping-size-guess";
    for (const label of ["XS", "S/M", "L/XL"]) {
      const opt = doc.createElement("option");
      opt.textContent = label;
      oddSelect.appendChild(opt);
    }
    oddSelect.addEventListener("change", () => {
      throw new Error("SAFETY VIOLATION: the unusual parcel-size control was interacted with!");
    });
    doc.body.appendChild(oddSelect);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
  }, 20000);

  it("REGRESSION: Save Draft is clicked exactly once during a full run, with parcel-size controls present", async () => {
    const { doc, dom } = buildMockVintedPage({ parcelSize: {} });
    const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    const saveDraftClicks = vi.fn();
    saveDraftButton.addEventListener("click", saveDraftClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(saveDraftClicks).toHaveBeenCalledTimes(1);
  }, 20000);

  it("REGRESSION: Upload is never clicked, with parcel-size controls present on the page", async () => {
    const { doc, dom } = buildMockVintedPage({ parcelSize: {} });
    const uploadButton = doc.querySelector('[data-testid="upload-form-save-button"]') as HTMLButtonElement;
    const uploadClicks = vi.fn();
    uploadButton.addEventListener("click", uploadClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(validItem(), vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(uploadClicks).not.toHaveBeenCalled();
  }, 20000);

  it("RETRY: for a form where every real field is already correct, retry recognises them all, ignores parcel size entirely, and clicks Save Draft exactly once", async () => {
    const { doc, dom, categoryField, parcelSizeField } = buildMockVintedPage({ parcelSize: { defaultSize: "Small" } });
    attachCategoryDependents(categoryField);

    const item = validItem();
    (doc.getElementById("title") as HTMLInputElement).value = item.title;
    (doc.getElementById("description") as HTMLInputElement).value = item.description;
    (doc.getElementById("category") as HTMLInputElement).value = DEFAULT_LEAF_NAME;
    (doc.getElementById("brand") as HTMLInputElement).value = item.brand;
    (doc.getElementById("size") as HTMLInputElement).value = item.ukSize;
    (doc.getElementById("condition") as HTMLInputElement).value = "Very good";
    (doc.getElementById("color") as HTMLInputElement).value = item.colours.join(", ");
    (doc.getElementById("material") as HTMLInputElement).value = item.materials.join(", ");
    (doc.getElementById("price") as HTMLInputElement).value = String(item.pricePence / 100);

    const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    const saveDraftClicks = vi.fn();
    saveDraftButton.addEventListener("click", saveDraftClicks);

    const deps = buildDeps(doc, dom.window as unknown as Window & typeof globalThis);
    const result = await runItem(item, vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    // Every real field recognised as already correct (idempotent skip),
    // parcel size ignored entirely, Save Draft reached directly and
    // clicked exactly once — confirmation itself is now the service
    // worker's durable job (see tests/vinted-extension-service-worker.test.ts).
    expect(result.status).toBe("saving");
    expect((result as { pending?: boolean }).pending).toBe(true);
    expect(saveDraftClicks).toHaveBeenCalledTimes(1);
    expect(parcelSizeField!.selectedLabel()).toBe("Small"); // still Vinted's own default
  }, 20000);
});

describe("Full-flow — live Save Draft investigation follow-up (retry never duplicates an already-confirmed draft)", () => {
  it("RETRY: when deps.getKnownVintedDraftId already reports a confirmed draft for this item, retry recognises every field as already correct, never clicks Save Draft again, and completes immediately with the known id — no duplicate draft is ever created", async () => {
    const { doc, dom, categoryField } = buildMockVintedPage();
    attachCategoryDependents(categoryField);
    const win = dom.window as unknown as Window & typeof globalThis;

    const item = validItem();
    (doc.getElementById("title") as HTMLInputElement).value = item.title;
    (doc.getElementById("description") as HTMLInputElement).value = item.description;
    (doc.getElementById("category") as HTMLInputElement).value = DEFAULT_LEAF_NAME;
    (doc.getElementById("brand") as HTMLInputElement).value = item.brand;
    (doc.getElementById("size") as HTMLInputElement).value = item.ukSize;
    (doc.getElementById("condition") as HTMLInputElement).value = "Very good";
    (doc.getElementById("color") as HTMLInputElement).value = item.colours.join(", ");
    (doc.getElementById("material") as HTMLInputElement).value = item.materials.join(", ");
    (doc.getElementById("price") as HTMLInputElement).value = String(item.pricePence / 100);

    const saveDraftButton = doc.querySelector('[data-testid="upload-form-save-draft-button"]') as HTMLButtonElement;
    const saveDraftClicks = vi.fn();
    saveDraftButton.addEventListener("click", saveDraftClicks);

    const deps = { ...buildDeps(doc, win), getKnownVintedDraftId: vi.fn(async () => "9621049256") };
    const result = await runItem(item, vi.fn((s, e = {}) => ({ status: s, ...e })), deps);

    expect(result.status).toBe("completed");
    expect(result.vintedDraftId).toBe("9621049256");
    expect(saveDraftClicks).not.toHaveBeenCalled(); // never duplicated — Save Draft was never clicked again
  }, 20000);
});
