// Vinted Draft Queue extension — DOM query framework + Vinted-specific
// field strategies for the Create Listing form.
//
// VINTED_FIELD_STRATEGIES below is now the VERIFIED contract, captured
// from a live, signed-in session at https://www.vinted.co.uk/items/new
// (see form-steps.js's per-field step functions for how each one is
// actually driven). Every id/data-testid here was read directly off that
// page — none of it is guessed. Narrow, exact-accessible-label fallbacks
// remain in a couple of places (size, condition-label normalisation)
// specifically because those were themselves the verified mechanism, not
// a guess filling a gap. If a future live check finds a value here no
// longer matches, update ONLY the affected entry — the framework
// functions (getAccessibleName, findByRole, requireUnique,
// resolveVerifiedField, isForbiddenActionName/Id, isAllowedSaveDraftName)
// are stable and shouldn't need to change alongside it.

// ---- Accessible-name / role utilities -------------------------------------

const ROLE_SELECTORS = {
  button: 'button, [role="button"], input[type="submit"]',
  textbox: 'input[type="text"], input[type="number"], input:not([type]), textarea, [role="textbox"]',
  combobox: 'select, [role="combobox"], [role="listbox"], button[aria-haspopup="listbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  radiogroup: '[role="radiogroup"], fieldset',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  option: '[role="option"], li[role="option"]',
  fileInput: 'input[type="file"]',
};

// Follow-up correction (invalid-interaction-target safety bug) — root
// cause: getAccessibleName's own "own text" fallback (below) returns
// `element.textContent` verbatim for ANY element with children and no
// more specific name — for a page-level container like `document.body`,
// `textContent` is the ENTIRE rendered page's text (confirmed live: a
// ~1.5MB string), which then got embedded whole into a thrown safety
// error. Every text-based fallback below is now capped to this length —
// still more than enough to identify a genuine control's own short label,
// and never large enough to embed a whole page. See also
// assertValidInteractionTarget below, which rejects page-level containers
// like `document.body` BEFORE this function is ever called on them at
// all — this cap is deliberate defence in depth on top of that, not a
// replacement for it.
const ACCESSIBLE_NAME_MAX_LENGTH = 300;
function boundedText(text) {
  return text.length > ACCESSIBLE_NAME_MAX_LENGTH ? `${text.slice(0, ACCESSIBLE_NAME_MAX_LENGTH)}…` : text;
}

/** Best-effort accessible name: aria-label, aria-labelledby, associated <label>, own text, placeholder, title — in that priority order, matching how a screen reader would resolve it. Every branch is length-bounded (see boundedText) — never the complete text of a large/page-level element. */
export function getAccessibleName(element, doc = element.ownerDocument) {
  const ariaLabel = element.getAttribute && element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return boundedText(ariaLabel.trim());

  const labelledBy = element.getAttribute && element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
    if (text) return boundedText(text);
  }

  if (element.id) {
    const label = doc.querySelector(`label[for="${cssEscape(element.id)}"]`);
    if (label && label.textContent && label.textContent.trim()) return boundedText(label.textContent.trim());
  }

  // <fieldset><legend>...</legend></fieldset> is the standard semantic
  // pattern for a named group of radios/checkboxes (e.g. Condition) — a
  // fieldset's own accessible name comes from its <legend>, never from
  // concatenating every option's own text (which would produce meaningless
  // run-together text like "New with tagsVery goodGood").
  if (element.tagName === "FIELDSET") {
    const legend = element.querySelector("legend");
    if (legend && legend.textContent && legend.textContent.trim()) return boundedText(legend.textContent.trim());
  }

  const closestLabel = element.closest && element.closest("label");
  if (closestLabel && closestLabel.textContent && closestLabel.textContent.trim()) return boundedText(closestLabel.textContent.trim());

  if (element.textContent && element.textContent.trim() && element.children.length === 0) return boundedText(element.textContent.trim());
  if (element.children && element.children.length > 0 && element.textContent && element.textContent.trim()) return boundedText(element.textContent.trim());

  const placeholder = element.getAttribute && element.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return boundedText(placeholder.trim());

  const title = element.getAttribute && element.getAttribute("title");
  if (title && title.trim()) return boundedText(title.trim());

  return "";
}

// Follow-up correction (invalid-interaction-target safety bug) — the
// SPECIFIC fix: never let a page-level container reach getAccessibleName
// (or a click) at all. `document`, `document.documentElement`,
// `document.body` (which, on this extension's own root-scoping design,
// IS the Create Listing "form root" — see CREATE_LISTING_FORM_SELECTORS's
// own comment), and any bare `<html>`/`<body>` element are rejected
// immediately, before any name is ever computed.
const INVALID_INTERACTION_TARGET_TAGS = new Set(["HTML", "BODY"]);

export function isInvalidInteractionTarget(element) {
  if (!element || typeof element !== "object" || !element.tagName) return true;
  const doc = element.ownerDocument;
  if (doc && (element === doc.documentElement || element === doc.body)) return true;
  if (INVALID_INTERACTION_TARGET_TAGS.has(element.tagName)) return true;
  return false;
}

/** Throws a concise, BOUNDED `INVALID_INTERACTION_TARGET` error — never an accessible name, never any page content — if `element` is a page-level container rather than a specific, actionable control. Call this BEFORE getAccessibleName/assertNotForbiddenAction on every click, no exceptions. */
export function assertValidInteractionTarget(element, stepName = "unknown") {
  if (isInvalidInteractionTarget(element)) {
    const tag = element && element.tagName ? element.tagName : String(element);
    throw new Error(`INVALID_INTERACTION_TARGET: step=${stepName} tag=${tag}`);
  }
}

// Follow-up correction (login-detection bug): detectLoginRequired() used
// to scan the ENTIRE doc.body.textContent, which matches hidden content
// exactly as readily as visible content — e.g. a pre-rendered, always-in-
// the-DOM-but-hidden login modal/template Vinted keeps around for
// non-authenticated visitors. This reliable visibility check is what lets
// callers scope themselves to content a real user could actually see:
// rejects `display:none`, `visibility:hidden` (including via a HIDDEN
// ANCESTOR, not just the element itself), the `[hidden]` attribute,
// `aria-hidden="true"`, and anything not even attached to the live
// document at all (detached fragments, <template> content — which isn't
// reachable via querySelectorAll on the main document in the first place
// — and <script>/<style> elements, which are never visible content).
const NEVER_VISIBLE_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

export function isVisible(element) {
  if (!element || typeof element.nodeType !== "number") return false;
  if (NEVER_VISIBLE_TAGS.has(element.tagName)) return false;
  const doc = element.ownerDocument;
  if (!doc || !doc.contains(element)) return false;

  const view = doc.defaultView;
  const getStyle = view?.getComputedStyle ? node => view.getComputedStyle(node) : () => null;

  // Zero-sized: an explicitly authored 0x0 box (e.g. the classic
  // "visually hidden via width:0;height:0" pattern). Checked only on the
  // element itself, not every ancestor — a wrapper deliberately sized 0x0
  // around an absolutely-positioned, genuinely visible child is a real,
  // if unusual, layout pattern this must not misclassify.
  const ownStyle = getStyle(element);
  if (ownStyle && parseFloat(ownStyle.width) === 0 && parseFloat(ownStyle.height) === 0) return false;

  let node = element;
  while (node && node.nodeType === 1) {
    if (node.hasAttribute && node.hasAttribute("hidden")) return false;
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return false;
    const style = getStyle(node);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) return false;
    node = node.parentElement;
  }
  return true;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

/**
 * Finds every element of `role` within `root` whose accessible name matches.
 * `name` = exact match (case-insensitive); `nameContains` = substring match.
 * Neither given = every element of that role. Always scoped to `root`
 * (e.g. the form container), NEVER the whole document — a global search is
 * exactly the "brittle global text search" this must avoid.
 */
export function findByRole(root, role, { name, nameContains } = {}) {
  const selector = ROLE_SELECTORS[role] || `[role="${role}"]`;
  const candidates = Array.from(root.querySelectorAll(selector));
  if (name === undefined && nameContains === undefined) return candidates;
  return candidates.filter(el => {
    const accessibleName = getAccessibleName(el);
    if (name !== undefined) return accessibleName.toLowerCase() === String(name).toLowerCase();
    return accessibleName.toLowerCase().includes(String(nameContains).toLowerCase());
  });
}

/**
 * The core "require exactly one" gate every state-machine step goes
 * through — see content-script.js. Zero or multiple matches is always a
 * FAILURE, never "pick the first one" or "pick the most likely one".
 */
export function requireUnique(elements, description) {
  if (!elements || elements.length === 0) return { ok: false, reason: `NOT_FOUND: ${description}` };
  if (elements.length > 1) return { ok: false, reason: `AMBIGUOUS: ${description} (${elements.length} matches)` };
  return { ok: true, element: elements[0] };
}

/**
 * Resolves a field by its VERIFIED `id` and/or `data-testid` — the exact
 * contract captured from the live page, not a guess. Both, when given,
 * are queried together (`#id, [data-testid="..."]`); querySelectorAll
 * already deduplicates a single element matching more than one part of
 * that list, so a field that carries BOTH attributes (the common case
 * here) still resolves to exactly one match, not two.
 */
export function resolveVerifiedField(root, { id, testId } = {}) {
  const selectors = [];
  if (id) selectors.push(`#${cssEscape(id)}`);
  if (testId) selectors.push(`[data-testid="${cssEscape(testId)}"]`);
  if (selectors.length === 0) return { ok: false, reason: "NOT_FOUND: no id/testId configured for this field." };
  const matches = Array.from(root.querySelectorAll(selectors.join(", ")));
  return requireUnique(matches, `id="${id ?? ""}" data-testid="${testId ?? ""}"`);
}

// Follow-up correction (false NOT_FOUND on the photo input): verified live
// shape is exactly `<input type="file" name="photos"
// data-testid="add-photos-input">` — deliberately NO id attribute, and
// intentionally visually hidden (a real, always-hidden file input the
// visible "Upload photos" button activates; zero size/hidden is its
// NORMAL state, never a sign it's missing). resolveVerifiedField() above
// is the wrong tool for this specific field for two independent reasons:
// (1) it's scoped to a `root` container, but the live page doesn't render
// this input inside the Create Listing form root at all; (2) with no id
// to key off, its own NOT_FOUND reason string prints a bare `id=""`,
// which is exactly the kind of generated-but-meaningless diagnostic this
// correction removes. This is a DELIBERATE, NARROW exception — every
// other field (ordinary text fields, every dialog, login/CAPTCHA
// detection) still requires visibility; only this one verified,
// always-hidden file input never does.
const PHOTO_INPUT_SELECTOR = 'input[type="file"][name="photos"][data-testid="add-photos-input"]';

/**
 * Resolves the verified hidden photo input by searching the WHOLE
 * DOCUMENT (never scoped to the Create Listing form root — see this
 * section's own comment). Validates every requirement explicitly rather
 * than trusting the CSS selector alone: must be an HTMLInputElement,
 * type/name/data-testid must match exactly, and it must not be disabled
 * — but visibility, size, and the presence of an id are deliberately
 * NEVER checked.
 */
export function resolvePhotoInput(doc) {
  const view = doc.defaultView;
  const candidates = Array.from(doc.querySelectorAll(PHOTO_INPUT_SELECTOR)).filter(el =>
    (!view || el instanceof view.HTMLInputElement)
    && el.type === "file"
    && el.name === "photos"
    && el.getAttribute("data-testid") === "add-photos-input"
    && !el.disabled,
  );
  return requireUnique(candidates, 'the verified hidden photo input (input[type="file"][name="photos"][data-testid="add-photos-input"])');
}

// Follow-up correction (photo-confirmation false-negative bug) — verified
// live shape, captured from a live, signed-in session at
// https://www.vinted.co.uk/items/new (real photos uploaded and inspected
// directly, not guessed from a screenshot):
//
//   #photos[data-testid="media-upload"]           <- the whole photos area (same "lives outside the form root" exception as PHOTO_INPUT_SELECTOR above)
//     [data-testid="dropzone"]                    <- big empty-state "Drop files here" / Upload photos CTA, shown only with zero photos
//     [data-testid="media-upload-grid"]            <- the grid; DIRECT children alternate real content with bare, testid-less <span> "spacer" elements the drag-and-drop library inserts between cards — this is exactly why counting grid.children (or ANY broad wildcard selector) is unreliable, and why every marker below is matched by its own exact, own-purpose data-testid instead
//       [data-testid="image-wrapper-N"]            <- ONE PER UPLOADED PHOTO, index-suffixed (N = 0, 1, 2, ... in display/position order) — this, and only this, is what "an uploaded photo card" means; the visible image itself is a background-image DIV (web_ui__Image__image), never an <img> element, so img[src]/blob-URL/visibility-based checks never match it at all
//       [data-testid="media-select-main-badge-0"]  <- the "Main" (cover-photo) badge — EXISTS ONLY on photo index 0, never one-per-photo; its own inner text node is data-testid="media-select-main-badge-0--content"
//       [data-testid="media-select-grid-delete-button-N"]  <- the remove-photo control, one per photo, aria-label="Remove selected photo"
//       [data-testid="media-select-grid-rotate-button-N"]  <- a rotate control, one per photo (not otherwise used here)
//       [data-testid="add-photos-icon-button"]     <- the EMPTY "add another photo" tile — a DIRECT grid child in its own right once >=1 photo exists (contains a "media-select-upload-button" icon inside it); it has no image-wrapper/delete-button inside it and must NEVER be counted as an uploaded photo
//
// No separate "uploading/in-progress" placeholder card was ever observed
// live, even while deliberately uploading a large (~7.7 MB) photo and
// inspecting the DOM immediately after dispatching it: no element anywhere
// on the page had role="progressbar", aria-busy="true", or a data-testid
// containing "load"/"progress"/"pending"/"spinner" at any point. This is
// consistent with image-wrapper-N simply not existing in the DOM at all
// until the photo's own POST /api/v2/photos upload has already resolved —
// i.e. counting image-wrapper-N elements already implies "finished
// uploading" by construction. hasActiveUploadIndicator() below is kept as
// a defensive, purely additive check (never assumed present) in case a
// slower/different upload path ever does render one.
const UPLOADED_PHOTO_CARD_SELECTOR = '[data-testid^="image-wrapper-"]';
const PHOTO_ADD_TILE_SELECTOR = '[data-testid="add-photos-icon-button"]';
const PHOTO_UPLOAD_GRID_SELECTOR = '[data-testid="media-upload-grid"]';

/** The number of genuinely uploaded photo cards currently in the DOM — never the add-tile, never a drag-and-drop spacer, never anything counted via a broad/guessed selector. Searches the WHOLE document, same "outside the form root" reasoning as resolvePhotoInput. */
export function countUploadedPhotoCards(doc) {
  return doc.querySelectorAll(UPLOADED_PHOTO_CARD_SELECTOR).length;
}

/** The number of empty "add another photo" tiles present — always 0 or 1 on the real page; exposed mainly so a failure report can state it explicitly rather than leaving it implicit. */
export function countAddPhotoTiles(doc) {
  return doc.querySelectorAll(PHOTO_ADD_TILE_SELECTOR).length;
}

/** True if the page currently shows anything that looks like an active upload/loading indicator, scoped to the photo grid when it exists. See this section's own comment on why this is defensive rather than load-bearing: real image-wrapper-N cards were never observed to exist while genuinely still uploading. */
export function hasActiveUploadIndicator(doc) {
  const scope = doc.querySelector(PHOTO_UPLOAD_GRID_SELECTOR) || doc;
  return Boolean(
    scope.querySelector('[aria-busy="true"]')
    || scope.querySelector('[role="progressbar"]')
    || scope.querySelector('[data-testid*="loading" i], [data-testid*="progress" i], [data-testid*="pending" i], [data-testid*="spinner" i]'),
  );
}

// Follow-up correction (title-field NOT_FOUND bug) — verified live shape,
// captured from a live, signed-in session at
// https://www.vinted.co.uk/items/new: a completely ordinary, always-
// present, directly-editable `<input id="title" name="title"
// data-testid="title--input">`. NOT read-only, NOT behind a click-to-
// reveal row/dialog/drawer, and requires no separate confirm/apply
// action — verified directly by setting its value via the native setter
// (the same mechanism setNativeValue below already uses) and confirming
// it persists with no further interaction. What's visible before a title
// is entered ("Tell buyers what you're selling") is simply this input's
// own `placeholder`, not a separate display row.
//
// The bug: this input, exactly like the photo input/grid above, is
// confirmed NOT rendered inside ANY <form> element on the real page —
// the page's only two <form>s are the header's search bar
// (action="/catalog"), which CREATE_LISTING_FORM_SELECTORS's own generic
// "form" fallback was matching instead of the (nonexistent) real one.
// So resolveVerifiedField(root, ...)'s form-root scoping could never find
// it. Title deliberately has NO entry in VINTED_FIELD_STRATEGIES below —
// see resolveTitleInput(), the dedicated whole-document resolver for this
// field, mirroring resolvePhotoInput's own reasoning exactly.
export const TITLE_INPUT_SELECTOR = 'input[data-testid="title--input"]';

/** Resolves the verified Title input by searching the WHOLE document (never scoped to the Create Listing form root — see this section's own comment on why). */
export function resolveTitleInput(doc) {
  const view = doc.defaultView;
  const candidates = Array.from(doc.querySelectorAll(TITLE_INPUT_SELECTOR)).filter(el =>
    (!view || el instanceof view.HTMLInputElement)
    && el.getAttribute("data-testid") === "title--input"
    && !el.disabled,
  );
  return requireUnique(candidates, 'the verified Title input (input[data-testid="title--input"])');
}

// ---- Absolute publishing-safety guard --------------------------------------

// Any control whose accessible name matches one of these is NEVER
// interacted with, under any circumstance, regardless of which step is
// running or what the caller asked for. This list is intentionally
// broader than just "Vinted's exact wording" — see this module's own top
// comment; adapt/extend it once the real page is seen, but never narrow it
// to fewer patterns without a specific, deliberate reason.
const FORBIDDEN_ACTION_PATTERNS = [
  /\bupload\b/i,
  /\bpublish\b/i,
  /\blist\s*item\b/i,
  /^post$/i,
  /\bsubmit\s*listing\b/i,
  /\bmake\s*it\s*live\b/i,
  /\bgo\s*live\b/i,
  /\bactivate\s*listing\b/i,
];

export function isForbiddenActionName(accessibleName) {
  if (!accessibleName) return false;
  const trimmed = accessibleName.trim();
  return FORBIDDEN_ACTION_PATTERNS.some(pattern => pattern.test(trimmed));
}

/** Throws if `accessibleName` matches a forbidden action — call this immediately before EVERY click, no exceptions, including the save-draft step itself. The name embedded in the error is independently bounded here too (defence in depth on top of getAccessibleName's own cap — see that function's comment) so this error can never carry a whole page's text regardless of what produced `accessibleName`. */
export function assertNotForbiddenAction(accessibleName) {
  if (isForbiddenActionName(accessibleName)) {
    throw new Error(`SAFETY: refusing to interact with a control whose accessible name matches a forbidden publishing action: "${boundedText(accessibleName || "")}"`);
  }
}

// The ONLY allowlisted final-save action. Deliberately requires the word
// "draft" to appear — structurally disjoint from every FORBIDDEN_ACTION_PATTERNS
// entry above (none of them contain "draft"), so a control can never
// simultaneously satisfy both lists. A bare "Save" is deliberately NOT
// allowed here — see this module's own top comment on why a generic
// primary button is never acceptable.
const SAVE_DRAFT_ALLOWED_PATTERNS = [/save\s*(as\s*)?draft/i, /draft\s*(it|this)?\s*$/i, /keep\s*as\s*draft/i];

export function isAllowedSaveDraftName(accessibleName) {
  if (!accessibleName) return false;
  const trimmed = accessibleName.trim();
  return SAVE_DRAFT_ALLOWED_PATTERNS.some(pattern => pattern.test(trimmed)) && !isForbiddenActionName(trimmed);
}

// Verified on the live Create Listing page: the draft button carries
// data-testid="upload-form-save-draft-button" (visible text "Save
// draft"); the publish button carries data-testid="upload-form-save-button"
// (visible text "Upload"). These two exact, verified ids are now the
// PRIMARY safety boundary — the extension clicks only the first, and the
// second is permanently, structurally forbidden — with the pre-existing
// text-based guard above kept as a second, independent layer (defence in
// depth: an id-based check and a wording-based check can't both be wrong
// the same way).
export const SAVE_DRAFT_BUTTON_TESTID = "upload-form-save-draft-button";
export const FORBIDDEN_PUBLISH_BUTTON_TESTID = "upload-form-save-button";

export function isForbiddenTestId(testId) {
  return testId === FORBIDDEN_PUBLISH_BUTTON_TESTID;
}

/** Throws if `testId` is the verified forbidden publish control — call this immediately before every id-based click, exactly mirroring assertNotForbiddenAction's role for the text-based guard. */
export function assertNotForbiddenTestId(testId) {
  if (isForbiddenTestId(testId)) {
    throw new Error(`SAFETY: refusing to interact with the verified forbidden publish control (data-testid="${testId}").`);
  }
}

/**
 * Finds the Save Draft control uniquely scoped to `root` by its VERIFIED
 * data-testid. Never falls back to loose text such as "Save"/"Upload" or
 * "the last button on the page" — see this module's own top comment. Two
 * independent guards run before it's ever returned as usable: the id
 * itself must not be the verified forbidden publish id (defence in depth,
 * even though the two ids are obviously already different strings), and
 * its accessible name must still pass the pre-existing text-based guard.
 */
export function resolveSaveDraftButton(root) {
  const result = resolveVerifiedField(root, { testId: SAVE_DRAFT_BUTTON_TESTID });
  if (!result.ok) return result;
  assertNotForbiddenTestId(result.element.getAttribute("data-testid"));
  assertNotForbiddenAction(getAccessibleName(result.element));
  return result;
}

// ---- Field strategies — VERIFIED against a live, signed-in session at ------
// https://www.vinted.co.uk/items/new. Every id/data-testid below was read
// directly off that page.
//
// Follow-up correction (root-scoping rewrite, affecting EVERY field below):
// the live Create Listing page has NO wrapping <form> element around ANY
// of its content — confirmed directly: `document.querySelectorAll("form")`
// returns exactly two elements, both the header's own search bar
// (action="/catalog"); neither `form[data-testid="item-upload-form"]` nor
// `main form` ever matches anything. See CREATE_LISTING_FORM_SELECTORS's
// own comment below for how this is now detected as a page-presence
// landmark rather than treated as a real scoping container.
//
// Follow-up correction (dialog-interaction rewrite): `open*` describes
// each dialog-picker field's own opening control (category/brand/size/
// condition/colour/material). Clicking it opens an INLINE dropdown panel
// (never a modal/role="dialog") whose content container carries
// `contentTestId` — verified live for every field below by actually
// opening it and reading `[data-testid]`. There is NO dedicated close
// button and NO shared save button anywhere on the real page (the
// previously-assumed `input-dropdown-save-button` does not exist) —
// confirmed empirically:
//   - category/brand/size/condition (single-select): clicking a matching
//     option immediately commits the value AND auto-closes the dropdown.
//   - colour/material (multi-select): the dropdown stays OPEN after each
//     click (so more than one option can be picked) and only closes on a
//     genuine OUTSIDE click — clicking the opener again does nothing.
// See form-steps.js's openDialogPicker/confirmDialogPicker for how this is
// actually driven, and stepSelectMultiOptions for the outside-click close.

export const VINTED_FIELD_STRATEGIES = Object.freeze({
  // Title deliberately has NO entry here — see resolveTitleInput() above,
  // the dedicated whole-document resolver for this field (verified NOT
  // reliably root-scoped, exactly like photos).
  description: { id: "description", testId: "description--input" },
  price: { id: "price", testId: "price-input--input" },
  // Photos deliberately have NO entry here — see resolvePhotoInput()
  // above, the dedicated resolver for this one always-hidden, id-less
  // field, which the generic resolveVerifiedField() path cannot handle.
  category: {
    openId: "category", openTestId: "catalog-select-dropdown-input",
    contentTestId: "catalog-select-dropdown-content",
    searchId: "catalog-search-input",
  },
  brand: {
    openId: "brand", openTestId: "brand-select-dropdown-input",
    contentTestId: "brand-select-dropdown-content",
    searchTestId: "brand-search--input",
  },
  size: {
    openId: "size", openTestId: "category-size-single-grid-input",
    contentTestId: "category-size-single-grid-content",
  },
  condition: {
    openId: "condition", openTestId: "category-condition-single-list-input",
    contentTestId: "category-condition-single-list-content",
  },
  colour: {
    openId: "color", openTestId: "color-select-dropdown-input",
    contentTestId: "color-select-dropdown-content",
  },
  material: {
    openId: "material", openTestId: "category-material-multi-list-input",
    contentTestId: "category-material-multi-list-content",
  },
});

/**
 * Follow-up correction (root-scoping rewrite) — these are no longer a
 * scoping container to query WITHIN; they are page-presence LANDMARKS.
 * findFormRoot() below returns `doc.body` (i.e. "search the whole
 * document", exactly like resolvePhotoInput/resolveTitleInput already do)
 * once any one of these is found, or `null` if none is — `null` is the
 * genuine "not on the Create Listing page" signal stepOpenForm checks for.
 * `media-upload` (the photos section) is the practical match on the real
 * page today; the other two are kept in case a future Vinted markup
 * change ever does wrap the form for real.
 */
export const CREATE_LISTING_FORM_SELECTORS = ["form[data-testid=\"item-upload-form\"]", "main form", '[data-testid="media-upload"]'];
