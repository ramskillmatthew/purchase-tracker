import { describe, expect, it } from "vitest";
import { parseRegistrationFailure } from "@/lib/listing-studio/upload-error-messages";

describe("parseRegistrationFailure — network failure", () => {
  it("status 0 (fetch threw) is a chunk-scoped, retryable network error", () => {
    const result = parseRegistrationFailure(0, null);
    expect(result.reason).toBe("network_error");
    expect(result.classification).toBe("chunk_only");
    expect(result.message).toMatch(/network/i);
  });
});

describe("parseRegistrationFailure — authentication", () => {
  it("401 is a hard stop regardless of body", () => {
    const result = parseRegistrationFailure(401, {});
    expect(result.reason).toBe("unauthorized");
    expect(result.classification).toBe("hard_stop");
  });
  it("403 is also a hard stop", () => {
    expect(parseRegistrationFailure(403, {}).classification).toBe("hard_stop");
  });
});

describe("parseRegistrationFailure — structured server reasons", () => {
  it("workspace_capacity_exceeded is a hard stop with the server's own clear message", () => {
    const result = parseRegistrationFailure(400, { error: "Only 42 more photos can be added because this workspace allows 300 active photos.", reason: "workspace_capacity_exceeded" });
    expect(result.classification).toBe("hard_stop");
    expect(result.message).toBe("Only 42 more photos can be added because this workspace allows 300 active photos.");
  });

  it("storage_unavailable is a hard stop", () => {
    expect(parseRegistrationFailure(503, { error: "Storage bucket not found.", reason: "storage_unavailable" }).classification).toBe("hard_stop");
  });

  it("group_limit_exceeded is a hard stop", () => {
    expect(parseRegistrationFailure(400, { error: "Too many groups.", reason: "group_limit_exceeded" }).classification).toBe("hard_stop");
  });

  it("too_many_files is a hard stop (a client chunking bug, not a per-chunk fluke)", () => {
    expect(parseRegistrationFailure(400, { error: "Too many files.", reason: "too_many_files" }).classification).toBe("hard_stop");
  });

  it("file_too_large is scoped to this chunk only (other chunks are unaffected)", () => {
    const result = parseRegistrationFailure(400, { error: "IMG_5050.JPEG exceeds the 35MB file limit.", reason: "file_too_large" });
    expect(result.classification).toBe("chunk_only");
    expect(result.message).toContain("IMG_5050.JPEG");
  });

  it("batch_too_large is scoped to this chunk only", () => {
    expect(parseRegistrationFailure(400, { error: "This group exceeds the 500MB batch limit.", reason: "batch_too_large" }).classification).toBe("chunk_only");
  });

  it("falls back to a generic message if the server sent a known reason with no error text", () => {
    const result = parseRegistrationFailure(400, { reason: "workspace_capacity_exceeded" });
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("parseRegistrationFailure — REQUIREMENT: never exposes raw Zod output", () => {
  it("a generic 'Invalid request.' with an issues array is translated to a readable sentence, not the raw issues", () => {
    const result = parseRegistrationFailure(400, {
      error: "Invalid request.",
      issues: [{ path: ["files"], message: "Array must contain at most 60 element(s)" }],
    });
    expect(result.message).not.toContain("Array must contain at most 60 element(s)");
    expect(result.message).not.toBe("Invalid request.");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.classification).toBe("chunk_only");
  });

  it("an issues array unrelated to `files` still gets a safe generic sentence, never raw Zod text", () => {
    const result = parseRegistrationFailure(400, {
      error: "Invalid request.",
      issues: [{ path: ["draftId"], message: "Invalid uuid" }],
    });
    expect(result.message).not.toContain("Invalid uuid");
  });

  it("no reason, no issues, no useful error text at all still returns a safe, non-empty message", () => {
    const result = parseRegistrationFailure(500, {});
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.classification).toBe("chunk_only");
  });

  it("a null/undefined body never throws", () => {
    expect(() => parseRegistrationFailure(500, null)).not.toThrow();
    expect(() => parseRegistrationFailure(500, undefined)).not.toThrow();
  });
});
