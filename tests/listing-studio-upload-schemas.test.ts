import { describe, expect, it } from "vitest";
import { uploadSessionRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { MAX_FILES_PER_SELECTION } from "@/lib/listing-studio/upload-limits";

function file(overrides: Partial<{ filename: string; mimeType: string; fileSize: number }> = {}) {
  return { filename: "photo.jpg", mimeType: "image/jpeg", fileSize: 1_500_000, ...overrides };
}

describe("uploadSessionRequestSchema — REGRESSION: one-file and 25-file upload sessions (PGRST103 fix)", () => {
  it("accepts a single-file upload session", () => {
    const result = uploadSessionRequestSchema.safeParse({ files: [file()] });
    expect(result.success).toBe(true);
  });

  it("accepts a 25-file upload session", () => {
    const files = Array.from({ length: 25 }, (_, i) => file({ filename: `photo-${i}.jpg` }));
    const result = uploadSessionRequestSchema.safeParse({ files });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.files).toHaveLength(25);
  });

  it("accepts up to MAX_FILES_PER_SELECTION files", () => {
    const files = Array.from({ length: MAX_FILES_PER_SELECTION }, (_, i) => file({ filename: `photo-${i}.jpg` }));
    expect(uploadSessionRequestSchema.safeParse({ files }).success).toBe(true);
  });

  it("rejects more than MAX_FILES_PER_SELECTION files", () => {
    const files = Array.from({ length: MAX_FILES_PER_SELECTION + 1 }, (_, i) => file({ filename: `photo-${i}.jpg` }));
    expect(uploadSessionRequestSchema.safeParse({ files }).success).toBe(false);
  });

  it("rejects an empty file list", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [] }).success).toBe(false);
  });

  it("accepts every supported image MIME type", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(uploadSessionRequestSchema.safeParse({ files: [file({ mimeType })] }).success).toBe(true);
    }
  });

  it("rejects an unsupported MIME type", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [file({ mimeType: "application/pdf" })] }).success).toBe(false);
  });

  it("accepts an optional draftId to append to an existing group", () => {
    const result = uploadSessionRequestSchema.safeParse({ draftId: "11111111-1111-4111-8111-111111111111", files: [file()] });
    expect(result.success).toBe(true);
  });

  it("accepts draftId omitted entirely (server finds-or-creates Unsorted)", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [file()] }).success).toBe(true);
  });

  it("rejects an unexpected extra property (.strict())", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [file()], extra: true }).success).toBe(false);
  });
});
