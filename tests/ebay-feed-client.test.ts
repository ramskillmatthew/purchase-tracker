import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

vi.mock("server-only", () => ({}));

import {
  createFeedTask, uploadFeedFile, getFeedTask, getFeedTasks, getFeedResultFile, feedTaskHasInputFile,
  feedApiHost, FEED_TASK_TERMINAL_STATUSES,
} from "@/lib/ebay-account/feed-client";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.EBAY_ENVIRONMENT; // defaults to PRODUCTION
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EBAY_ENVIRONMENT;
});

describe("Sell Feed API host — always PRODUCTION, regardless of EBAY_ENVIRONMENT", () => {
  it("feedApiHost() is the production host even when EBAY_ENVIRONMENT=SANDBOX", () => {
    process.env.EBAY_ENVIRONMENT = "SANDBOX";
    expect(feedApiHost()).toBe("https://api.ebay.com");
  });

  it("every Feed API function refuses up front when EBAY_ENVIRONMENT=SANDBOX, before ever calling fetch", async () => {
    process.env.EBAY_ENVIRONMENT = "SANDBOX";
    await expect(createFeedTask("token", "EBAY_GB")).rejects.toThrow(/does not support Seller Hub draft uploads in the Sandbox environment/);
    await expect(getFeedTask("token", "abc123")).rejects.toThrow(/Sandbox environment/);
    await expect(getFeedTasks("token")).rejects.toThrow(/Sandbox environment/);
    await expect(getFeedResultFile("token", "abc123")).rejects.toThrow(/Sandbox environment/);
    await expect(uploadFeedFile("token", "abc123", "a,b\r\nDraft,x\r\n")).rejects.toThrow(/Sandbox environment/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createFeedTask", () => {
  it("POSTs to /sell/feed/v1/task with feedType FX_LISTING and schemaVersion 1.0, and reads the task ID from the Location header", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { Location: "https://api.ebay.com/sell/feed/v1/task/abc-123-def" } }));
    const result = await createFeedTask("token", "EBAY_GB");
    expect(result).toEqual({ taskId: "abc-123-def" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.ebay.com/sell/feed/v1/task");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ schemaVersion: "1.0", feedType: "FX_LISTING" });
  });

  it("throws a clear error when eBay's response has no Location header, rather than guessing a body shape", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(createFeedTask("token", "EBAY_GB")).rejects.toThrow(/did not return a task ID/);
  });

  it("surfaces a real error on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "Invalid access token" }] }, 401));
    await expect(createFeedTask("token", "EBAY_GB")).rejects.toThrow();
  });

  it("a 429 response carries a parsed Retry-After hint in seconds", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "rate limited" }] }, 429, { "Retry-After": "30" }));
    await expect(createFeedTask("token", "EBAY_GB")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 30 });
  });

  // CORRECTIVE PASS (root cause of Batch #1's real failure) — the exact
  // wire-level request-contract assertions Phase 5 requires: the real
  // outgoing headers this function builds, not just source-string checks.
  it("REQUIREMENT: sends X-EBAY-C-MARKETPLACE-ID: EBAY_GB on the actual outgoing request", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { Location: "https://api.ebay.com/sell/feed/v1/task/abc-123" } }));
    await createFeedTask("token", "EBAY_GB");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_GB");
  });

  it("REQUIREMENT: never sends the CSV template's own site/country tokens ('UK' or 'GB') as the REST marketplace header value", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { Location: "https://api.ebay.com/sell/feed/v1/task/abc-123" } }));
    await createFeedTask("token", "EBAY_GB");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).not.toBe("UK");
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).not.toBe("GB");
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).not.toBe("EBAY_UK");
  });

  it("REQUIREMENT: a missing marketplace ID fails before any network call", async () => {
    await expect(createFeedTask("token", "")).rejects.toThrow(/marketplace ID is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: the Authorization header is present but this test never logs or asserts its literal value verbatim into output", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { Location: "https://api.ebay.com/sell/feed/v1/task/abc-123" } }));
    await createFeedTask("a-real-looking-token-value", "EBAY_GB");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toMatch(/^Bearer /);
  });
});

describe("uploadFeedFile", () => {
  const validCsv = 'Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8),SKU\r\nDraft,1644\r\n';

  it("POSTs multipart form data to the task's upload_file endpoint, without manually setting Content-Type (so fetch can set the multipart boundary)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await uploadFeedFile("token", "abc-123", validCsv);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.ebay.com/sell/feed/v1/task/abc-123/upload_file");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("REQUIREMENT (Phase 5 denylist): refuses to upload a CSV whose first data row's Action is not 'Draft', without calling fetch", async () => {
    const dangerousCsv = 'Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8),SKU\r\nAdd,1644\r\n';
    await expect(uploadFeedFile("token", "abc-123", dangerousCsv)).rejects.toThrow(/would create or modify a live eBay listing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to upload an empty file", async () => {
    const headerOnly = 'Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8),SKU\r\n';
    await expect(uploadFeedFile("token", "abc-123", headerOnly)).rejects.toThrow(/empty/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid task ID before ever calling fetch", async () => {
    await expect(uploadFeedFile("token", "has spaces", validCsv)).rejects.toThrow("Invalid eBay Feed task ID.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getFeedTask — read-only status poll", () => {
  it("GETs the task by ID and parses the known fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ taskId: "abc-123", feedType: "FX_LISTING", status: "COMPLETED", creationDate: "2026-09-03T00:00:00Z", completionDate: "2026-09-03T00:05:00Z" }));
    const result = await getFeedTask("token", "abc-123");
    expect(result).toEqual({ taskId: "abc-123", feedType: "FX_LISTING", status: "COMPLETED", creationDate: "2026-09-03T00:00:00Z", completionDate: "2026-09-03T00:05:00Z" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(String(url)).toContain("/sell/feed/v1/task/abc-123");
  });

  it("an unrecognised status string is preserved as-is, never coerced to a known value", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ taskId: "abc-123", status: "SOME_FUTURE_STATUS" }));
    expect((await getFeedTask("token", "abc-123")).status).toBe("SOME_FUTURE_STATUS");
  });

  it("known terminal statuses are exactly the documented-or-safely-inferred set", () => {
    expect(FEED_TASK_TERMINAL_STATUSES).toEqual(["COMPLETED", "COMPLETED_WITH_ERROR", "FAILED", "ABORTED"]);
  });

  it("a status not in FEED_TASK_TERMINAL_STATUSES must be treated as still in progress by any caller — CREATED is not terminal", () => {
    expect(FEED_TASK_TERMINAL_STATUSES).not.toContain("CREATED");
  });
});

describe("getFeedTasks — read-only list, scoped to FX_LISTING", () => {
  it("filters by feed_type=FX_LISTING and returns parsed tasks", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tasks: [{ taskId: "a", status: "CREATED" }, { taskId: "b", status: "COMPLETED" }] }));
    const result = await getFeedTasks("token");
    expect(result).toHaveLength(2);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("feed_type=FX_LISTING");
  });

  it("clamps an out-of-range limit into [1,100]", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ tasks: [] })));
    await getFeedTasks("token", 9999);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=100");
    await getFeedTasks("token", -5);
    expect(String(fetchMock.mock.calls[1][0])).toContain("limit=1");
  });
});

describe("getFeedResultFile — plain text and gzip-detected-by-magic-bytes", () => {
  it("returns a plain-text CSV response unchanged", async () => {
    const csv = "Action,SKU\r\nDraft,1644\r\n";
    fetchMock.mockResolvedValue(new Response(csv, { status: 200 }));
    expect(await getFeedResultFile("token", "abc-123")).toBe(csv);
  });

  it("detects and decompresses a gzip-compressed result file by its magic bytes, regardless of headers", async () => {
    const csv = "Action,SKU\r\nDraft,1644\r\n";
    const compressed = gzipSync(Buffer.from(csv, "utf-8"));
    fetchMock.mockResolvedValue(new Response(compressed, { status: 200 }));
    expect(await getFeedResultFile("token", "abc-123")).toBe(csv);
  });

  it("surfaces a clear error for corrupted gzip-looking bytes rather than returning garbage", async () => {
    const corrupted = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]);
    fetchMock.mockResolvedValue(new Response(corrupted, { status: 200 }));
    await expect(getFeedResultFile("token", "abc-123")).rejects.toThrow(/could not be decompressed/);
  });

  it("AUDIT POINT 8: the raw download itself is bounded — an oversized plain-text response is rejected before being fully buffered, never silently read to completion", async () => {
    const huge = "x".repeat(30 * 1024 * 1024); // 30MB, over the 25MB raw cap
    fetchMock.mockResolvedValue(new Response(huge, { status: 200 }));
    await expect(getFeedResultFile("token", "abc-123")).rejects.toThrow(/safety limit/);
  });

  it("a response right at a reasonable size still succeeds (the bound isn't so tight it breaks a real small result file)", async () => {
    const csv = "Action,SKU\r\n" + "Draft,1644\r\n".repeat(1000);
    fetchMock.mockResolvedValue(new Response(csv, { status: 200 }));
    expect(await getFeedResultFile("token", "abc-123")).toBe(csv);
  });
});

describe("feedTaskHasInputFile — AUDIT POINT 13: authoritative existing-upload check", () => {
  it("returns true for a 200 (a file already exists)", async () => {
    fetchMock.mockResolvedValue(new Response("some file content", { status: 200 }));
    expect(await feedTaskHasInputFile("token", "abc-123")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sell/feed/v1/task/abc-123/download_input_file");
    expect(init.method).toBe("GET");
  });

  it("returns false for a 404 (nothing uploaded yet) — never throws for this expected, handled outcome", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await feedTaskHasInputFile("token", "abc-123")).toBe(false);
  });

  it("a genuine error (401/500) is a real thrown error, never silently treated as either true or false", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "Invalid access token" }] }, 401));
    await expect(feedTaskHasInputFile("token", "abc-123")).rejects.toThrow();
  });

  it("rejects an invalid task ID before ever calling fetch", async () => {
    await expect(feedTaskHasInputFile("token", "has spaces")).rejects.toThrow("Invalid eBay Feed task ID.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is gated by the Feed operation allowlist", () => {
    const source = require("node:fs").readFileSync("lib/ebay-account/feed-client.ts", "utf8") as string;
    expect(source).toContain('assertAllowedFeedOperation("getFeedInputFile")');
  });
});

describe("REQUIREMENT (Phase 4): X-EBAY-C-MARKETPLACE-ID is sent ONLY where eBay's own documentation requires it — never blindly added to every operation", () => {
  it("uploadFeedFile never sends the marketplace header (eBay's own docs: only Content-Type is required, and this task is already scoped by task_id)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await uploadFeedFile("token", "abc-123", 'Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8),SKU\r\nDraft,1644\r\n');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).toBeUndefined();
  });

  it("getFeedTask never sends the marketplace header (task-scoped, no additional required headers documented)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ taskId: "abc-123", status: "CREATED" }));
    await getFeedTask("token", "abc-123");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).toBeUndefined();
  });

  it("getFeedTasks never sends the marketplace header (account-scoped, no additional required headers documented)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tasks: [] }));
    await getFeedTasks("token");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).toBeUndefined();
  });

  it("getFeedResultFile never sends the marketplace header (task-scoped)", async () => {
    fetchMock.mockResolvedValue(new Response("Action,SKU\r\n", { status: 200 }));
    await getFeedResultFile("token", "abc-123");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).toBeUndefined();
  });

  it("feedTaskHasInputFile (getInputFile) never sends the marketplace header (task-scoped)", async () => {
    fetchMock.mockResolvedValue(new Response("content", { status: 200 }));
    await feedTaskHasInputFile("token", "abc-123");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-EBAY-C-MARKETPLACE-ID"]).toBeUndefined();
  });
});

describe("STRUCTURAL — every exported function is gated and no publish-capable function exists", () => {
  it("every exported function calls assertAllowedFeedOperation with a hardcoded literal, before constructing a request", () => {
    const source = require("node:fs").readFileSync("lib/ebay-account/feed-client.ts", "utf8") as string;
    for (const op of ["createFeedTask", "uploadFeedFile", "getFeedTask", "getFeedTasks", "getFeedResultFile", "getFeedInputFile"]) {
      expect(source).toContain(`assertAllowedFeedOperation("${op}")`);
    }
  });

  it("no function in this file is named or shaped like a publish/list/revise/end operation", () => {
    const source = require("node:fs").readFileSync("lib/ebay-account/feed-client.ts", "utf8") as string;
    expect(source).not.toMatch(/export (async )?function (publish|revise|relist|end|list)[A-Z]/i);
  });

  it("uploadFeedFile is gated by the CSV Action denylist before any fetch call", () => {
    const source = require("node:fs").readFileSync("lib/ebay-account/feed-client.ts", "utf8") as string;
    const fnBody = source.slice(source.indexOf("export async function uploadFeedFile"), source.indexOf("export async function getFeedTask"));
    const gateIndex = fnBody.indexOf("assertCsvOnlyContainsAllowedAction(csv)");
    const requestIndex = fnBody.indexOf("feedRequest(");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(gateIndex);
  });
});
