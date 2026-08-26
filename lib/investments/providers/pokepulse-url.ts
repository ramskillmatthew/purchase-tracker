/**
 * Pure, DB-free URL validation for a PokePulse product URL — used both by
 * the "Add investment" form (client + server) and, defensively, by the
 * PokePulse provider adapter itself right before it ever makes a network
 * call, so a URL can never reach fetch() without passing this exact check
 * twice.
 *
 * Deliberately strict: exact host match (no subdomains, no lookalikes),
 * HTTPS only, no embedded credentials, no non-standard port, and the path
 * must begin with one of the two supported product-type prefixes. The
 * validated `slug` is later used to build the app's own internal API
 * request — never the raw URL string — so nothing about the user-supplied
 * URL beyond its slug ever reaches network code.
 */
export type PokePulseUrlKind = "sealed" | "cards";
export type PokePulseUrlValidation =
  | { valid: true; kind: PokePulseUrlKind; slug: string }
  | { valid: false; error: string };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validatePokePulseUrl(rawUrl: string): PokePulseUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { valid: false, error: "Enter a valid URL." };
  }

  if (url.protocol !== "https:") return { valid: false, error: "PokePulse URLs must use https://." };
  if (url.hostname !== "pokepulse.io") return { valid: false, error: "URL must be on pokepulse.io." };
  if (url.port !== "") return { valid: false, error: "PokePulse URLs must not specify a port." };
  if (url.username || url.password) return { valid: false, error: "PokePulse URLs must not include credentials." };

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return { valid: false, error: "URL path must begin with /sealed/ or /cards/ and end with a single product slug." };
  const [prefix, slug] = segments;
  if (prefix !== "sealed" && prefix !== "cards") return { valid: false, error: "URL path must begin with /sealed/ or /cards/." };
  if (!SLUG_PATTERN.test(slug)) return { valid: false, error: "URL does not look like a real PokePulse product link." };

  return { valid: true, kind: prefix, slug };
}
