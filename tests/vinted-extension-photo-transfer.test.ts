// Follow-up correction (message-lifecycle hang bug) — a live batch hung
// indefinitely (only the unrelated 3-minute item watchdog eventually
// noticed) with NO download error at all, because this content-script-side
// wait for chrome.runtime.sendMessage's callback had no bound whatsoever.
// These tests exercise shared/photo-transfer.js's makeRequestPhoto()
// directly against a fake `chrome.runtime`-shaped object — no real browser
// or content-script.js loading required — proving every outcome (timeout,
// chrome.runtime.lastError, a malformed response, a chunked transfer)
// resolves or rejects with a specific, safe error instead of hanging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRequestPhoto, REQUEST_TIMEOUT_MS } from "../vinted-draft-queue-extension/shared/photo-transfer.js";

type Listener = (message: any, sender: any, sendResponse: (r: any) => void) => void;

function makeFakeRuntime() {
  const runtime: any = { lastError: undefined, sendMessage: vi.fn() };
  return runtime;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared/photo-transfer.js — makeRequestPhoto (message-lifecycle hang bug fix)", () => {
  it("REGRESSION: an ordinary (non-chunked) successful response is returned as-is", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => {
      callback({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", base64: "AAAA" });
    });
    const requestPhoto = makeRequestPhoto(runtime);

    const result = await requestPhoto("item-1", 0);
    expect(result).toEqual({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", base64: "AAAA" });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0][0]).toEqual({ type: "REQUEST_PHOTO", itemId: "item-1", position: 0 });
  });

  it("REGRESSION: an ordinary failure response (e.g. HTTP 403) is passed straight through, never thrown", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => {
      callback({ ok: false, reason: "HTTP_403: forbidden" });
    });
    const requestPhoto = makeRequestPhoto(runtime);

    const result = await requestPhoto("item-1", 0);
    expect(result).toEqual({ ok: false, reason: "HTTP_403: forbidden" });
  });

  it("REGRESSION: chrome.runtime.lastError is captured and reported as a safe NETWORK error, not left hanging", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => {
      runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
      callback(undefined);
      runtime.lastError = undefined;
    });
    const requestPhoto = makeRequestPhoto(runtime);

    await expect(requestPhoto("item-1", 0)).rejects.toThrow(/NETWORK/);
  });

  it("REGRESSION: a malformed response (missing/invalid `ok`) is rejected rather than trusted", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => {
      callback({ somethingElse: true });
    });
    const requestPhoto = makeRequestPhoto(runtime);

    await expect(requestPhoto("item-1", 0)).rejects.toThrow(/MALFORMED_RESPONSE/);
  });

  it("REGRESSION: undefined response (e.g. the channel closed early with no error surfaced) is rejected, never resolved", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => {
      callback(undefined);
    });
    const requestPhoto = makeRequestPhoto(runtime);

    await expect(requestPhoto("item-1", 0)).rejects.toThrow(/MALFORMED_RESPONSE/);
  });

  it("REGRESSION: a service worker that never responds at all is bounded by a ~30s timeout, identifying the photo position and the waiting stage — watchdog is never the first sign of this", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation(() => { /* never calls the callback — simulates a hung service worker */ });
    const requestPhoto = makeRequestPhoto(runtime);

    const resultPromise = requestPhoto("item-1", 3);
    const assertion = expect(resultPromise).rejects.toThrow(/TIMEOUT: photo 3 — stage: waiting for service-worker response/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it("a late reply after the timeout has already fired is safely ignored (never a second settle)", async () => {
    const runtime = makeFakeRuntime();
    let savedCallback: ((r: any) => void) | undefined;
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => { savedCallback = callback; });
    const requestPhoto = makeRequestPhoto(runtime);

    const resultPromise = requestPhoto("item-1", 0);
    const assertion = expect(resultPromise).rejects.toThrow(/TIMEOUT/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
    // A response arriving after the timeout already rejected must not throw/crash or resolve a second time.
    expect(() => savedCallback?.({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", base64: "AAAA" })).not.toThrow();
  });

  it("REGRESSION: a chunked transfer is requested chunk-by-chunk, in order, and reassembled into the full base64 string", async () => {
    const runtime = makeFakeRuntime();
    const chunks = ["AAA", "BBB", "CCC"];
    const seenChunkIndexes: number[] = [];
    runtime.sendMessage.mockImplementation((message: any, callback: (r: any) => void) => {
      if (message.type === "REQUEST_PHOTO") {
        callback({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", chunked: true, transferId: "transfer-1", totalChunks: chunks.length });
        return;
      }
      if (message.type === "REQUEST_PHOTO_CHUNK") {
        seenChunkIndexes.push(message.chunkIndex);
        callback({ ok: true, chunkIndex: message.chunkIndex, data: chunks[message.chunkIndex] });
        return;
      }
      throw new Error(`unexpected message type: ${message.type}`);
    });
    const requestPhoto = makeRequestPhoto(runtime);

    const result = await requestPhoto("item-1", 0);
    expect(result).toEqual({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", base64: "AAABBBCCC" });
    expect(seenChunkIndexes).toEqual([0, 1, 2]); // requested strictly in order, one at a time
  });

  it("REGRESSION: base64/message-transfer failure — a chunk request that fails (e.g. an expired/unknown transfer) is reported as a safe, specific failure, never a hang", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((message: any, callback: (r: any) => void) => {
      if (message.type === "REQUEST_PHOTO") {
        callback({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", chunked: true, transferId: "transfer-1", totalChunks: 2 });
        return;
      }
      callback({ ok: false, reason: "NOT_FOUND: photo transfer expired or is unknown — request the photo again." });
    });
    const requestPhoto = makeRequestPhoto(runtime);

    const result = await requestPhoto("item-1", 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });

  it("REGRESSION: a chunk response missing string `data` is treated as a failure, never silently joined as \"undefined\"", async () => {
    const runtime = makeFakeRuntime();
    runtime.sendMessage.mockImplementation((message: any, callback: (r: any) => void) => {
      if (message.type === "REQUEST_PHOTO") {
        callback({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", chunked: true, transferId: "transfer-1", totalChunks: 1 });
        return;
      }
      callback({ ok: true, chunkIndex: 0 }); // missing `data`
    });
    const requestPhoto = makeRequestPhoto(runtime);

    const result = await requestPhoto("item-1", 0);
    expect(result.ok).toBe(false);
  });

  it("never logs the transferred base64/chunk bytes themselves", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtime = makeFakeRuntime();
    const secretBytes = "VEhJU19JU19TRUNSRVRfUEhPVE9fQllURVM"; // "THIS_IS_SECRET_PHOTO_BYTES" base64-ish
    runtime.sendMessage.mockImplementation((_message: any, callback: (r: any) => void) => {
      callback({ ok: true, position: 0, fileName: "01.jpg", mimeType: "image/jpeg", base64: secretBytes });
    });
    const requestPhoto = makeRequestPhoto(runtime);

    await requestPhoto("item-1", 0);
    const loggedText = logSpy.mock.calls.map(args => args.join(" ")).join("\n");
    expect(loggedText).not.toContain(secretBytes);
  });
});
