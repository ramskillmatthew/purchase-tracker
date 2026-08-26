import { describe, expect, it } from "vitest";
import {
  buildDraftImageStoragePath,
  isPathOwnedBy,
  LISTING_STUDIO_BUCKET,
  parseDraftImageStoragePath,
  sanitizeFilenameForStorage,
} from "@/lib/listing-studio/storage-paths";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";

describe("sanitizeFilenameForStorage — never trust a raw client-supplied filename", () => {
  it("keeps a normal safe filename as-is", () => {
    expect(sanitizeFilenameForStorage("photo-01.jpg")).toBe("photo-01.jpg");
  });

  it("strips directory components from a path-like filename (Unix and Windows separators)", () => {
    expect(sanitizeFilenameForStorage("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilenameForStorage("..\\..\\windows\\system32\\evil.exe")).toBe("evil.exe");
  });

  it("replaces unsafe characters (spaces, parentheses, punctuation) with an underscore", () => {
    expect(sanitizeFilenameForStorage("my photo (1)!.jpg")).toBe("my_photo__1__.jpg");
  });

  it("strips leading dots so a filename can never resolve to a hidden/relative segment", () => {
    expect(sanitizeFilenameForStorage("...jpg")).toBe("jpg");
  });

  it("falls back to 'image' when nothing safe survives", () => {
    expect(sanitizeFilenameForStorage("../../../")).toBe("image");
    expect(sanitizeFilenameForStorage("")).toBe("image");
  });

  it("truncates an excessively long filename", () => {
    const long = `${"a".repeat(300)}.jpg`;
    expect(sanitizeFilenameForStorage(long).length).toBeLessThanOrEqual(120);
  });
});

describe("buildDraftImageStoragePath / parseDraftImageStoragePath — round trip", () => {
  it("builds the documented layout: {ownerId}/{draftId}/{imageId}-{safeFilename}", () => {
    const path = buildDraftImageStoragePath(OWNER, DRAFT, IMAGE, "photo.jpg");
    expect(path).toBe(`${OWNER}/${DRAFT}/${IMAGE}-photo.jpg`);
  });

  it("round-trips through parseDraftImageStoragePath", () => {
    const path = buildDraftImageStoragePath(OWNER, DRAFT, IMAGE, "IMG_0042.HEIC");
    expect(parseDraftImageStoragePath(path)).toEqual({ ownerId: OWNER, draftId: DRAFT, imageId: IMAGE, filename: "IMG_0042.HEIC" });
  });

  it("sanitizes a malicious filename before it ever becomes part of the path", () => {
    const path = buildDraftImageStoragePath(OWNER, DRAFT, IMAGE, "../../etc/passwd");
    expect(path).toBe(`${OWNER}/${DRAFT}/${IMAGE}-passwd`);
  });
});

describe("parseDraftImageStoragePath — rejects anything that doesn't match the exact expected shape", () => {
  it("rejects a path with the wrong number of segments", () => {
    expect(parseDraftImageStoragePath(`${OWNER}/${DRAFT}`)).toBeNull();
    expect(parseDraftImageStoragePath(`${OWNER}/${DRAFT}/${IMAGE}-x/extra`)).toBeNull();
  });

  it("rejects a path traversal attempt in the owner or draft segment (fails the UUID check)", () => {
    expect(parseDraftImageStoragePath(`../${DRAFT}/${IMAGE}-x.jpg`)).toBeNull();
    expect(parseDraftImageStoragePath(`${OWNER}/../${IMAGE}-x.jpg`)).toBeNull();
  });

  it("rejects a non-UUID owner, draft, or image id", () => {
    expect(parseDraftImageStoragePath(`not-a-uuid/${DRAFT}/${IMAGE}-x.jpg`)).toBeNull();
    expect(parseDraftImageStoragePath(`${OWNER}/not-a-uuid/${IMAGE}-x.jpg`)).toBeNull();
    expect(parseDraftImageStoragePath(`${OWNER}/${DRAFT}/not-a-uuid-x.jpg`)).toBeNull();
  });

  it("rejects a final segment with no '-' separator between image id and filename", () => {
    expect(parseDraftImageStoragePath(`${OWNER}/${DRAFT}/${IMAGE}`)).toBeNull();
  });

  it("rejects an empty filename after the separator", () => {
    expect(parseDraftImageStoragePath(`${OWNER}/${DRAFT}/${IMAGE}-`)).toBeNull();
  });
});

describe("isPathOwnedBy — the authorization check an upload-confirmation route must run", () => {
  const path = buildDraftImageStoragePath(OWNER, DRAFT, IMAGE, "photo.jpg");

  it("true when the path's owner and draft match the authenticated owner/draft", () => {
    expect(isPathOwnedBy(path, OWNER, DRAFT)).toBe(true);
  });

  it("false when the path belongs to a different owner", () => {
    expect(isPathOwnedBy(path, "44444444-4444-4444-8444-444444444444", DRAFT)).toBe(false);
  });

  it("false when the path belongs to a different draft (even the same owner)", () => {
    expect(isPathOwnedBy(path, OWNER, "55555555-5555-4555-8555-555555555555")).toBe(false);
  });

  it("false for a path that doesn't parse at all", () => {
    expect(isPathOwnedBy("garbage", OWNER, DRAFT)).toBe(false);
  });
});

describe("LISTING_STUDIO_BUCKET", () => {
  it("matches the bucket name created in supabase-listing-studio.sql", () => {
    expect(LISTING_STUDIO_BUCKET).toBe("listing-drafts");
  });
});
