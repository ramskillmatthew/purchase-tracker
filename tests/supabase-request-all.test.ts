import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseRequestAll } from "@/lib/supabase";

function jsonResponse(rows: unknown[], status = 200) {
  return new Response(JSON.stringify(rows), { status, headers: { "Content-Type": "application/json" } });
}

function jsonResponseWithRange(rows: unknown[], contentRange: string, status = 200) {
  return new Response(JSON.stringify(rows), { status, headers: { "Content-Type": "application/json", "Content-Range": contentRange } });
}

function rowsOf(count: number, startId = 0) {
  return Array.from({ length: count }, (_, index) => ({ id: startId + index }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supabaseRequestAll", () => {
  it("1. fewer than a full page requires exactly one request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(3)));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("2. exactly a full page requests the next page to confirm completion", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(5, 0))).mockResolvedValueOnce(jsonResponse([]));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("3. one row over a full page still returns everything", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(5, 0))).mockResolvedValueOnce(jsonResponse(rowsOf(1, 5)));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("4. 1798 rows at the real default page size (1000) are all returned exactly once", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(1000, 0))).mockResolvedValueOnce(jsonResponse(rowsOf(798, 1000)));
    const result = await supabaseRequestAll<{ id: number }>("purchases?select=*&order=order_date.desc");
    expect(result).toHaveLength(1798);
    const ids = result.map(row => row.id);
    expect(new Set(ids).size).toBe(1798); // no duplicates
    expect(Math.min(...ids)).toBe(0);
    expect(Math.max(...ids)).toBe(1797); // no gaps
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("5. more than 2000 rows loads across at least three pages", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rowsOf(1000, 0)))
      .mockResolvedValueOnce(jsonResponse(rowsOf(1000, 1000)))
      .mockResolvedValueOnce(jsonResponse(rowsOf(500, 2000)));
    const result = await supabaseRequestAll("purchases?select=*");
    expect(result).toHaveLength(2500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("6. ordering is preserved across page boundaries — pages are concatenated, never re-sorted client-side", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }, { id: 2 }, { id: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 0 }]));
    const result = await supabaseRequestAll<{ id: number }>("purchases?select=*&order=order_date.desc", { pageSize: 3 });
    expect(result.map(r => r.id)).toEqual([3, 2, 1, 0]);
  });

  it("7. filters remain applied to every page (the same path, filters included, is requested each time)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(3, 0))).mockResolvedValueOnce(jsonResponse(rowsOf(1, 3)));
    await supabaseRequestAll("purchases?select=*&order_date=gte.2026-01-01&order=order_date.desc", { pageSize: 3 });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("order_date=gte.2026-01-01");
    }
  });

  it("8. selected columns remain applied to every page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(3, 0))).mockResolvedValueOnce(jsonResponse(rowsOf(1, 3)));
    await supabaseRequestAll("purchases?select=id,order_date&order=order_date.desc", { pageSize: 3 });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("select=id,order_date");
    }
  });

  it("uses the correct Range header for each page (0-indexed, inclusive)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(3, 0))).mockResolvedValueOnce(jsonResponse(rowsOf(1, 3)));
    await supabaseRequestAll("purchases?select=*", { pageSize: 3 });
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Range")).toBe("0-2");
    expect(new Headers(secondInit.headers).get("Range")).toBe("3-5");
  });

  it("9/10. a failure on page two rejects the whole operation and never returns the partial first page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(3, 0))).mockResolvedValueOnce(new Response("Database request failed.", { status: 500 }));
    await expect(supabaseRequestAll("purchases?select=*", { pageSize: 3 })).rejects.toThrow();
  });

  it("11. the maximum-page safeguard stops an otherwise infinite loop rather than hanging forever", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(rowsOf(2))); // every page always "full" — would never terminate naturally
    await expect(supabaseRequestAll("purchases?select=*", { pageSize: 2, maxPages: 4 })).rejects.toThrow(/maximum page count/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never sends service-role credentials to anything but the Supabase host — apikey/Authorization stay on the outgoing request only", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(1, 0)));
    await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("https://example.supabase.co");
    expect(new Headers((init as RequestInit).headers).get("apikey")).toBe("sb_secret_test");
  });

  it("requests an exact count so a real Content-Range total is available", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(1, 0)));
    await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Prefer")).toContain("count=exact");
  });
});

describe("supabaseRequestAll — strengthened against a server-side page cap smaller than requested (Content-Range total is authoritative)", () => {
  it("REQUIREMENT: does not stop early when a page returns fewer rows than requested but Content-Range's total shows more remain", async () => {
    // Asked for a 10-row page but the server only ever returns 4 at a time
    // (simulating a db-max-rows below our requested pageSize) — the total
    // in Content-Range (10) proves 6 more rows exist, so this must not be
    // mistaken for "end of table" just because 4 < 10.
    fetchMock
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(4, 0), "0-3/10"))
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(4, 4), "4-7/10"))
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(2, 8), "8-9/10"));
    const result = await supabaseRequestAll<{ id: number }>("purchases?select=*", { pageSize: 10 });
    expect(result).toHaveLength(10);
    expect(result.map(r => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("anchors the next page's start on the server's own reported end position, not on assumed page-size arithmetic", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(4, 0), "0-3/6"))
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(2, 4), "4-5/6"));
    await supabaseRequestAll("purchases?select=*", { pageSize: 10 });
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(secondInit.headers).get("Range")).toBe("4-13");
  });

  it("stops immediately once the known total is reached, even on the very first exactly-full page — no wasted confirming request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponseWithRange(rowsOf(5, 0), "0-4/5"));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the short-page heuristic when the total is unknown ('*')", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(5, 0), "0-4/*"))
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(2, 5), "5-6/*"));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an empty-table wildcard range ('*/0') is treated as zero rows, not an error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponseWithRange([], "*/0"));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no duplicates and no gaps across a server-capped multi-page sequence", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(3, 0), "0-2/7"))
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(3, 3), "3-5/7"))
      .mockResolvedValueOnce(jsonResponseWithRange(rowsOf(1, 6), "6-6/7"));
    const result = await supabaseRequestAll<{ id: number }>("purchases?select=*", { pageSize: 10 });
    const ids = result.map(r => r.id);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("supabaseRequestAll — REGRESSION: PGRST103 (\"Requested range not satisfiable\")", () => {
  // Root cause, confirmed live against a real Supabase project: this
  // function always paginates via its own Range header. If `path` already
  // carries an explicit `?limit=1` and the true matching-row count exceeds
  // 1, the first page returns Content-Range "0-0/N" (1 row, total N) —
  // this function then requests a second page ("Range: 1-1000") to try to
  // reach that total, and PostgREST rejects that exact combination with
  // PGRST103 (previously reproduced verbatim: a Range header with a
  // nonzero offset alongside a query-string `limit=` is invalid). The fix
  // is to fail fast before ever sending a request, not to catch the error
  // after the fact.
  it("throws immediately (no fetch at all) when the path already has an explicit limit= parameter", async () => {
    await expect(supabaseRequestAll("listing_draft_images?select=sort_order&order=sort_order.desc&limit=1")).rejects.toThrow(/limit\/offset/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws immediately when the path has limit= combined with other filters (&limit=, not just ?limit=)", async () => {
    await expect(supabaseRequestAll("listing_draft_images?draft_id=eq.x&select=id&limit=1")).rejects.toThrow(/limit\/offset/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws immediately when the path has an explicit offset= parameter", async () => {
    await expect(supabaseRequestAll("purchases?select=*&offset=5")).rejects.toThrow(/limit\/offset/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends an invalid negative-width Range header — a zero pageSize returns an empty array instead of computing 'from-(-1)'", async () => {
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 0 });
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also treats a negative pageSize as \"nothing requested\" rather than sending a malformed Range", async () => {
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: -1 });
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a path with no limit/offset and a normal pageSize is completely unaffected by the new guard", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponseWithRange(rowsOf(2, 0), "0-1/2"));
    const result = await supabaseRequestAll("purchases?select=*", { pageSize: 5 });
    expect(result).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
