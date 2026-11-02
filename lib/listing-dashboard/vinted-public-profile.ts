export type VintedAccountSlot = 1 | 2 | 3;
export type VintedAccountNumber = number;

export type SavedVintedAccount = {
  slot: VintedAccountSlot;
  number: VintedAccountNumber;
  profileUrl: string;
  profileId: string;
  username: string | null;
};

export type PublicVintedListing = {
  id: string;
  title: string;
  url: string;
  photoUrl: string | null;
  pricePence: number | null;
  currency: string | null;
  favouriteCount: number;
};

type WardrobePayload = {
  items?: Array<{
    id?: number | string;
    title?: string;
    url?: string;
    photos?: Array<{ url?: string; isMain?: boolean }>;
    thumbnailUrl?: string | null;
    favouriteCount?: number;
    price?: { amount?: string; currencyCode?: string };
  }>;
  pagination?: {
    currentPage?: number;
    totalPages?: number;
    totalEntries?: number;
    perPage?: number;
  };
};

type WardrobeApiPayload = {
  items?: Array<{
    id?: number | string;
    title?: string;
    path?: string;
    url?: string;
    photos?: Array<{ url?: string; is_main?: boolean }>;
    thumbnail_url?: string | null;
    favourite_count?: number;
    price?: { amount?: string; currency_code?: string };
  }>;
  pagination?: {
    current_page?: number;
    total_pages?: number;
    total_entries?: number;
    per_page?: number;
  };
};

const PROFILE_HOSTS = new Set(["vinted.co.uk", "www.vinted.co.uk"]);
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

export function normaliseVintedProfileUrl(value: string, slot: VintedAccountSlot, number: VintedAccountNumber = slot): SavedVintedAccount {
  if (!Number.isInteger(number) || number < 1 || number > 9999) {
    throw new Error(`Vinted slot ${slot} needs an account number between 1 and 9999.`);
  }
  const input = value.trim();
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error(`Vinted #${number} needs a full profile link.`); }
  if (url.protocol !== "https:" || !PROFILE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Vinted #${number} must use a vinted.co.uk profile link.`);
  }
  const match = url.pathname.match(/^\/member\/(\d+)(?:-([^/?#]+))?\/?$/i);
  if (!match) throw new Error(`Vinted #${number} is not a valid public profile link.`);
  const profileId = match[1];
  const username = match[2] ? decodeURIComponent(match[2]).replace(/-/g, " ").trim() || null : null;
  return {
    slot,
    number,
    profileUrl: `https://www.vinted.co.uk/member/${profileId}${match[2] ? `-${match[2]}` : ""}`,
    profileId,
    username,
  };
}

function extractBalancedJson(source: string, start: number): string | null {
  const opener = source[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!closer) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function flightPayload(html: string): string {
  const chunks: string[] = [];
  const pattern = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]) as unknown;
      if (Array.isArray(value) && typeof value[1] === "string") chunks.push(value[1]);
    } catch { /* A non-flight script is irrelevant to the wardrobe payload. */ }
  }
  return chunks.join("\n");
}

export function parseVintedProfilePage(html: string): { listings: PublicVintedListing[]; currentPage: number; totalPages: number; totalEntries: number } {
  const payload = flightPayload(html);
  const marker = '"initialWardrobeItems":';
  const markerIndex = payload.indexOf(marker);
  if (markerIndex < 0) {
    if (/challenge-platform|Enable JavaScript and cookies to continue|Please wait/i.test(html)) {
      throw new Error("Vinted temporarily asked for a browser check. Please try Refresh listings again shortly.");
    }
    throw new Error("Vinted did not return the public listings for this profile.");
  }
  const objectStart = payload.indexOf("{", markerIndex + marker.length);
  const json = objectStart >= 0 ? extractBalancedJson(payload, objectStart) : null;
  if (!json) throw new Error("Vinted returned an unreadable public listings response.");
  let wardrobe: WardrobePayload;
  try { wardrobe = JSON.parse(json) as WardrobePayload; }
  catch { throw new Error("Vinted returned an unreadable public listings response."); }
  const listings = (wardrobe.items ?? []).flatMap(item => {
    const id = item.id === undefined ? "" : String(item.id);
    const title = item.title?.trim() ?? "";
    const url = item.url?.trim() ?? "";
    if (!/^\d+$/.test(id) || !title || !/^https:\/\/www\.vinted\.co\.uk\/items\/\d+/i.test(url)) return [];
    const amount = Number(item.price?.amount);
    return [{
      id,
      title,
      url,
      photoUrl: item.photos?.find(photo => photo.isMain)?.url ?? item.photos?.[0]?.url ?? item.thumbnailUrl ?? null,
      pricePence: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      currency: item.price?.currencyCode ?? null,
      favouriteCount: Number.isFinite(item.favouriteCount) ? Math.max(0, Math.trunc(item.favouriteCount ?? 0)) : 0,
    }];
  });
  return {
    listings,
    currentPage: wardrobe.pagination?.currentPage ?? 1,
    totalPages: Math.max(1, Math.min(100, wardrobe.pagination?.totalPages ?? 1)),
    totalEntries: Math.max(listings.length, wardrobe.pagination?.totalEntries ?? listings.length),
  };
}

export function parseVintedWardrobeApi(payload: WardrobeApiPayload): { listings: PublicVintedListing[]; currentPage: number; totalPages: number; totalEntries: number } {
  const listings = (payload.items ?? []).flatMap(item => {
    const id = item.id === undefined ? "" : String(item.id);
    const title = item.title?.trim() ?? "";
    const path = item.path?.trim() || item.url?.trim() || "";
    const url = path.startsWith("/") ? `https://www.vinted.co.uk${path}` : path;
    if (!/^\d+$/.test(id) || !title || !/^https:\/\/www\.vinted\.co\.uk\/items\/\d+/i.test(url)) return [];
    const amount = Number(item.price?.amount);
    return [{
      id,
      title,
      url,
      photoUrl: item.photos?.find(photo => photo.is_main)?.url ?? item.photos?.[0]?.url ?? item.thumbnail_url ?? null,
      pricePence: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      currency: item.price?.currency_code ?? null,
      favouriteCount: Number.isFinite(item.favourite_count) ? Math.max(0, Math.trunc(item.favourite_count ?? 0)) : 0,
    }];
  });
  return {
    listings,
    currentPage: payload.pagination?.current_page ?? 1,
    totalPages: Math.max(1, Math.min(100, payload.pagination?.total_pages ?? 1)),
    totalEntries: Math.max(listings.length, payload.pagination?.total_entries ?? listings.length),
  };
}

function responseCookieJar(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const combined = response.headers.get("set-cookie") ?? "";
  const setCookies = headers.getSetCookie?.() ?? combined.split(/,(?=[^;,]+=)/g);
  const jar = new Map<string, string>();
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0]?.trim();
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) continue;
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function fetchFirstPage(account: SavedVintedAccount) {
  const response = await fetch(account.profileUrl, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: BROWSER_HEADERS,
  });
  if (!response.ok) throw new Error(`Vinted #${account.number} could not be read (${response.status}).`);
  const jar = responseCookieJar(response);
  return { result: parseVintedProfilePage(await response.text()), jar };
}

async function fetchWardrobePage(account: SavedVintedAccount, page: number, jar: Map<string, string>) {
  const url = new URL(`/api/v2/wardrobe/${account.profileId}/items`, "https://www.vinted.co.uk");
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", "20");
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json,text/plain,*/*,image/webp",
      Locale: "en-GB",
      Referer: account.profileUrl,
      Cookie: cookieHeader(jar),
      ...(jar.get("anon_id") ? { "X-Anon-Id": jar.get("anon_id")! } : {}),
    },
  });
  if (!response.ok) throw new Error(`Vinted #${account.number} could not load page ${page} (${response.status}).`);
  let payload: WardrobeApiPayload;
  try { payload = await response.json() as WardrobeApiPayload; }
  catch { throw new Error(`Vinted #${account.number} returned an unreadable page ${page}.`); }
  return parseVintedWardrobeApi(payload);
}

export async function fetchAllVintedProfileListings(account: SavedVintedAccount): Promise<PublicVintedListing[]> {
  const { result: first, jar } = await fetchFirstPage(account);
  const pages = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, index) => index + 2);
  const rest: PublicVintedListing[] = [];
  for (let offset = 0; offset < pages.length; offset += 4) {
    const batch = await Promise.all(pages.slice(offset, offset + 4).map(page => fetchWardrobePage(account, page, jar)));
    rest.push(...batch.flatMap(result => result.listings));
  }
  const unique = new Map<string, PublicVintedListing>();
  for (const listing of [...first.listings, ...rest]) unique.set(listing.id, listing);
  return [...unique.values()];
}
