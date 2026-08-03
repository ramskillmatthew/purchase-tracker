import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

const mockCreateSignedDownloadUrl = vi.fn();
vi.mock("@/lib/listing-studio/storage-rest", () => ({
  createSignedDownloadUrl: (...args: unknown[]) => mockCreateSignedDownloadUrl(...args),
}));

// heic-convert does a real WASM HEVC decode, which needs a genuine
// HEIC-encoded fixture this test suite doesn't have — mocked here so the
// HEIC-specific behaviour can still be exercised without a real fixture,
// mirroring tests/listing-studio-auto-group-image-input.test.ts's own
// convention exactly. The non-HEIC resize path below still runs real sharp
// code end-to-end.
const mockConvertHeic = vi.fn();
vi.mock("heic-convert", () => ({ default: (...args: unknown[]) => mockConvertHeic(...args) }));

const { prepareListingGenerationImageInputs } = await import("@/lib/listing-studio/listing-generation-image-input");

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
  // A real, genuinely-decodable image, well over both this pass's and
  // grouping's resize ceilings, so a real resize actually has to happen.
  return sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
}

describe("prepareListingGenerationImageInputs — resizing/optimising real photos for label/SKU reading", () => {
  it("resizes a real oversized photo down to the configured max dimension and re-encodes it as a base64 JPEG block", async () => {
    const original = await tinyJpegBuffer();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(original), { status: 200 }));
    const { blocks, skipped } = await prepareListingGenerationImageInputs(
      [{ id: "photo-1", storagePath: "owner/draft/photo-1.jpg", mimeType: "image/jpeg" }],
      "listing-drafts",
    );
    expect(skipped).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].imageId).toBe("photo-1");
    const source = blocks[0].content.source as { type: string; media_type: string; data: string };
    expect(source.type).toBe("base64");
    expect(source.media_type).toBe("image/jpeg");

    const resizedBuffer = Buffer.from(source.data, "base64");
    const metadata = await sharp(resizedBuffer).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1568);
    expect(metadata.height).toBeLessThanOrEqual(1568);
    expect(resizedBuffer.length).toBeLessThan(original.length);
  });

  it("REGRESSION: resizes to a noticeably HIGHER ceiling than grouping's own 1024px — this pass must read fine label/SKU text grouping never needed to", async () => {
    // A photo between the two ceilings (1024 < side <= 1568) would be
    // shrunk by grouping's pipeline but must survive here at full size.
    const between = await sharp({ create: { width: 1400, height: 1400, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(between), { status: 200 }));
    const { blocks } = await prepareListingGenerationImageInputs(
      [{ id: "photo-1", storagePath: "owner/draft/photo-1.jpg", mimeType: "image/jpeg" }],
      "listing-drafts",
    );
    const source = blocks[0].content.source as { data: string };
    const metadata = await sharp(Buffer.from(source.data, "base64")).metadata();
    expect(metadata.width).toBe(1400); // untouched — well under 1568, never enlarged either
  });

  it("mints a signed download URL for the real Storage bucket/path rather than reading anything by guesswork", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(await tinyJpegBuffer()), { status: 200 }));
    await prepareListingGenerationImageInputs([{ id: "photo-1", storagePath: "owner/draft/photo-1.jpg", mimeType: "image/jpeg" }], "listing-drafts");
    expect(mockCreateSignedDownloadUrl).toHaveBeenCalledWith("listing-drafts", "owner/draft/photo-1.jpg", expect.any(Number));
  });
});

describe("prepareListingGenerationImageInputs — HEIC/HEIF is decoded, not skipped", () => {
  it("downloads a HEIC photo like any other, decodes it via heic-convert, and runs the result through the same resize pipeline", async () => {
    const decodedJpeg = await tinyJpegBuffer();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("fake heic bytes")), { status: 200 }));
    mockConvertHeic.mockResolvedValueOnce(new Uint8Array(decodedJpeg));

    const { blocks, skipped } = await prepareListingGenerationImageInputs(
      [{ id: "heic-1", storagePath: "owner/draft/heic-1.heic", mimeType: "image/heic" }],
      "listing-drafts",
    );

    expect(skipped).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(mockConvertHeic).toHaveBeenCalledWith(expect.objectContaining({ format: "JPEG" }));
    const source = blocks[0].content.source as { media_type: string; data: string };
    expect(source.media_type).toBe("image/jpeg");
    const metadata = await sharp(Buffer.from(source.data, "base64")).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1568);
  });

  it("REGRESSION: a genuine HEIC decode failure is skipped, exactly like any other unreadable photo — never thrown, never aborts the group's generation", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from("corrupt heic bytes")), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(await tinyJpegBuffer()), { status: 200 }));
    mockConvertHeic.mockRejectedValueOnce(new Error("unsupported HEIC variant"));

    const { blocks, skipped } = await prepareListingGenerationImageInputs(
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

describe("prepareListingGenerationImageInputs — one bad photo never aborts the whole group", () => {
  it("skips a photo whose download fails, but still successfully prepares the others in the same group", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(await tinyJpegBuffer()), { status: 200 }));
    const { blocks, skipped } = await prepareListingGenerationImageInputs(
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
    const { blocks, skipped } = await prepareListingGenerationImageInputs(
      [{ id: "corrupt", storagePath: "owner/draft/corrupt.jpg", mimeType: "image/jpeg" }],
      "listing-drafts",
    );
    expect(blocks).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });
});
