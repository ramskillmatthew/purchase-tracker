/**
 * Corrective pass (failed first eBay draft) — safe parsing of eBay's own
 * structured error response shape (a top-level `errors: [...]` array,
 * each entry carrying `errorId`, `domain`, `category`, `message`,
 * `longMessage`, and an optional `parameters` list of the offending
 * field name/value pairs). The root cause of the first failed draft
 * ("Invalid request", with no further detail ever persisted) was that
 * lib/ebay-account/inventory-client.ts's old inventoryError() kept only
 * the short `message` field — which eBay itself documents as a generic,
 * category-level summary — and discarded everything else, including the
 * `longMessage` that would have said something like "condition must be a
 * supported ConditionEnum value" instead.
 *
 * Everything here is a pure function over an already-parsed JSON body —
 * never touches a token, header, or the raw request. Every returned
 * string is length-bounded and scanned for secret-shaped substrings
 * before being returned, so this stays safe to log or persist even though
 * it originates from a remote response this app doesn't fully control.
 */

const MAX_FIELD_LENGTH = 300;
const MAX_ERRORS = 3;
const MAX_PARAMETERS = 6;

/** Deliberately broad — long opaque alphanumeric runs (the shape of an
 * OAuth token, an eBay `v^1.1#...` token prefix, or a bearer header) are
 * redacted wherever they appear, even inside a field eBay itself would
 * never legitimately put one in. Defence in depth, not a claim that eBay
 * error bodies normally contain secrets. */
const SECRET_LIKE_PATTERN = /bearer\s+\S+|v\^1\.1#\S+|[a-z0-9_-]{40,}/i;

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const bounded = value.slice(0, MAX_FIELD_LENGTH);
  return SECRET_LIKE_PATTERN.test(bounded) ? "[redacted]" : bounded;
}

export type SanitizedEbayError = {
  errorId: number | null;
  domain: string | null;
  category: string | null;
  message: string | null;
  longMessage: string | null;
  parameters: Array<{ name: string; value: string }>;
};

/** Parses only the allowlisted properties of eBay's error envelope —
 * anything else present on the response body (there is never a legitimate
 * reason for one, but this is defensive) is silently ignored, never
 * stored, never logged. */
export function parseEbayErrors(body: unknown): SanitizedEbayError[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, MAX_ERRORS).map(raw => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const rawParameters = Array.isArray(e.parameters) ? e.parameters : [];
    const parameters = rawParameters.slice(0, MAX_PARAMETERS).map(p => {
      const param = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      return { name: sanitizeText(param.name) ?? "", value: sanitizeText(param.value) ?? "" };
    }).filter(p => p.name || p.value);
    const errorId = typeof e.errorId === "number" ? e.errorId : (typeof e.errorId === "string" && /^\d+$/.test(e.errorId) ? Number(e.errorId) : null);
    return {
      errorId,
      domain: sanitizeText(e.domain),
      category: sanitizeText(e.category),
      message: sanitizeText(e.message),
      longMessage: sanitizeText(e.longMessage),
      parameters,
    };
  });
}

/** Concise, actionable, user-facing text — prefers the DETAILED
 * longMessage over the generic top-level message (this is the exact
 * improvement over the old behaviour), appends the offending field name
 * when eBay identified one, and always falls back to the caller's own
 * generic fallback if nothing structured could be parsed at all (a
 * non-JSON body, an empty body, or a genuinely empty errors array). Never
 * returns raw JSON. */
export function formatEbayErrorForUser(errors: SanitizedEbayError[], fallback: string): string {
  const primary = errors[0];
  if (!primary) return fallback;
  const text = primary.longMessage ?? primary.message ?? fallback;
  const field = primary.parameters.find(p => p.name)?.name;
  const withField = field ? `${text} (field: ${field})` : text;
  return withField.slice(0, MAX_FIELD_LENGTH);
}
