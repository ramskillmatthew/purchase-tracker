import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pokePulseProvider, resolvePokePulseIdentity } from "@/lib/investments/providers/pokepulse";

afterEach(() => { vi.restoreAllMocks(); });

// Real, live-captured response shapes (see this feature's own inspection
// report) — not invented. Trimmed to the fields this adapter actually
// reads, so a fixture change here always reflects a genuine, deliberate
// re-verification against the real site, never an accidental drift.
const REAL_CARD_LOOKUP_RESPONSE = {
  cards: [{
    id: 13908070, product_id: "card:me2pt5|284/217|Holo|null|null|null", card_name: "Mega Gengar ex",
    card_number: "284/217", image_url: "https://pokepulse-static.s3.eu-west-2.amazonaws.com/cards/images/ASC/Mega_Gengar_ex_284_217.webp",
    slug: "mega-gengar-ex-284-217-holo",
  }],
};
const REAL_SEALED_LOOKUP_RESPONSE = {
  sealedProducts: [{
    id: 3680, name: "Celestial Storm Booster Box", image_url: "https://pokepulse-static.s3.eu-west-2.amazonaws.com/Products/celestial-storm-booster-box.webp",
    slug: "celestial-storm-booster-box", product_id: "sealed:sm7|Celestial Storm Booster Box",
  }],
};
const REAL_MARKET_DATA_RESPONSE = {
  "card:me2pt5|284/217|Holo|null|null|null": [
    { type: "market_price", value: "691.2", currency: "GBP", aggregation_date: "2026-08-12T00:00:00.000Z", condition: "nm" },
  ],
};
const REAL_TIMESERIES_RESPONSE = {
  "card:me2pt5|284/217|Holo|null|null|null": {
    productId: "card:me2pt5|284/217|Holo|null|null|null",
    metrics: { market_price: { dataPoints: [
      { date: "2026-05-14", value: 997.21 },
      { date: "2026-05-17", value: 1045.68 },
    ] } },
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("PokePulse provider — identity resolution", () => {
  it("resolves a real /cards/ URL to its productId/name/image via the cards lookup endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_CARD_LOOKUP_RESPONSE));
    const result = await resolvePokePulseIdentity("https://pokepulse.io/cards/mega-gengar-ex-284-217-holo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productId).toBe("card:me2pt5|284/217|Holo|null|null|null");
      expect(result.data.name).toBe("Mega Gengar ex");
      expect(result.data.kind).toBe("cards");
    }
    expect(fetchSpy).toHaveBeenCalledWith("https://pokepulse.io/api/catalogue/cards/lookup", expect.objectContaining({ method: "POST" }));
  });

  it("resolves a real /sealed/ URL to its productId/name/image via the sealed lookup endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_SEALED_LOOKUP_RESPONSE));
    const result = await resolvePokePulseIdentity("https://pokepulse.io/sealed/celestial-storm-booster-box");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productId).toBe("sealed:sm7|Celestial Storm Booster Box");
      expect(result.data.kind).toBe("sealed");
    }
  });

  it("rejects an invalid URL before ever calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await resolvePokePulseIdentity("https://evil.com/cards/foo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("REGRESSION (SSRF/redirect protection): a redirect response is treated as a hard failure, never followed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }));
    const result = await resolvePokePulseIdentity("https://pokepulse.io/cards/mega-gengar-ex-284-217-holo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/redirect/i);
  });

  it("REGRESSION: uses redirect:'manual' so the fetch itself is instructed to never auto-follow", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_CARD_LOOKUP_RESPONSE));
    await resolvePokePulseIdentity("https://pokepulse.io/cards/mega-gengar-ex-284-217-holo");
    expect(fetchSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "manual" }));
  });

  it("REGRESSION: enforces a response-size ceiling via content-length", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(REAL_CARD_LOOKUP_RESPONSE), {
      status: 200, headers: { "content-length": String(3_000_000) },
    }));
    const result = await resolvePokePulseIdentity("https://pokepulse.io/cards/mega-gengar-ex-284-217-holo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/size limit/i);
  });

  it("a confirmed variant mismatch (no matching entry in the response) is a non-retryable failure — retrying an identical request cannot resolve a genuine mapping mismatch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ cards: [] }));
    const result = await resolvePokePulseIdentity("https://pokepulse.io/cards/does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.retryable).toBe(false); expect(result.code).toBe("variant_not_found"); }
  });

  it("a network error is surfaced as a retryable failure, never thrown", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await resolvePokePulseIdentity("https://pokepulse.io/cards/mega-gengar-ex-284-217-holo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("never sends any purchase-tracker/Supabase credential header to PokePulse", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_CARD_LOOKUP_RESPONSE));
    await resolvePokePulseIdentity("https://pokepulse.io/cards/mega-gengar-ex-284-217-holo");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("apikey")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });
});

describe("PokePulse provider — pricing", () => {
  const PRODUCT_ID = "card:me2pt5|284/217|Holo|null|null|null";

  it("isConfigured() is always true — no credentials/signup required", () => {
    expect(pokePulseProvider.isConfigured()).toBe(true);
  });

  it("uses the market_price entry EXACTLY as returned, in GBP", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_MARKET_DATA_RESPONSE));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.nativeUnitPrice).toBe(691.2);
      expect(result.data.nativeCurrency).toBe("GBP");
      expect(result.data.provider).toBe("pokepulse");
    }
  });

  it("REGRESSION: never fabricates a currency conversion — a non-GBP market_price entry is rejected rather than used as-is", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: "800", currency: "USD", aggregation_date: "2026-08-12T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
  });

  it("REGRESSION: on failure, returns a retryable failed result — the caller is responsible for retaining the last valid snapshot, never zeroing it", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("an empty array for the productId is a retryable empty_response — never mistaken for a confirmed 'no price exists'", async () => {
    // mockImplementation (not mockResolvedValue) so each call gets a FRESH
    // Response object — this exact case is retried once internally (see
    // pokepulse.ts's RETRYABLE_CODES), and a real fetch() always returns a
    // new Response per call; reusing one stale object across calls would
    // throw "Body is unusable" on the second read, a test-only artifact.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ [PRODUCT_ID]: [] }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.code).toBe("empty_response"); expect(result.retryable).toBe(true); }
  });

  it("a non-empty array with no market_price-type entry is price_field_missing, not empty_response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "last_sold_price", value: "10", currency: "GBP", aggregation_date: "2026-08-12T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("price_field_missing");
  });

  it("the productId key entirely absent from the response is product_not_found, not price_field_missing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ "some-other-product": [] }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.code).toBe("product_not_found"); expect(result.retryable).toBe(false); }
  });

  it("parses real timeseries history into ascending HistoricalPricePoints", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_TIMESERIES_RESPONSE));
    const result = await pokePulseProvider.getHistory(PRODUCT_ID, "2026-05-01", "2026-08-12");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { date: "2026-05-14", nativeUnitPrice: 997.21 },
        { date: "2026-05-17", nativeUnitPrice: 1045.68 },
      ]);
    }
  });

  it("history request never exceeds roughly a one-year window", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(REAL_TIMESERIES_RESPONSE));
    await pokePulseProvider.getHistory(PRODUCT_ID, "2025-08-13", "2026-08-12");
    // Found by matching the timeseries call itself, not by call index — a
    // session-bootstrap GET (see below) may or may not precede it
    // depending on whether a prior test already warmed the cache.
    const timeseriesCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("/timeseries"));
    expect(timeseriesCall).toBeDefined();
    const body = JSON.parse((timeseriesCall![1] as RequestInit).body as string);
    expect(body.startDate).toBe("2025-08-13");
    expect(body.endDate).toBe("2026-08-12");
  });
});

describe("PokePulse provider — anonymous session bootstrap for /api/internal/*", () => {
  const PRODUCT_ID = "card:me2pt5|284/217|Holo|null|null|null";

  // Live-verified real-world behaviour (see this feature's own inspection
  // notes): /api/internal/market-data and /api/internal/market-data/timeseries
  // reject a cookie-less request with 403 {"message":"Valid session
  // required"} even though the identical request succeeds from a real
  // browser — because the browser already holds an anonymous session
  // cookie (connect.sid) it picked up just from loading any page. This
  // cookie carries no login/identity; it's issued to every visitor.
  // /api/catalogue/*/lookup has no such requirement.
  function homeResponseWithSession(cookieValue: string) {
    return new Response(null, { status: 200, headers: { "set-cookie": `connect.sid=${cookieValue}; Path=/; HttpOnly` } });
  }

  it("attaches a session cookie (bootstrapped from a plain GET to the origin) to market-data requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://pokepulse.io/") return homeResponseWithSession("abc123");
      if (url.includes("/api/internal/market-data")) return jsonResponse(REAL_MARKET_DATA_RESPONSE);
      return jsonResponse({});
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    const marketDataCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("/api/internal/market-data"));
    expect(marketDataCall).toBeDefined();
    const headers = new Headers((marketDataCall![1] as RequestInit).headers);
    expect(headers.get("cookie")).toMatch(/connect\.sid=/);
  });

  it("never attaches a session cookie to the catalogue lookup endpoints — they don't require one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://pokepulse.io/") return homeResponseWithSession("abc123");
      if (url.includes("/lookup")) return jsonResponse(REAL_SEALED_LOOKUP_RESPONSE);
      return jsonResponse({});
    });
    await resolvePokePulseIdentity("https://pokepulse.io/sealed/celestial-storm-booster-box");
    const lookupCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("/lookup"));
    expect(lookupCall).toBeDefined();
    const headers = new Headers((lookupCall![1] as RequestInit).headers);
    expect(headers.has("cookie")).toBe(false);
  });

  it("REGRESSION: a 403 (stale/expired cached session) triggers exactly one retry with a freshly-bootstrapped session before failing", async () => {
    let marketDataAttempts = 0;
    let homeCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://pokepulse.io/") { homeCalls += 1; return homeResponseWithSession(`session-${homeCalls}`); }
      if (url.includes("/api/internal/market-data")) {
        marketDataAttempts += 1;
        if (marketDataAttempts === 1) return new Response(JSON.stringify({ message: "Valid session required" }), { status: 403 });
        return jsonResponse(REAL_MARKET_DATA_RESPONSE);
      }
      return jsonResponse({});
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    expect(marketDataAttempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("a persistent 403 even after retrying with a fresh session is a clean, retryable failure — never thrown", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://pokepulse.io/") return homeResponseWithSession("abc123");
      if (url.includes("/api/internal/market-data")) return new Response(JSON.stringify({ message: "Valid session required" }), { status: 403 });
      return jsonResponse({});
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// REGRESSION — the real, confirmed-live root cause of this feature's own
// investigation: PokePulse's market_price entry reports `currency` as
// EITHER the literal string "GBP" OR the symbol "£", and a prior version
// of this adapter only accepted the exact string "GBP", silently
// discarding every "£"-shaped response as "no market price" even though
// the price was completely real. Both raw shapes below were captured live
// against real PokePulse holdings on the same day, moments apart — see
// this feature's own completion report for the full evidence (direct
// requests returning real prices for every one of the products the old
// adapter had misreported as unavailable, and a controlled sequential
// test of all 10 real holdings that reproduced the split 100% of the time
// with zero actual rate-limiting/timeouts/empty payloads).
// ----------------------------------------------------------------------------
describe("PokePulse provider — REGRESSION: the real 'currency: £' root cause", () => {
  const PRODUCT_ID = "sealed:sv8|Surging Sparks Elite Trainer Box";

  // Real captured shape #1 — the "£" symbol, no nested regions/trends.
  const REAL_FLAT_SHAPE_GBP_SYMBOL = {
    [PRODUCT_ID]: [
      { type: "market_price", value: "114.34", currency: "£", aggregation_date: "2026-08-17 00:00:00+00", confidence_score: 100, condition: "nm", low_availability: false, blended_price: null, cm_preferred_price: null },
      { type: "last_sold_price", value: "110", currency: "£", aggregation_date: "2026-08-16 00:00:00+00" },
    ],
  };
  // Real captured shape #2 — the literal "GBP" string, WITH nested
  // regions/trends/last_sold metadata inside the market_price entry
  // itself. Both shapes must parse to the identical price/currency.
  const REAL_NESTED_SHAPE_GBP_STRING = {
    [PRODUCT_ID]: [
      {
        type: "market_price", value: "146.69", currency: "GBP", aggregation_date: "2026-08-16T00:00:00.000Z", confidence_score: 100, condition: "nm",
        low_availability: false, blended_price: null, cm_preferred_price: null, last_sold_price: 150, last_sold_date: "2026-08-16T00:00:00.000Z",
        regions: { us: { value: 121.3, date: "2026-08-16T00:00:00.000Z", last_sold_price: 125.58, last_sold_date: "2026-08-16T00:00:00.000Z", trends: {}, salesVolume: {} } },
      },
    ],
  };

  it("REGRESSION: a real market_price with currency '£' is accepted as a genuine GBP price, not discarded as no_data", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(REAL_FLAT_SHAPE_GBP_SYMBOL));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.nativeUnitPrice).toBe(114.34);
      expect(result.data.nativeCurrency).toBe("GBP");
    }
  });

  it("REGRESSION: a real market_price with the nested-shape 'GBP' string still parses identically", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(REAL_NESTED_SHAPE_GBP_STRING));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBe(146.69);
  });

  it("normalises PokePulse's Postgres-style aggregation_date ('YYYY-MM-DD HH:mm:ss+00') to a real ISO instant", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(REAL_FLAT_SHAPE_GBP_SYMBOL));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.priceAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("normalises the strict-ISO aggregation_date shape unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(REAL_NESTED_SHAPE_GBP_STRING));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.priceAt).toBe("2026-08-16T00:00:00.000Z");
  });

  it("still rejects a genuinely different currency (e.g. USD) — never silently converts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: "150", currency: "USD", aggregation_date: "2026-08-17T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("response_schema_unrecognised");
  });

  it("lowercase 'gbp' and whitespace-padded currency values are still recognised", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: "50", currency: " gbp ", aggregation_date: "2026-08-17T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
  });
});

describe("PokePulse provider — typed outcome codes for every response shape", () => {
  const PRODUCT_ID = "sealed:me04|Chaos Rising Booster Box";

  it("a numeric (not string) market_price value is accepted identically to a numeric string", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: 165.32, currency: "GBP", aggregation_date: "2026-08-17T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.nativeUnitPrice).toBe(165.32);
  });

  it("a zero market_price value is invalid_price, never treated as a real (free) price", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: "0", currency: "GBP", aggregation_date: "2026-08-17T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_price");
  });

  it("a negative market_price value is invalid_price", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: "-5", currency: "GBP", aggregation_date: "2026-08-17T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_price");
  });

  it("a null market_price value is invalid_price, distinguished from a missing field entirely", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: null, currency: "GBP", aggregation_date: "2026-08-17T00:00:00.000Z" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_price");
  });

  it("an unparseable aggregation_date is response_schema_unrecognised", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      [PRODUCT_ID]: [{ type: "market_price", value: "100", currency: "GBP", aggregation_date: "not-a-date" }],
    }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("response_schema_unrecognised");
  });

  it("an HTML response served with HTTP 200 is malformed_response, never parsed as empty/no-data", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("<html><body>Service temporarily unavailable</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.code).toBe("malformed_response"); expect(result.retryable).toBe(true); }
  });

  it("genuinely malformed JSON is malformed_response, never thrown", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{not valid json", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_response");
  });

  it("an explicit HTTP 429 is rate_limited, distinct from a generic server error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Too Many Requests", { status: 429 }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.code).toBe("rate_limited"); expect(result.retryable).toBe(true); }
  });

  it("a 5xx status is provider_unavailable, retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Internal Server Error", { status: 503 }));
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.code).toBe("provider_unavailable"); expect(result.retryable).toBe(true); }
  });

  it("an AbortError (timeout) is classified as 'timeout', not a generic network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("timeout");
  });

  it("a plain network error (not an abort) is provider_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("getaddrinfo ENOTFOUND pokepulse.io"); });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("provider_unavailable");
  });

  it("REGRESSION: a transient empty_response succeeds on the internal bounded retry", async () => {
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/internal/market-data")) {
        attempt += 1;
        if (attempt === 1) return jsonResponse({ [PRODUCT_ID]: [] });
        return jsonResponse({ [PRODUCT_ID]: [{ type: "market_price", value: "165.32", currency: "GBP", aggregation_date: "2026-08-17T00:00:00.000Z" }] });
      }
      return jsonResponse({});
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it("does NOT retry a confirmed price_field_missing (a structurally valid response explicitly lacking a price) — retrying an identical request cannot conjure a price PokePulse hasn't computed", async () => {
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/internal/market-data")) {
        attempt += 1;
        return jsonResponse({ [PRODUCT_ID]: [{ type: "last_sold_price", value: "10", currency: "GBP", aggregation_date: "2026-08-17T00:00:00.000Z" }] });
      }
      return jsonResponse({});
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    expect(attempt).toBe(1);
  });

  it("does NOT retry authentication_failed at the bounded-retry layer (it already gets its own fresh-session retry one layer down)", async () => {
    let marketDataAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://pokepulse.io/") return new Response(null, { status: 200, headers: { "set-cookie": "connect.sid=abc; Path=/; HttpOnly" } });
      if (url.includes("/api/internal/market-data")) { marketDataAttempts += 1; return new Response(JSON.stringify({ message: "Valid session required" }), { status: 403 }); }
      return jsonResponse({});
    });
    const result = await pokePulseProvider.getQuote(PRODUCT_ID);
    expect(result.ok).toBe(false);
    // Exactly 2: the original attempt + the built-in fresh-session retry —
    // NOT a 3rd/4th from the bounded-retry layer piling on top.
    expect(marketDataAttempts).toBe(2);
  });
});
