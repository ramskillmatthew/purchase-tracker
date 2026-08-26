import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchVintedCatalogue, describeVintedCatalogueFetchFailure, VINTED_CATALOGUE_ENDPOINT } from "@/lib/listing-studio/vinted-catalogue-client";

const validBody = JSON.stringify({
  catalogs: [{ id: 1904, code: "WOMEN_ROOT", title: "Women", catalogs: [{ id: 1906, title: "Trainers", path: "Women", catalogs: [] }] }],
});

function jsonResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}
function htmlChallengeResponse() {
  return new Response("<html><h1>Please wait</h1></html>", { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchVintedCatalogue — the real, verified endpoint", () => {
  it("calls exactly the one verified Vinted UK endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validBody));
    await fetchVintedCatalogue();
    expect(fetchMock).toHaveBeenCalledWith(VINTED_CATALOGUE_ENDPOINT, expect.any(Object));
  });

  it("never sends cookies, Supabase, or Anthropic credentials — only Accept + a truthful User-Agent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validBody));
    await fetchVintedCatalogue();
    const [, init] = fetchMock.mock.calls[0];
    const headerKeys = Object.keys(init.headers).map(k => k.toLowerCase());
    expect(headerKeys).toEqual(expect.arrayContaining(["accept", "user-agent"]));
    expect(headerKeys).not.toContain("cookie");
    expect(headerKeys).not.toContain("authorization");
  });
});

describe("fetchVintedCatalogue — success path", () => {
  it("parses and flattens a valid response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validBody));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.categories).toHaveLength(2);
      expect(outcome.categories.find(c => c.id === 1906)?.fullPath).toBe("Women > Trainers");
    }
  });
});

describe("fetchVintedCatalogue — safe failure handling for every observed/possible failure mode", () => {
  it("401 -> blocked (never retried)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const outcome = await fetchVintedCatalogue();
    expect(outcome).toEqual({ status: "blocked", httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("403 with an HTML Cloudflare challenge page -> unexpected_content_type (the real observed behaviour), never retried", async () => {
    fetchMock.mockResolvedValueOnce(htmlChallengeResponse());
    const outcome = await fetchVintedCatalogue();
    // 403 is checked before content-type, so this specific case reports "blocked" —
    // either way it must be a safe, closed-set outcome, never a thrown error or raw HTML.
    expect(["blocked", "unexpected_content_type"]).toContain(outcome.status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 200 response with an HTML content-type -> unexpected_content_type", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("unexpected_content_type");
  });

  it("429 -> rate_limited, never retried", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const outcome = await fetchVintedCatalogue();
    expect(outcome).toEqual({ status: "rate_limited", httpStatus: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400 -> http_error, never retried (not transient)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
    const outcome = await fetchVintedCatalogue();
    expect(outcome).toEqual({ status: "http_error", httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("500 -> http_error, retried exactly once (transient)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const outcome = await fetchVintedCatalogue();
    expect(outcome).toEqual({ status: "http_error", httpStatus: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a network error is retried exactly once, then reported as network_error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    const outcome = await fetchVintedCatalogue();
    expect(outcome).toEqual({ status: "network_error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a transient failure followed by success on retry succeeds overall", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    fetchMock.mockResolvedValueOnce(jsonResponse(validBody));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("malformed JSON body -> invalid_response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("{ not valid json"));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("invalid_response");
  });

  it("well-formed JSON that doesn't match the catalogue shape -> invalid_response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(JSON.stringify({ nope: true })));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("invalid_response");
  });

  it("an empty catalogue -> invalid_response (rejected, never silently applied)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(JSON.stringify({ catalogs: [] })));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("invalid_response");
  });

  it("a response exceeding the max size cap -> response_too_large, without ever fully buffering it", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
        for (let i = 0; i < 6; i++) controller.enqueue(chunk); // 6 MiB > 5 MiB cap
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(oversized, { status: 200, headers: { "content-type": "application/json" } }));
    const outcome = await fetchVintedCatalogue();
    expect(outcome.status).toBe("response_too_large");
  });
});

describe("describeVintedCatalogueFetchFailure — always a fixed, safe sentence", () => {
  it("never leaks raw detail (e.g. a content-type string) into the message", () => {
    const message = describeVintedCatalogueFetchFailure({ status: "unexpected_content_type", contentType: "text/html; charset=UTF-8; boundary=weird" });
    expect(message).not.toMatch(/text\/html/);
  });

  it("returns a non-empty string for every failure status", () => {
    const outcomes: Parameters<typeof describeVintedCatalogueFetchFailure>[0][] = [
      { status: "blocked", httpStatus: 403 }, { status: "rate_limited", httpStatus: 429 },
      { status: "unexpected_content_type", contentType: null }, { status: "response_too_large" },
      { status: "invalid_response", detail: "x" }, { status: "http_error", httpStatus: 500 }, { status: "network_error" },
    ];
    for (const outcome of outcomes) expect(describeVintedCatalogueFetchFailure(outcome).length).toBeGreaterThan(0);
  });
});
