import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createSignedDownloadUrl, convertHeic } = vi.hoisted(() => ({
  createSignedDownloadUrl: vi.fn(async (_bucket: string, _path: string, _seconds: number) => "https://signed.example/photo"),
  convertHeic: vi.fn(async () => new ArrayBuffer(4)),
}));
vi.mock("@/lib/listing-studio/storage-rest", () => ({ createSignedDownloadUrl }));
vi.mock("heic-convert", () => ({ default: convertHeic }));

import { prepareExportPhotos, ExportPhotoError, type ExportPhotoInput } from "@/lib/listing-studio/vinted-export-photos";

const originalFetch = global.fetch;

function image(overrides: Partial<ExportPhotoInput> = {}): ExportPhotoInput {
  return { imageId: "img-1", storagePath: "owner/draft/img-1-photo.jpg", mimeType: "image/jpeg", fileSize: 1000, ...overrides };
}

beforeEach(() => {
  createSignedDownloadUrl.mockClear();
  convertHeic.mockClear();
  global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
});

describe("prepareExportPhotos — server-side download + HEIC conversion for export, no resizing", () => {
  it("downloads a single non-HEIC photo unchanged (no conversion call)", async () => {
    const [result] = await prepareExportPhotos([image()], "bucket");
    expect(result.fileName).toBe("01.jpg");
    expect(result.bytes).toBeInstanceOf(Buffer);
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it("converts a HEIC photo to jpg", async () => {
    const [result] = await prepareExportPhotos([image({ mimeType: "image/heic" })], "bucket");
    expect(convertHeic).toHaveBeenCalledTimes(1);
    expect(result.fileName).toBe("01.jpg");
  });

  it("converts HEIF the same way as HEIC", async () => {
    await prepareExportPhotos([image({ mimeType: "image/heif" })], "bucket");
    expect(convertHeic).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: preserves exact ordering by array position, not download-completion order — a pre-sized results array is written by index, never pushed", async () => {
    // Second image resolves its fetch slower than the first, to prove
    // ordering survives even when the SECOND photo's download finishes first.
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as unknown as typeof fetch;

    const images = [image({ imageId: "first" }), image({ imageId: "second" })];
    const results = await prepareExportPhotos(images, "bucket");
    expect(results.map(r => r.imageId)).toEqual(["first", "second"]);
    expect(results.map(r => r.fileName)).toEqual(["01.jpg", "02.jpg"]);
  });

  it("cover photo (position 0) is always \"01\"", async () => {
    const results = await prepareExportPhotos([image({ imageId: "a" }), image({ imageId: "b" }), image({ imageId: "c" })], "bucket");
    expect(results[0].fileName).toBe("01.jpg");
    expect(results[1].fileName).toBe("02.jpg");
    expect(results[2].fileName).toBe("03.jpg");
  });

  it("REGRESSION: throws ExportPhotoError (never silently drops the photo) when the signed URL cannot be created", async () => {
    createSignedDownloadUrl.mockRejectedValueOnce(new Error("storage down"));
    await expect(prepareExportPhotos([image()], "bucket")).rejects.toBeInstanceOf(ExportPhotoError);
  });

  it("throws ExportPhotoError when the download itself fails (non-2xx)", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(prepareExportPhotos([image()], "bucket")).rejects.toBeInstanceOf(ExportPhotoError);
  });

  it("throws ExportPhotoError when HEIC conversion fails", async () => {
    convertHeic.mockRejectedValueOnce(new Error("bad heic"));
    await expect(prepareExportPhotos([image({ mimeType: "image/heic" })], "bucket")).rejects.toBeInstanceOf(ExportPhotoError);
  });

  it("the thrown error identifies which imageId failed", async () => {
    createSignedDownloadUrl.mockRejectedValueOnce(new Error("down"));
    try {
      await prepareExportPhotos([image({ imageId: "the-failing-one" })], "bucket");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExportPhotoError);
      expect((error as InstanceType<typeof ExportPhotoError>).imageId).toBe("the-failing-one");
    }
  });

  it("returns an empty array for an empty input", async () => {
    expect(await prepareExportPhotos([], "bucket")).toEqual([]);
  });
});

// Restore the real global.fetch after this file's tests, defensively —
// vitest normally isolates modules per file, but this avoids ever leaking
// a mocked fetch into another test file if isolation config ever changes.
afterAll(() => { global.fetch = originalFetch; });
