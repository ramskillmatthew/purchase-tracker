import { describe, expect, it } from "vitest";
import {
  EXPORT_SCHEMA_VERSION, EXPORT_SOURCE_LABEL,
  MAX_EXPORT_LISTINGS_PER_BATCH, MAX_EXPORT_PHOTOS_PER_LISTING, MAX_EXPORT_TOTAL_BYTES,
  sanitizeExportPathSegment, buildProductFolderName, extensionForExportedPhoto, buildPhotoFileName,
  buildExportManifest, validateExportedListing, validateExportManifest,
  formatExportFolderTimestamp, buildExportRootFolderName, buildExportReadmeText,
  type ExportedListing,
} from "@/lib/listing-studio/vinted-export-schema";

function listing(overrides: Partial<ExportedListing> = {}): ExportedListing {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    draftId: "11111111-1111-4111-8111-111111111111",
    sku: "AA1711",
    title: "Nike Pegasus Trainers",
    description: "desc",
    brand: "Nike",
    model: "Pegasus",
    productType: "Trainers",
    condition: "Very Good Condition",
    ukSize: "9",
    audience: "womens",
    colours: ["Black", "White"],
    materials: ["Mesh"],
    pricePence: 4500,
    priceDisplay: "£45.00",
    purchasePricePence: 1850,
    purchasePriceDisplay: "£18.50",
    vintedCategoryId: 1906,
    vintedCategoryPath: "Women > Shoes > Trainers",
    photoFiles: ["photos/01.jpg", "photos/02.jpg"],
    ...overrides,
  };
}

describe("limits", () => {
  it("starts the listing batch limit at 10, per the milestone's own starting point", () => {
    expect(MAX_EXPORT_LISTINGS_PER_BATCH).toBe(10);
  });
  it("has a sane positive per-listing photo cap and total-bytes cap", () => {
    expect(MAX_EXPORT_PHOTOS_PER_LISTING).toBeGreaterThan(0);
    expect(MAX_EXPORT_TOTAL_BYTES).toBeGreaterThan(0);
  });
});

describe("sanitizeExportPathSegment — never trusts an uploaded filename/SKU as a path on its own", () => {
  it("passes through an already-safe value unchanged", () => {
    expect(sanitizeExportPathSegment("AA1711", "fallback")).toBe("AA1711");
  });

  it("strips path separators — never lets a value escape its own folder", () => {
    expect(sanitizeExportPathSegment("../../etc/passwd", "fallback")).not.toContain("..");
    expect(sanitizeExportPathSegment("../../etc/passwd", "fallback")).not.toMatch(/[\\/]/);
  });

  it("strips other unsafe characters to underscores", () => {
    expect(sanitizeExportPathSegment("AA:1711*?\"<>|", "fallback")).toBe("AA_1711______");
  });

  it("trims Windows-unsafe leading/trailing dots and spaces", () => {
    expect(sanitizeExportPathSegment("  .hidden. ", "fallback")).toBe("hidden");
  });

  it("falls back when nothing safe survives", () => {
    expect(sanitizeExportPathSegment("...", "fallback")).toBe("fallback");
    expect(sanitizeExportPathSegment("", "fallback")).toBe("fallback");
  });

  it("caps length", () => {
    const long = "A".repeat(200);
    expect(sanitizeExportPathSegment(long, "fallback").length).toBeLessThanOrEqual(60);
  });

  it("REGRESSION: a Windows reserved device name is never used bare (this app's own primary user extracts these ZIPs on Windows)", () => {
    for (const reserved of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "LPT1"]) {
      const result = sanitizeExportPathSegment(reserved, "fallback");
      expect(result.toLowerCase()).not.toBe(reserved.toLowerCase());
    }
  });
});

describe("buildProductFolderName — {3-digit index}-{SKU|draftId}, never colliding", () => {
  it("uses the SKU when present", () => {
    expect(buildProductFolderName(0, "AA1711", "draft-1")).toBe("001-AA1711");
    expect(buildProductFolderName(9, "AA1711", "draft-1")).toBe("010-AA1711");
  });

  it("falls back to the draft id when the SKU is missing", () => {
    expect(buildProductFolderName(2, null, "draft-xyz")).toBe("003-draft-xyz");
  });

  it("REGRESSION: two listings sharing the same SKU in one batch never collide — the leading index alone guarantees uniqueness", () => {
    const first = buildProductFolderName(0, "AA1711", "draft-1");
    const second = buildProductFolderName(1, "AA1711", "draft-2");
    expect(first).not.toBe(second);
    expect(first).toBe("001-AA1711");
    expect(second).toBe("002-AA1711");
  });

  it("REGRESSION: two listings both missing a SKU never collide either — draftId is always unique", () => {
    const first = buildProductFolderName(0, null, "draft-1");
    const second = buildProductFolderName(1, null, "draft-2");
    expect(first).not.toBe(second);
  });
});

describe("extensionForExportedPhoto / buildPhotoFileName", () => {
  it("maps known Vinted-supported mime types to their extension", () => {
    expect(extensionForExportedPhoto("image/jpeg", false)).toBe("jpg");
    expect(extensionForExportedPhoto("image/png", false)).toBe("png");
    expect(extensionForExportedPhoto("image/webp", false)).toBe("webp");
  });

  it("a HEIC-converted photo is always jpg regardless of its original mime type", () => {
    expect(extensionForExportedPhoto("image/heic", true)).toBe("jpg");
    expect(extensionForExportedPhoto("image/heif", true)).toBe("jpg");
  });

  it("1-indexed, 2-digit, cover photo (position 0) is always \"01\"", () => {
    expect(buildPhotoFileName(0, "jpg")).toBe("01.jpg");
    expect(buildPhotoFileName(1, "jpg")).toBe("02.jpg");
    expect(buildPhotoFileName(9, "png")).toBe("10.png");
  });
});

describe("formatExportFolderTimestamp / buildExportRootFolderName", () => {
  it("formats as YYYY-MM-DD-HHmm in UTC", () => {
    expect(formatExportFolderTimestamp("2026-08-04T14:30:00.000Z")).toBe("2026-08-04-1430");
  });

  it("pads single-digit month/day/hour/minute", () => {
    expect(formatExportFolderTimestamp("2026-01-05T03:05:00.000Z")).toBe("2026-01-05-0305");
  });

  it("root folder name is vinted-drafts-<timestamp>", () => {
    expect(buildExportRootFolderName("2026-08-04T14:30:00.000Z")).toBe("vinted-drafts-2026-08-04-1430");
  });
});

describe("validateExportedListing — the exact export contract, re-validated defensively", () => {
  it("accepts a fully-populated, valid listing", () => {
    expect(validateExportedListing(listing())).toEqual(listing());
  });

  it("rejects a wrong schemaVersion", () => {
    expect(() => validateExportedListing(listing({ schemaVersion: "vinted-export-v0" as typeof EXPORT_SCHEMA_VERSION }))).toThrow();
  });

  it("rejects a zero/negative price", () => {
    expect(() => validateExportedListing(listing({ pricePence: 0 }))).toThrow();
    expect(() => validateExportedListing(listing({ pricePence: -100 }))).toThrow();
  });

  it("rejects an empty photoFiles array — a listing can never be exported with zero photos", () => {
    expect(() => validateExportedListing(listing({ photoFiles: [] }))).toThrow();
  });

  it("rejects an unexpected extra field (strict schema)", () => {
    expect(() => validateExportedListing({ ...listing(), extra: "nope" })).toThrow();
  });

  it("accepts null model, ukSize, purchasePricePence, purchasePriceDisplay, and sku — all genuinely optional", () => {
    expect(() => validateExportedListing(listing({ model: null, ukSize: null, purchasePricePence: null, purchasePriceDisplay: null, sku: null }))).not.toThrow();
  });

  it("REGRESSION: never accepts a signed URL or credential-shaped string silently — the schema only checks shape, so this documents that callers must never pass one in; a plain string field cannot itself be rejected for content, so this is enforced by the route never constructing one, not by this schema", () => {
    // Documentation-style regression: confirms the schema has NO field
    // whose name or purpose is a URL/credential — every field name is
    // listing data only.
    const keys = Object.keys(listing());
    for (const key of keys) expect(key.toLowerCase()).not.toMatch(/url|token|secret|key|cookie|password/);
  });
});

describe("buildExportManifest / validateExportManifest", () => {
  it("builds a manifest with the exact required top-level shape", () => {
    const manifest = buildExportManifest("export-1", "2026-08-04T14:30:00.000Z", [listing()]);
    expect(manifest).toEqual({
      exportSchemaVersion: EXPORT_SCHEMA_VERSION,
      exportId: "export-1",
      createdAt: "2026-08-04T14:30:00.000Z",
      listingCount: 1,
      source: EXPORT_SOURCE_LABEL,
      listings: [listing()],
    });
  });

  it("listingCount always matches the actual listings array length", () => {
    const manifest = buildExportManifest("export-1", "2026-08-04T14:30:00.000Z", [listing(), listing({ draftId: "22222222-2222-4222-8222-222222222222" })]);
    expect(manifest.listingCount).toBe(2);
  });

  it("an empty listings array is valid (listingCount 0)", () => {
    const manifest = buildExportManifest("export-1", "2026-08-04T14:30:00.000Z", []);
    expect(() => validateExportManifest(manifest)).not.toThrow();
    expect(manifest.listingCount).toBe(0);
  });

  it("validateExportManifest re-validates every nested listing too", () => {
    const manifest = buildExportManifest("export-1", "2026-08-04T14:30:00.000Z", [listing({ pricePence: 0 })]);
    expect(() => validateExportManifest(manifest)).toThrow();
  });
});

describe("buildExportReadmeText", () => {
  it("mentions saving as a draft and never publishing", () => {
    const text = buildExportReadmeText(3);
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/never.*publish|not.*publish/i);
  });

  it("mentions stopping on an unmatched required option, never guessing", () => {
    const text = buildExportReadmeText(1);
    expect(text).toMatch(/stop/i);
    expect(text).toMatch(/never guess|never.*invent/i);
  });

  it("includes the actual listing count", () => {
    expect(buildExportReadmeText(5)).toContain("5 products");
  });
});
