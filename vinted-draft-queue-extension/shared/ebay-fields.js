// eBay Seller Hub extension drafter — DOM query framework + eBay Seller
// Hub field strategies for the Complete-your-listing form
// (https://www.ebay.co.uk/lstng?draftId=...&mode=AddItem).
//
// The accessible-name / role / visibility / safety-guard PRIMITIVES below
// (getAccessibleName, isVisible, findByRole, requireUnique,
// assertValidInteractionTarget, the forbidden-action guard) are a direct
// port of vinted-fields.js's own equivalents — genuinely marketplace-
// agnostic DOM utilities, duplicated here (not imported) so this module has
// zero dependency on the Vinted one, matching this feature's own "do not
// let eBay messages enter the Vinted processing path" separation
// requirement extended to shared code too.
//
// EBAY_FIELD_STRATEGIES below is VERIFIED against a live, signed-in
// session at https://www.ebay.co.uk/lstng (a real "On Running Cloud 5
// running trainers" listing, Trainers category, UK, this session) — every
// `name` attribute was read directly off that page's real form controls.
// What is NOT yet verified: category selection and the Save-Draft-adjacent
// "Save for later" control's own full behaviour (this milestone never
// clicks it), and every item-specific field OTHER than UK Shoe Size
// (confirmed pill-button) and Brand (confirmed search-box) — the others
// are assumed to follow one of those same two patterns based on their
// shared "search-box-attributes*" naming, but each one's own real
// behaviour was not individually clicked and confirmed. If a future live
// check finds a value here no longer matches, update ONLY the affected
// entry — the framework functions below are stable and shouldn't need to
// change alongside it.

// ---- Accessible-name / role utilities (ported from vinted-fields.js) ------

const ROLE_SELECTORS = {
  button: 'button, [role="button"], input[type="submit"]',
  textbox: 'input[type="text"], input[type="number"], input:not([type]), textarea, [role="textbox"]',
  combobox: 'select, [role="combobox"], [role="listbox"], button[aria-haspopup="listbox"]',
  option: '[role="option"], li[role="option"]',
  fileInput: 'input[type="file"]',
};

const ACCESSIBLE_NAME_MAX_LENGTH = 300;
function boundedText(text) {
  return text.length > ACCESSIBLE_NAME_MAX_LENGTH ? `${text.slice(0, ACCESSIBLE_NAME_MAX_LENGTH)}…` : text;
}

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

const INVALID_INTERACTION_TARGET_TAGS = new Set(["HTML", "BODY"]);

export function isInvalidInteractionTarget(element) {
  if (!element || typeof element !== "object" || !element.tagName) return true;
  const doc = element.ownerDocument;
  if (doc && (element === doc.documentElement || element === doc.body)) return true;
  if (INVALID_INTERACTION_TARGET_TAGS.has(element.tagName)) return true;
  return false;
}

export function assertValidInteractionTarget(element, stepName = "unknown") {
  if (isInvalidInteractionTarget(element)) {
    const tag = element && element.tagName ? element.tagName : String(element);
    throw new Error(`INVALID_INTERACTION_TARGET: step=${stepName} tag=${tag}`);
  }
}

const NEVER_VISIBLE_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

export function isVisible(element) {
  if (!element || typeof element.nodeType !== "number") return false;
  if (NEVER_VISIBLE_TAGS.has(element.tagName)) return false;
  const doc = element.ownerDocument;
  if (!doc || !doc.contains(element)) return false;

  const view = doc.defaultView;
  const getStyle = view?.getComputedStyle ? node => view.getComputedStyle(node) : () => null;

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

export function requireUnique(elements, description) {
  if (!elements || elements.length === 0) return { ok: false, reason: `NOT_FOUND: ${description}` };
  if (elements.length > 1) return { ok: false, reason: `AMBIGUOUS: ${description} (${elements.length} matches)` };
  return { ok: true, element: elements[0] };
}

/** Resolves a field by its VERIFIED `name` attribute — the primary contract this form actually exposes (see this file's own top comment; unlike Vinted's id/data-testid pairs, eBay's Seller Hub consistently names its real form inputs). Searches the WHOLE document, never scoped to a form root — this page has no single wrapping <form> landmark verified yet either. */
export function resolveByName(doc, name) {
  const matches = Array.from(doc.querySelectorAll(`[name="${cssEscape(name)}"]`));
  return requireUnique(matches, `name="${name}"`);
}

// ---- Absolute publishing-safety guard --------------------------------------
//
// CRITICAL LIVE FINDING (Phase 2 inspection): eBay UK Seller Hub's real
// publish control reads "List it for free" — NOT "List item". A forbidden-
// pattern list ported verbatim from Vinted's own (which matches
// /\blist\s*item\b/i) would NOT have matched this real button text. This
// list is independently verified against the real page, not merely copied.

const FORBIDDEN_ACTION_PATTERNS = [
  /\blist\s*it\b/i, // "List it for free" — the VERIFIED real eBay UK publish button text
  /\bpublish\b/i,
  /\blist\s*item\b/i, // kept as defence in depth — eBay wording has changed before and may again
  /\bupload\b/i,
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

export function assertNotForbiddenAction(accessibleName) {
  if (isForbiddenActionName(accessibleName)) {
    throw new Error(`SAFETY: refusing to interact with a control whose accessible name matches a forbidden publishing action: "${boundedText(accessibleName || "")}"`);
  }
}

export function safeClick(element, stepName = "unknown") {
  assertValidInteractionTarget(element, stepName);
  assertNotForbiddenAction(getAccessibleName(element));
  element.click();
}

// VERIFIED live: the "Save for later" button (this form's own draft-save
// control — eBay's wording, not "Save draft"). Structurally disjoint from
// every FORBIDDEN_ACTION_PATTERNS entry above (none of them match "save
// for later"). NOT clicked anywhere in this milestone's own code (Phase 6:
// "For the initial milestone, do not click Save draft either") — resolved
// and exported ONLY so a future milestone has a single, already-verified
// place to wire it up, and so a test can prove this exact control is never
// referenced by any click path today.
const SAVE_FOR_LATER_ALLOWED_PATTERN = /^save for later$/i;
export function isAllowedSaveForLaterName(accessibleName) {
  if (!accessibleName) return false;
  return SAVE_FOR_LATER_ALLOWED_PATTERN.test(accessibleName.trim()) && !isForbiddenActionName(accessibleName);
}

// ---- Field strategies — VERIFIED against a live, signed-in session at -----
// https://www.ebay.co.uk/lstng?draftId=...&mode=AddItem

export const EBAY_FIELD_STRATEGIES = Object.freeze({
  title: { name: "title" },
  description: { name: "description" }, // a <textarea>, the rich-text editor's own "raw" backing field — confirmed settable via the same native-value technique as every other text field
  price: { name: "price" },
  quantity: { name: "quantity" },
  // The Custom label (SKU) field is HIDDEN until its own toggle is switched
  // on — verified live: unchecked by default, `name="customLabelPref"`
  // (checkbox) reveals `name="customLabel"` (text input) once checked.
  skuToggle: { name: "customLabelPref" },
  sku: { name: "customLabel" },
  conditionDescription: { name: "itemConditionDescription" },
  fulfillmentPolicy: { name: "shippingPolicyId" }, // a custom combobox (text input), NOT a native <select> — verified live
  paymentPolicy: { name: "paymentPolicyId" },
});

// Item-specific field name prefix — VERIFIED live: eBay's Seller Hub names
// every item-specific search-box input "search-box-attributes<Field Name>"
// (no separator) or "search-box-attributes.<Field Name>" (with a literal
// dot) inconsistently — both forms were observed on the SAME real page
// (e.g. "search-box-attributesBrand" vs "search-box-attributes.UK Shoe
// Size"). Both variants are tried, in order, so a caller never has to
// guess which one a given specific's name happens to use.
export function resolveItemSpecificSearchBox(doc, specificName) {
  const withoutDot = resolveByName(doc, `search-box-attributes${specificName}`);
  if (withoutDot.ok) return withoutDot;
  const withDot = resolveByName(doc, `search-box-attributes.${specificName}`);
  if (withDot.ok) return withDot;
  return { ok: false, reason: `NOT_FOUND: item specific search box for "${specificName}" (tried both search-box-attributes${specificName} and search-box-attributes.${specificName})` };
}

// UK Shoe Size — VERIFIED live: a pill/toggle-button group, NOT the
// search-box. Clicking a pill sets aria-pressed="true" and adds class
// "toggle-button-pressed" — this, not the search-box's own (empty) value,
// is the real confirmation signal. Other single-fixed-value item specifics
// (e.g. Department) are ASSUMED (not individually verified — see this
// file's own top comment) to follow the same pattern; resolveItemSpecificPillButton
// is the shared helper either way, and a field simply fails closed
// (NOT_FOUND) if the real page turns out not to render it as a pill group.
export function resolveItemSpecificPillButton(doc, sectionHeadingText, optionText) {
  const heading = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6,legend,label,span,div"))
    .find(el => el.children.length === 0 && (el.textContent || "").trim() === sectionHeadingText && isVisible(el));
  if (!heading) return { ok: false, reason: `NOT_FOUND: item specific section heading "${sectionHeadingText}"` };
  // The pill group lives in the section immediately following its own
  // heading — scoped to a bounded ancestor (never the whole document) so a
  // same-text pill belonging to a DIFFERENT field can never match.
  const scope = heading.closest("section, fieldset, div[class]")?.parentElement ?? doc.body;
  const buttons = findByRole(scope, "button", { name: optionText });
  return requireUnique(buttons, `item specific option "${optionText}" under "${sectionHeadingText}"`);
}

export function isPillButtonPressed(element) {
  return element.getAttribute("aria-pressed") === "true" || element.classList.contains("toggle-button-pressed");
}

// The verified hidden photo input — VERIFIED live:
// `<input type="file" id="fehelix-uploader" multiple accept="image/*,image/heic,image/heif,video/mp4,video/quicktime">`,
// no `name` attribute. Mirrors vinted-fields.js's resolvePhotoInput's own
// reasoning: an always-hidden input a visible "Upload from computer"
// button activates — zero size/hidden is its NORMAL state, never a sign
// it's missing.
const PHOTO_INPUT_ID = "fehelix-uploader";
export function resolvePhotoInput(doc) {
  const el = doc.getElementById(PHOTO_INPUT_ID);
  if (!el) return { ok: false, reason: `NOT_FOUND: the verified hidden photo input (#${PHOTO_INPUT_ID})` };
  const view = doc.defaultView;
  if (view && !(el instanceof view.HTMLInputElement)) return { ok: false, reason: `NOT_FOUND: #${PHOTO_INPUT_ID} is not a file input` };
  if (el.type !== "file" || el.disabled) return { ok: false, reason: `NOT_FOUND: #${PHOTO_INPUT_ID} is not an enabled file input` };
  return { ok: true, element: el };
}

// eBay auto-creates a real numeric draftId as soon as the Complete-your-
// listing form is reached (VERIFIED live: visible in the URL itself,
// ?draftId=<digits>) — this is a page-presence landmark for "we are on the
// real Seller Hub create-listing form", not something this extension ever
// creates or relies on for its own identity (its own operation id is
// always the app's own itemId — see shared/ebay-queue-state.js).
export const SELLER_HUB_LISTING_FORM_PATTERN = /^\/lstng$/;
export function isOnSellerHubListingForm(location) {
  return SELLER_HUB_LISTING_FORM_PATTERN.test(location.pathname) && /(?:^|[?&])draftId=\d+/.test(location.search);
}
