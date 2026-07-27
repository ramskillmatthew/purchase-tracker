function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase environment variables are not configured.");
  return { url, key };
}

export async function supabaseRequest(path: string, init?: RequestInit) {
  const { url, key } = config();
  const headers = new Headers(init?.headers);
  headers.set("apikey", key);
  headers.set("Content-Type", "application/json");
  if (!key.startsWith("sb_secret_")) headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const error = new Error((await response.text()) || "Database request failed.") as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response;
}

// PostgREST silently caps any request that doesn't specify a Range to its
// configured db-max-rows (confirmed 1000 in this project — that's exactly
// what previously made the app believe purchases/expenses tables topped
// out at 1000 rows). This page size intentionally matches that confirmed
// cap: each windowed request stays at or under whatever db-max-rows is
// configured to, so no single page is ever itself silently truncated.
const DEFAULT_PAGE_SIZE = 1000;
// Purely a defensive infinite-loop guard — this app's real tables are in
// the low thousands of rows, so 500 pages (500,000+ rows at the default
// page size) is never expected to be reached in practice.
const DEFAULT_MAX_PAGES = 500;

/**
 * Parses a PostgREST `Content-Range` response header — either a known
 * total (e.g. "0-999/1798"), an unknown total (a wildcard total, e.g.
 * "0-999" followed by an asterisk), or a wildcard range meaning no rows
 * matched at all. Returns null if the header is missing or unparseable —
 * callers must treat that as "no authoritative signal available", never
 * as "zero rows".
 */
function parseContentRange(header: string): { end: number; total: number | null } | null {
  const slash = header.lastIndexOf("/");
  if (slash === -1) return null;
  const range = header.slice(0, slash);
  const totalRaw = header.slice(slash + 1);
  const total = totalRaw === "*" ? null : Number(totalRaw);
  if (totalRaw !== "*" && !Number.isFinite(total)) return null;
  if (range === "*") return { end: -1, total };
  const dash = range.lastIndexOf("-");
  if (dash === -1) return null;
  const end = Number(range.slice(dash + 1));
  if (!Number.isFinite(end)) return null;
  return { end, total };
}

/**
 * Loads every row matching `path` by paginating through PostgREST's Range
 * header (0-indexed, inclusive) rather than trusting a single response to
 * contain the whole table. `path` must already include an explicit
 * `order=` — without one, row order (and therefore correctness across
 * page boundaries) is not guaranteed by PostgREST. Filters and `select=`
 * are preserved automatically since `path` is reused unchanged on every
 * page.
 *
 * Requests `Prefer: count=exact` so PostgREST reports the table's true
 * matching row count in `Content-Range` (e.g. "0-999/1798"). That total is
 * the authoritative stop condition: pagination continues until the number
 * of rows actually collected reaches it, and the next page's start is
 * anchored on the server's own reported end position — never on our own
 * page-size arithmetic. This means a page that comes back shorter than
 * requested (for example because the server enforces its own row cap
 * below the size we asked for) can never be misread as "the end of the
 * table" while the total says otherwise; we simply keep requesting more
 * pages until every row the count promised has actually been collected.
 *
 * Only when no usable total is available (Content-Range missing, or its
 * total is "*") does this fall back to the weaker "a short page means the
 * end of the table" heuristic — still safe for a normal, well-behaved
 * PostgREST/Supabase response, just not as precise.
 *
 * If any page request fails, or the defensive maxPages ceiling is hit,
 * this throws rather than returning whatever was accumulated so far —
 * callers must never receive a silently partial dataset.
 */
export async function supabaseRequestAll<T>(path: string, options?: { pageSize?: number; maxPages?: number }): Promise<T[]> {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  const results: T[] = [];
  let from = 0;
  let knownTotal: number | null = null;

  for (let page = 0; page < maxPages; page++) {
    const to = from + pageSize - 1;
    const response = await supabaseRequest(path, { headers: { Range: `${from}-${to}`, Prefer: "count=exact" } });
    const rows = (await response.json()) as T[];
    results.push(...rows);

    const parsed = parseContentRange(response.headers.get("Content-Range") ?? "");
    if (parsed?.total !== null && parsed?.total !== undefined) knownTotal = parsed.total;
    const nextFrom = (parsed && parsed.end >= 0 ? parsed.end : from + rows.length - 1) + 1;

    if (knownTotal !== null) {
      if (results.length >= knownTotal) return results;
      from = nextFrom;
      continue;
    }

    if (rows.length < pageSize) return results;
    from = nextFrom;
  }
  throw new Error(`Exceeded the maximum page count (${maxPages}) while loading "${path.split("?")[0]}" — the table may be larger than expected.`);
}
