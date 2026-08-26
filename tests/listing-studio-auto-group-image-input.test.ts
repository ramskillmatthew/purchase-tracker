import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

const mockCreateSignedDownloadUrl = vi.fn();
vi.mock("@/lib/listing-studio/storage-rest", () => ({
  createSignedDownloadUrl: (...args: unknown[]) => mockCreateSignedDownloadUrl(...args),
}));

// heic-convert does a real WASM HEVC decode, which needs a genuine
// HEIC-encoded fixture this test suite doesn't have — mocked here so the
// HEIC-specific behaviour (decode succeeds -> goes through the same resize
// pipeline as everything else; decode fails -> skipped, never thrown) can
// still be exercised without a real fixture. The non-HEIC resize path below
// still runs real sharp code end-to-end.
const mockConvertHeic = vi.fn();
vi.mock("heic-convert", () => ({ default: (...args: unknown[]) => mockConvertHeic(...args) }));

const { prepareAutoGroupImageInputs } = await import("@/lib/listing-studio/auto-group-image-input");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockCreateSignedDownloadUrl.mockReset().mockResolvedValue("https://example.supabase.co/signed/photo.jpg");
  mockConvertHeic.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function tinyJpegBuffer(): Promise<Buffer> {
  // A real, genuinely-decodable image — built with sharp itself rather than
  // a hardcoded base64 blob, so the resize/re-encode path in
  // lib/listing-studio/auto-group-image-input.ts runs against real image
  // bytes, not a mock of sharp's own behavior.
  return sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
}

describe("prepareAutoGroupImageInputs — resizing/optimising real photos", () => {
  it("resizes a real oversized photo down to the configured max dimension and re-encodes it as a base64 JPEG block", async () => {
    const original = await tinyJpegBuffer();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(original), { status: 200 }));
    const { blocks, skipped } = await prepareAutoGroupImageInputs(
      [{ id: "photo-1", storagePath: "owner/draft/photo-1.jpg", mimeType: "image/jpeg" }],
      "listing-drafts",
    );
    expect(skipped).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].imageId).toBe("photo-1");
    expect(blocks[0].content.type).toBe("image");
    const source = blocks[0].content.source as { type: string; media_type: string; data: string };
    expect(source.type).toBe("base64");
    expect(source.media_type).toBe("image/jpeg");
    expect(source.data.length).toBeGreaterThan(0);

    // The resized copy must actually be smaller than the 2000x1000 original,
    // and bounded by the configured max dimension — proving a real resize
    // happened, not just a pass-through re-encode.
    const resizedBuffer = Buffer.from(source.data, "base64");
    const metadata = await sharp(resizedBuffer).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1024);
    expect(metadata.height).toBeLessThanOrEqual(1024);
    expect(resizedBuffer.length).toBeLessThan(original.length);
  });

  it("mints a signed download URL for the real Storage bucket/path rather than reading anything by guesswork", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(await tinyJpegBuffer()), { status: 200 }));
    await prepareAutoGroupImageInputs([{ id: "photo-1", storagePath: "owner/draft/photo-1.jpg", mimeType: "image/jpeg" }], "listing-drafts");
    expect(mockCreateSignedDownloadUrl).toHaveBeenCalledWith("listing-drafts", "owner/draft/photo-1.jpg", expect.any(Number));
  });
});

describe("prepareAutoGroupImageInputs — HEIC/HEIF is decoded, not skipped (the original stays untouched in Storage either way)", () => {
  it("downloads a HEIC photo like any other, decodes it via heic-convert, and runs the result through the same resize pipeline", async () => {
    const decodedJpeg = await tinyJpegBuffer();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("fake heic bytes")), { status: 200 }));
    mockConvertHeic.mockResolvedValueOnce(new Uint8Array(decodedJpeg));

    const { blocks, skipped } = await prepareAutoGroupImageInputs(
      [{ id: "heic-1", storagePath: "owner/draft/heic-1.heic", mimeType: "image/heic" }],
      "listing-drafts",
    );

    expect(skipped).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(mockConvertHeic).toHaveBeenCalledWith(expect.objectContaining({ format: "JPEG" }));
    const source = blocks[0].content.source as { type: string; media_type: string; data: string };
    expect(source.media_type).toBe("image/jpeg");
    // Still goes through the real resize step afterward — bounded the same as any other format.
    const metadata = await sharp(Buffer.from(source.data, "base64")).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1024);
  });

  it("also decodes HEIF via the same path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("fake heif bytes")), { status: 200 }));
    mockConvertHeic.mockResolvedValueOnce(new Uint8Array(await tinyJpegBuffer()));
    const { blocks, skipped } = await prepareAutoGroupImageInputs(
      [{ id: "heif-1", storagePath: "owner/draft/heif-1.heif", mimeType: "image/heif" }],
      "listing-drafts",
    );
    expect(skipped).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });

  it("never touches or re-uploads the original — only ever fetches it once into memory for this one call", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("fake heic bytes")), { status: 200 }));
    mockConvertHeic.mockResolvedValueOnce(new Uint8Array(await tinyJpegBuffer()));
    await prepareAutoGroupImageInputs([{ id: "heic-1", storagePath: "owner/draft/heic-1.heic", mimeType: "image/heic" }], "listing-drafts");
    expect(fetchMock).toHaveBeenCalledTimes(1); // one read, no write/PUT of any kind
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").not.toBe("PUT");
  });

  it("REGRESSION: a genuine HEIC decode failure is skipped, exactly like any other unreadable photo — never thrown, never aborts the batch", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("corrupt heic bytes")), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(await tinyJpegBuffer()), { status: 200 }));
    mockConvertHeic.mockRejectedValueOnce(new Error("unsupported HEIC variant"));

    const { blocks, skipped } = await prepareAutoGroupImageInputs(
      [
        { id: "bad-heic", storagePath: "owner/draft/bad-heic.heic", mimeType: "image/heic" },
        { id: "fine-jpeg", storagePath: "owner/draft/fine.jpg", mimeType: "image/jpeg" },
      ],
      "listing-drafts",
    );
    expect(skipped).toEqual([{ imageId: "bad-heic", reason: expect.stringContaining("HEIC") }]);
    expect(blocks.map(b => b.imageId)).toEqual(["fine-jpeg"]);
  });
});

describe("prepareAutoGroupImageInputs — one bad photo never aborts the whole batch", () => {
  it("skips a photo whose download fails, but still successfully prepares the others in the same batch", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(await tinyJpegBuffer()), { status: 200 }));
    const { blocks, skipped } = await prepareAutoGroupImageInputs(
      [
        { id: "broken", storagePath: "owner/draft/broken.jpg", mimeType: "image/jpeg" },
        { id: "fine", storagePath: "owner/draft/fine.jpg", mimeType: "image/jpeg" },
      ],
      "listing-drafts",
    );
    expect(skipped.map(s => s.imageId)).toEqual(["broken"]);
    expect(blocks.map(b => b.imageId)).toEqual(["fine"]);
  });

  it("skips a photo that isn't actually decodable as an image, without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("this is not image data")), { status: 200 }));
    const { blocks, skipped } = await prepareAutoGroupImageInputs(
      [{ id: "corrupt", storagePath: "owner/draft/corrupt.jpg", mimeType: "image/jpeg" }],
      "listing-drafts",
    );
    expect(blocks).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });
});
