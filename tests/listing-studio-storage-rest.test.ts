import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  deleteStorageObject,
  deleteStorageObjects,
  getStorageObjectMetadata,
  STORAGE_DELETE_BATCH_SIZE,
  StorageBucketMissingError,
} from "@/lib/listing-studio/storage-rest";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("createSignedUploadUrl", () => {
  it("POSTs to the exact object/upload/sign endpoint with an empty JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: "/object/upload/sign/listing-drafts/a/b/c-x.jpg?token=abc", token: "abc" }));
    await createSignedUploadUrl("listing-drafts", "a/b/c-x.jpg");
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("https://example.supabase.co/storage/v1/object/upload/sign/listing-drafts/a/b/c-x.jpg");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe("{}");
  });

  it("sends the service-role key as apikey/Authorization, never a public key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: "/x?token=t", token: "t" }));
    await createSignedUploadUrl("listing-drafts", "path");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("apikey")).toBe("sb_secret_test");
  });

  it("resolves a relative response url against the storage base", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: "/object/upload/sign/listing-drafts/path?token=abc", token: "abc" }));
    const result = await createSignedUploadUrl("listing-drafts", "path");
    expect(result.uploadUrl).toBe("https://example.supabase.co/storage/v1/object/upload/sign/listing-drafts/path?token=abc");
  });

  it("leaves an already-absolute response url untouched", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: "https://other.host/already-absolute?token=abc", token: "abc" }));
    const result = await createSignedUploadUrl("listing-drafts", "path");
    expect(result.uploadUrl).toBe("https://other.host/already-absolute?token=abc");
  });

  it("sets x-upsert:true only when explicitly requested (retry path)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: "/x?token=t", token: "t" }));
    await createSignedUploadUrl("listing-drafts", "path", { upsert: true });
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("x-upsert")).toBe("true");
  });

  it("omits x-upsert by default (first-time upload never overwrites)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: "/x?token=t", token: "t" }));
    await createSignedUploadUrl("listing-drafts", "path");
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("x-upsert")).toBeNull();
  });

  it("throws StorageBucketMissingError with a clear setup message when the bucket doesn't exist", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" }), { status: 400 }));
    await expect(createSignedUploadUrl("listing-drafts", "path")).rejects.toThrow(StorageBucketMissingError);
    await expect(createSignedUploadUrl("listing-drafts", "path")).rejects.toThrow(/supabase-listing-studio\.sql/);
  });

  it("throws a generic error (not StorageBucketMissingError) for an unrelated failure", async () => {
    fetchMock.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    await expect(createSignedUploadUrl("listing-drafts", "path")).rejects.not.toThrow(StorageBucketMissingError);
  });
});

describe("getStorageObjectMetadata", () => {
  it("lists by prefix/search derived from the path, not the full path itself", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await getStorageObjectMetadata("listing-drafts", "owner/draft/image-photo.jpg");
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("https://example.supabase.co/storage/v1/object/list/listing-drafts");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ prefix: "owner/draft", search: "image-photo.jpg", limit: 1 });
  });

  it("returns null when no matching object is found (never throws for a missing object)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await getStorageObjectMetadata("listing-drafts", "owner/draft/image-photo.jpg")).toBeNull();
  });

  it("returns the real server-observed size/mimetype when found — never a client-trusted value", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ name: "image-photo.jpg", metadata: { size: 123456, mimetype: "image/jpeg" } }]));
    const result = await getStorageObjectMetadata("listing-drafts", "owner/draft/image-photo.jpg");
    expect(result).toEqual({ size: 123456, mimeType: "image/jpeg" });
  });

  it("returns null when the matching entry has no metadata block", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ name: "image-photo.jpg" }]));
    expect(await getStorageObjectMetadata("listing-drafts", "owner/draft/image-photo.jpg")).toBeNull();
  });

  it("throws StorageBucketMissingError when the bucket doesn't exist", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Bucket not found" }), { status: 400 }));
    await expect(getStorageObjectMetadata("listing-drafts", "a/b")).rejects.toThrow(StorageBucketMissingError);
  });
});

describe("deleteStorageObject", () => {
  it("DELETEs with a JSON prefixes body, not a path segment (verified live shape)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await deleteStorageObject("listing-drafts", "owner/draft/image-photo.jpg");
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("https://example.supabase.co/storage/v1/object/listing-drafts");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ prefixes: ["owner/draft/image-photo.jpg"] });
  });

  it("throws on a failed delete", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));
    await expect(deleteStorageObject("listing-drafts", "path")).rejects.toThrow();
  });
});

describe("deleteStorageObjects — batched multi-path delete for 'Clear all'", () => {
  it("sends every path in one request when the list fits in one batch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await deleteStorageObjects("listing-drafts", ["a/b/1-x.jpg", "a/b/2-y.jpg", "a/b/3-z.jpg"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("https://example.supabase.co/storage/v1/object/listing-drafts");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ prefixes: ["a/b/1-x.jpg", "a/b/2-y.jpg", "a/b/3-z.jpg"] });
  });

  it("REGRESSION: splits a path list larger than STORAGE_DELETE_BATCH_SIZE into multiple requests, never one giant request or one request per path", async () => {
    const paths = Array.from({ length: STORAGE_DELETE_BATCH_SIZE + 5 }, (_, i) => `a/b/${i}-x.jpg`);
    fetchMock.mockResolvedValue(jsonResponse([]));
    await deleteStorageObjects("listing-drafts", paths);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBatch = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).prefixes;
    const secondBatch = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).prefixes;
    expect(firstBatch).toHaveLength(STORAGE_DELETE_BATCH_SIZE);
    expect(secondBatch).toHaveLength(5);
  });

  it("does nothing, and calls fetch zero times, for an empty path list", async () => {
    await deleteStorageObjects("listing-drafts", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REGRESSION: throws on the first failing batch and stops — a later batch is never attempted once one has failed", async () => {
    const paths = Array.from({ length: STORAGE_DELETE_BATCH_SIZE + 5 }, (_, i) => `a/b/${i}-x.jpg`);
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));
    await expect(deleteStorageObjects("listing-drafts", paths)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createSignedDownloadUrl", () => {
  it("POSTs with the requested expiresIn and resolves the signedURL field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ signedURL: "/object/sign/listing-drafts/path?token=abc" }));
    const result = await createSignedDownloadUrl("listing-drafts", "path", 300);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("https://example.supabase.co/storage/v1/object/sign/listing-drafts/path");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ expiresIn: 300 });
    expect(result).toBe("https://example.supabase.co/storage/v1/object/sign/listing-drafts/path?token=abc");
  });

  it("throws StorageBucketMissingError when the bucket doesn't exist", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Bucket not found" }), { status: 400 }));
    await expect(createSignedDownloadUrl("listing-drafts", "path", 60)).rejects.toThrow(StorageBucketMissingError);
  });
});
