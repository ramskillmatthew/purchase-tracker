import { describe, expect, it } from "vitest";
import { fileIdentityKey, hasAcceptedExtension, isAcceptedFile, partitionDuplicateFiles, type SelectableFile } from "@/lib/listing-studio/file-selection";

function file(overrides: Partial<SelectableFile>): SelectableFile {
  return { name: "photo.jpg", size: 1024, type: "image/jpeg", ...overrides };
}

describe("isAcceptedFile — valid image types are accepted", () => {
  it("accepts jpeg, png, webp, heic, heif by MIME type", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(isAcceptedFile(file({ type }))).toBe(true);
    }
  });

  it("rejects an unsupported MIME type", () => {
    expect(isAcceptedFile(file({ type: "application/pdf", name: "doc.pdf" }))).toBe(false);
    expect(isAcceptedFile(file({ type: "video/mp4", name: "clip.mp4" }))).toBe(false);
  });

  it("rejects an executable disguised with an image-like name but a real unsupported type", () => {
    expect(isAcceptedFile(file({ type: "application/x-msdownload", name: "photo.jpg.exe" }))).toBe(false);
  });
});

describe("isAcceptedFile — extension fallback for HEIC/HEIF when the browser reports no/blank MIME type", () => {
  it("falls back to extension when type is empty", () => {
    expect(isAcceptedFile(file({ type: "", name: "IMG_0001.heic" }))).toBe(true);
    expect(isAcceptedFile(file({ type: "", name: "IMG_0002.HEIF" }))).toBe(true);
  });

  it("falls back to extension when type is the generic application/octet-stream", () => {
    expect(isAcceptedFile(file({ type: "application/octet-stream", name: "IMG_0003.heic" }))).toBe(true);
  });

  it("still rejects an unsupported extension even with a blank type", () => {
    expect(isAcceptedFile(file({ type: "", name: "notes.txt" }))).toBe(false);
  });
});

describe("hasAcceptedExtension", () => {
  it("recognises every accepted extension case-insensitively", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.WEBP", "a.heic", "a.HEIF"]) expect(hasAcceptedExtension(name)).toBe(true);
  });
  it("rejects an unrecognised extension", () => {
    expect(hasAcceptedExtension("a.gif")).toBe(false);
    expect(hasAcceptedExtension("a.bmp")).toBe(false);
  });
});

describe("fileIdentityKey", () => {
  it("is case-insensitive on filename and exact on size", () => {
    expect(fileIdentityKey(file({ name: "Photo.JPG", size: 100 }))).toBe(fileIdentityKey(file({ name: "photo.jpg", size: 100 })));
  });
  it("differs when size differs, even with the same filename", () => {
    expect(fileIdentityKey(file({ name: "photo.jpg", size: 100 }))).not.toBe(fileIdentityKey(file({ name: "photo.jpg", size: 200 })));
  });
});

describe("partitionDuplicateFiles — 'same image selected twice' and 'duplicate filenames' handling", () => {
  it("keeps all files unique when nothing overlaps", () => {
    const files = [file({ name: "a.jpg" }), file({ name: "b.jpg" })];
    const result = partitionDuplicateFiles(new Set(), files);
    expect(result.unique).toEqual(files);
    expect(result.duplicates).toEqual([]);
  });

  it("flags the second occurrence of the exact same file (same session) selected twice", () => {
    const a = file({ name: "a.jpg", size: 500 });
    const result = partitionDuplicateFiles(new Set(), [a, a]);
    expect(result.unique).toEqual([a]);
    expect(result.duplicates).toEqual([a]);
  });

  it("flags a file matching one already present from a prior selection (existingKeys)", () => {
    const existing = new Set([fileIdentityKey(file({ name: "a.jpg", size: 500 }))]);
    const result = partitionDuplicateFiles(existing, [file({ name: "a.jpg", size: 500 }), file({ name: "b.jpg", size: 200 })]);
    expect(result.unique.map(f => f.name)).toEqual(["b.jpg"]);
    expect(result.duplicates.map(f => f.name)).toEqual(["a.jpg"]);
  });

  it("does NOT flag two different files that merely share a filename but differ in size", () => {
    const result = partitionDuplicateFiles(new Set(), [file({ name: "a.jpg", size: 100 }), file({ name: "a.jpg", size: 200 })]);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });

  it("an empty selection returns empty results", () => {
    expect(partitionDuplicateFiles(new Set(), [])).toEqual({ unique: [], duplicates: [] });
  });
});
