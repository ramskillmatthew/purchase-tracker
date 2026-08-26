// Vinted Draft Queue extension — lightweight, dependency-free defensive
// validation of data received from the app. The APP remains the source of
// truth and authoritatively validates with zod server-side (see
// lib/listing-studio/extension-batch-schema.ts) — this is a second,
// independent, much simpler check on THIS side so a malformed/unexpected
// payload is rejected before the extension ever touches the DOM with it,
// never silently "best-effort" processed. No external validation library
// is used here deliberately — this extension ships no bundler/build step,
// so every dependency has to be hand-written or absent.

const MAX_BATCH_LISTINGS = 5;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isString(value) {
  return typeof value === "string";
}
function isPositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isStringArray(value) {
  return Array.isArray(value) && value.every(isString);
}

// Follow-up correction (photo origin-mismatch bug): `photo.path` is now a
// RELATIVE reference (e.g. "/api/extension/batch/photos/<uuid>/0"), never
// an absolute URL — the extension resolves it against its OWN configured
// App URL (see service-worker.js's resolvePhotoUrl), which independently
// re-validates the exact route shape/origin before ever fetching it. This
// check is only the same lightweight "is it a non-empty string" shape
// check every other field here gets — the real security validation lives
// in resolvePhotoUrl, not here.
export function validatePhoto(photo) {
  const errors = [];
  if (!photo || typeof photo !== "object") return ["Photo is not an object."];
  if (!isNonNegativeInt(photo.position)) errors.push("photo.position must be a non-negative integer.");
  if (!isNonEmptyString(photo.path)) errors.push("photo.path must be a non-empty string.");
  if (!isNonEmptyString(photo.fileName)) errors.push("photo.fileName must be a non-empty string.");
  return errors;
}

/** Returns an array of error strings — empty means valid. Mirrors the server's own required-field shape exactly (see extension-batch-schema.ts's extensionBatchItemSchema), field for field. */
export function validateBatchItem(item) {
  const errors = [];
  if (!item || typeof item !== "object") return ["Item is not an object."];
  if (!isNonEmptyString(item.itemId)) errors.push("itemId is required.");
  if (!isNonEmptyString(item.draftId)) errors.push("draftId is required.");
  if (!isNonNegativeInt(item.queuePosition)) errors.push("queuePosition must be a non-negative integer.");
  if (item.sku !== null && !isString(item.sku)) errors.push("sku must be a string or null.");
  if (!isNonEmptyString(item.title)) errors.push("title is required.");
  if (!isNonEmptyString(item.description)) errors.push("description is required.");
  if (!isNonEmptyString(item.brand)) errors.push("brand is required.");
  if (item.model !== null && !isString(item.model)) errors.push("model must be a string or null.");
  if (!isNonEmptyString(item.productType)) errors.push("productType is required.");
  if (!isNonEmptyString(item.condition)) errors.push("condition is required.");
  if (item.ukSize !== null && !isString(item.ukSize)) errors.push("ukSize must be a string or null.");
  if (!isNonEmptyString(item.audience)) errors.push("audience is required.");
  if (!isStringArray(item.colours)) errors.push("colours must be an array of strings.");
  if (!isStringArray(item.materials)) errors.push("materials must be an array of strings.");
  if (!isPositiveInt(item.pricePence)) errors.push("pricePence must be a positive integer.");
  if (!isNonEmptyString(item.priceDisplay)) errors.push("priceDisplay is required.");
  if (!isPositiveInt(item.vintedCategoryId)) errors.push("vintedCategoryId must be a positive integer.");
  if (!isNonEmptyString(item.vintedCategoryPath)) errors.push("vintedCategoryPath is required.");
  if (!Array.isArray(item.photos) || item.photos.length === 0) errors.push("photos must be a non-empty array.");
  else for (const photo of item.photos) errors.push(...validatePhoto(photo).map(e => `photos: ${e}`));
  if (!isNonNegativeInt(item.coverPhotoPosition)) errors.push("coverPhotoPosition must be a non-negative integer.");
  return errors;
}

/** Returns { valid: true, errors: [] } or { valid: false, errors: [...] } — never throws, never partially trusts a malformed payload. */
export function validateBatchPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { valid: false, errors: ["Payload is not an object."] };
  if (!isNonEmptyString(payload.batchId)) errors.push("batchId is required.");
  if (!isNonEmptyString(payload.expiresAt)) errors.push("expiresAt is required.");
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    errors.push("items must be a non-empty array.");
  } else {
    if (payload.items.length > MAX_BATCH_LISTINGS) errors.push(`items exceeds the maximum of ${MAX_BATCH_LISTINGS}.`);
    for (const item of payload.items) errors.push(...validateBatchItem(item));
  }
  return { valid: errors.length === 0, errors };
}

export function isValidPairingCodeShape(code) {
  return typeof code === "string" && /^[A-Z0-9]{4,32}$/i.test(code.trim());
}
