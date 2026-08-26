import { describe, expect, it } from "vitest";
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  isAcceptedImageMimeType,
  isHeicMimeType,
  MAX_BATCH_SIZE_BYTES,
  MAX_FILES_PER_SELECTION,
  MAX_GROUPS_IN_WORKSPACE,
  MAX_INDIVIDUAL_FILE_SIZE_BYTES,
  MAX_TOTAL_ACTIVE_UPLOAD_FILES,
  SIGNED_UPLOAD_URL_LIFETIME_SECONDS,
  SIGNED_VIEW_URL_LIFETIME_SECONDS,
} from "@/lib/listing-studio/upload-limits";

describe("isAcceptedImageMimeType", () => {
  it("accepts every type in ACCEPTED_IMAGE_MIME_TYPES", () => {
    for (const type of ACCEPTED_IMAGE_MIME_TYPES) expect(isAcceptedImageMimeType(type)).toBe(true);
  });
  it("rejects an unsupported type", () => {
    expect(isAcceptedImageMimeType("image/gif")).toBe(false);
    expect(isAcceptedImageMimeType("application/pdf")).toBe(false);
  });
});

describe("isHeicMimeType", () => {
  it("recognises image/heic and image/heif, case-insensitively", () => {
    expect(isHeicMimeType("image/heic")).toBe(true);
    expect(isHeicMimeType("IMAGE/HEIF")).toBe(true);
  });
  it("does not misclassify a non-HEIC type", () => {
    expect(isHeicMimeType("image/jpeg")).toBe(false);
  });
});

describe("upload limit constants — internal safety limits, sane and internally consistent", () => {
  it("every limit is a positive number", () => {
    for (const value of [MAX_FILES_PER_SELECTION, MAX_TOTAL_ACTIVE_UPLOAD_FILES, MAX_INDIVIDUAL_FILE_SIZE_BYTES, MAX_BATCH_SIZE_BYTES, SIGNED_UPLOAD_URL_LIFETIME_SECONDS, SIGNED_VIEW_URL_LIFETIME_SECONDS, MAX_GROUPS_IN_WORKSPACE]) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("a single file's max size never exceeds the whole batch's max size", () => {
    expect(MAX_INDIVIDUAL_FILE_SIZE_BYTES).toBeLessThanOrEqual(MAX_BATCH_SIZE_BYTES);
  });

  it("a single selection's file count never exceeds the workspace-wide active file cap", () => {
    expect(MAX_FILES_PER_SELECTION).toBeLessThanOrEqual(MAX_TOTAL_ACTIVE_UPLOAD_FILES);
  });

  it("view URLs live for a shorter time than upload URLs (re-minted on every page load vs. a slow mobile upload)", () => {
    expect(SIGNED_VIEW_URL_LIFETIME_SECONDS).toBeLessThan(SIGNED_UPLOAD_URL_LIFETIME_SECONDS);
  });
});
