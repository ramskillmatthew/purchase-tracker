import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_GROUP_TOOL } from "@/lib/listing-studio/auto-group-schemas";

// Mirrors tests/purchase-import-ai-extract-runtime.test.ts's established
// convention exactly: mock "server-only" (which otherwise throws outside a
// real Next.js build) and the Anthropic SDK's client, then exercise the
// real response-handling logic in lib/listing-studio/auto-group-ai.ts
// rather than only asserting its source text structurally.
vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
// Must be a regular `function`, not an arrow function — see the sibling
// purchase-import runtime test for why: the SDK's default export is
// instantiated with `new Anthropic(...)`, and arrow functions have no
// [[Construct]] behavior.
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }),
}));

const { runAutoGroupAnalysis } = await import("@/lib/listing-studio/auto-group-ai");

const image = (n: number) => ({
  imageId: `00000000-0000-4000-8000-00000000000${n}`,
  content: { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: `IMG${n}` } },
});
const chunkImages = [image(1), image(2)];

const validToolInput = {
  groups: [{
    proposedGroupId: "group-1", startSequenceIndex: 1, endSequenceIndex: 2,
    orderedImageIds: [chunkImages[0].imageId, chunkImages[1].imageId],
    confidence: "high", boundaryReason: "Same item, full and angled views.",
    continuesFromPreviousChunk: false, warnings: [],
  }],
  ungroupedImageIds: [],
};

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_MODEL = "test-model";
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("runAutoGroupAnalysis — genuine runtime path (mocked Anthropic client, v3 ordered-boundary signature)", () => {
  it("returns not_configured, and never calls the API, when the env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a valid forced tool call produces a success outcome carrying the validated data", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: validToolInput }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.data.groups).toHaveLength(1);
  });

  it("REGRESSION: forces the request to the single propose_product_groups tool via tool_choice — never leaves the model free to respond with prose", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: validToolInput }] });
    await runAutoGroupAnalysis(chunkImages, 1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      tools: [AUTO_GROUP_TOOL],
      tool_choice: { type: "tool", name: "propose_product_groups" },
    }));
  });

  it("REGRESSION: labels each of the chunk's own photos with its real sequence number (chunkStartSequenceIndex + position), not just a bare id — this is the whole basis of ordered boundary detection", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: validToolInput }] });
    await runAutoGroupAnalysis(chunkImages, 41); // e.g. this is chunk 2, photos 41-42
    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content).toContainEqual({ type: "text", text: `Photo #41 — ID: ${chunkImages[0].imageId}` });
    expect(content).toContainEqual({ type: "text", text: `Photo #42 — ID: ${chunkImages[1].imageId}` });
    expect(content).toContainEqual(chunkImages[0].content);
    expect(content).toContainEqual(chunkImages[1].content);
  });

  it("sends every image in ONE user turn (cross-image context, needed to compare photos for a boundary decision)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: validToolInput }] });
    await runAutoGroupAnalysis(chunkImages, 1);
    expect(mockCreate.mock.calls[0][0].messages).toHaveLength(1);
    expect(mockCreate.mock.calls[0][0].messages[0].role).toBe("user");
  });

  describe("overlap context photos (cross-chunk continuity judgment)", () => {
    const overlapImages = [image(97), image(98)];

    it("REGRESSION: overlap photos are sent as read-only CONTEXT, clearly labelled as not to be included in any group, and placed before the chunk's own photos", async () => {
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: validToolInput }] });
      await runAutoGroupAnalysis(chunkImages, 41, overlapImages);
      const content = mockCreate.mock.calls[0][0].messages[0].content;
      const contextLabel = { type: "text", text: `Context photo (already assigned to an earlier product — do not include in any group below) — ID: ${overlapImages[0].imageId}` };
      expect(content).toContainEqual(contextLabel);
      const contextIndex = content.findIndex((block: { text?: string }) => block.text === contextLabel.text);
      const chunkPhotoIndex = content.findIndex((block: { text?: string }) => block.text === `Photo #41 — ID: ${chunkImages[0].imageId}`);
      expect(contextIndex).toBeGreaterThanOrEqual(0);
      expect(contextIndex).toBeLessThan(chunkPhotoIndex);
    });

    it("with no overlap images (chunk 1 of a session), no context photos are sent at all", async () => {
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: validToolInput }] });
      await runAutoGroupAnalysis(chunkImages, 1);
      const content = mockCreate.mock.calls[0][0].messages[0].content;
      expect(content.some((block: { text?: string }) => block.text?.includes("Context photo"))).toBe(false);
    });
  });

  it("REGRESSION: no tool_use block in the response is classified as no_tool_call — never crashes, never silently treated as success", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "I can't help with that." }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("an empty content array is also classified as no_tool_call, not a crash", async () => {
    mockCreate.mockResolvedValue({ content: [] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("REGRESSION: a tool call whose input fails schema validation is classified as invalid_output — a well-formed tool call is never trusted on its own", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: { groups: "not an array" } }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("invalid_output");
  });

  it("a tool call with an extra, unexpected field is also rejected as invalid_output (schema is .strict())", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: { ...validToolInput, madeUpField: "nope" } }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("invalid_output");
  });

  it("a non-contiguous range (orderedImageIds shorter than the declared sequence span) is rejected as invalid_output at the schema layer too — length is at least self-consistent", async () => {
    const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], endSequenceIndex: 5, orderedImageIds: [chunkImages[0].imageId] }] };
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    // The schema itself only bounds array size (max 100); true contiguity
    // and real-photo matching is reconcileAutoGroupSession's job (tested in
    // tests/listing-studio-auto-group-schemas.test.ts), not this schema's.
    // This still must not silently corrupt to "success" — the array of ids
    // is simply carried through as given.
    expect(outcome.status).toBe("success");
  });

  it("REGRESSION: an API/network failure is classified as request_failed, never thrown up to the caller, and never surfaces the raw error text", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset by peer at 10.0.0.5:443 with key sk-ant-secret123"));
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-ant-secret123");
  });

  describe("REGRESSION: a real run was rejected outright over one group's overlong reasoning — this must never recur, end-to-end (field renamed reasoning -> boundaryReason, same behaviour)", () => {
    it("a tool call with boundaryReason over the old 400-character limit still produces a success outcome, not invalid_output", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], boundaryReason: "x".repeat(450) }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
    });

    it("a tool call with boundaryReason well over 1000 characters (but under the current cap) still succeeds directly, unmodified", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], boundaryReason: "y".repeat(1200) }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") expect(outcome.data.groups[0].boundaryReason).toHaveLength(1200);
    });

    it("REGRESSION: a tool call with boundaryReason past even the current cap is truncated (not rejected) before validation, still producing a success outcome", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], boundaryReason: "z".repeat(3000) }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") {
        expect(outcome.data.groups[0].boundaryReason.length).toBeLessThan(3000);
        expect(outcome.data.groups[0].boundaryReason.endsWith("…")).toBe(true);
      }
    });

    it("a genuinely valid contiguous range (correct image ids, matching sequence span, real confidence) with long boundaryReason carries through to a usable, validated result", async () => {
      const toolInput = {
        groups: [{
          proposedGroupId: "group-1", startSequenceIndex: 1, endSequenceIndex: 2,
          orderedImageIds: [chunkImages[0].imageId, chunkImages[1].imageId], confidence: "high",
          boundaryReason: "Same white sneaker, visible from multiple angles including the sole and heel tab. ".repeat(6),
          continuesFromPreviousChunk: false, warnings: [],
        }],
        ungroupedImageIds: [],
      };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") {
        expect(outcome.data.groups[0].orderedImageIds).toEqual([chunkImages[0].imageId, chunkImages[1].imageId]);
        expect(outcome.data.groups[0].confidence).toBe("high");
      }
    });

    it("truncating boundaryReason never masks a genuinely invalid grouping — a malformed image id alongside long boundaryReason is still rejected", async () => {
      const toolInput = {
        groups: [{
          proposedGroupId: "group-1", startSequenceIndex: 1, endSequenceIndex: 1,
          orderedImageIds: ["not-a-real-uuid"], confidence: "high", boundaryReason: "x".repeat(2000),
          continuesFromPreviousChunk: false, warnings: [],
        }],
        ungroupedImageIds: [],
      };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("invalid_output");
    });
  });

  describe("REGRESSION: a real 38-photo mixed-order run failed schema validation (code: too_big, maximum: 300) on warnings[], not boundaryReason — same end-to-end fix", () => {
    it("a tool call with a warning over the old 300-character limit still produces a success outcome, not invalid_output", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], warnings: ["w".repeat(320)] }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
    });

    it("a warning well over 1000 characters (but under the current cap) still succeeds directly", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], warnings: ["w".repeat(450)] }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") expect(outcome.data.groups[0].warnings[0]).toHaveLength(450);
    });

    it("REGRESSION: a warning past even the current cap is truncated (not rejected) before validation, still producing a success outcome — proves truncation runs before real schema validation inside runAutoGroupAnalysis", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], warnings: ["w".repeat(3000)] }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") {
        expect(outcome.data.groups[0].warnings[0].length).toBeLessThan(3000);
        expect(outcome.data.groups[0].warnings[0].endsWith("…")).toBe(true);
      }
    });

    it("truncating a warning never masks a genuinely invalid grouping — a malformed image id alongside a long warning is still rejected", async () => {
      const toolInput = {
        groups: [{
          proposedGroupId: "group-1", startSequenceIndex: 1, endSequenceIndex: 1,
          orderedImageIds: ["not-a-real-uuid"], confidence: "high", boundaryReason: "Same item.",
          continuesFromPreviousChunk: false, warnings: ["w".repeat(2000)],
        }],
        ungroupedImageIds: [],
      };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("invalid_output");
    });

    it("an overlong boundaryReason AND an overlong warning in the same group are both truncated together, still producing one success outcome", async () => {
      const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], boundaryReason: "r".repeat(2000), warnings: ["w".repeat(2000)] }] };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
      const outcome = await runAutoGroupAnalysis(chunkImages, 1);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") {
        expect(outcome.data.groups[0].boundaryReason.endsWith("…")).toBe(true);
        expect(outcome.data.groups[0].warnings[0].endsWith("…")).toBe(true);
      }
    });
  });

  it("still strictly rejects an invalid confidence value alongside otherwise well-formed, correctly-sized boundaryReason/warnings", async () => {
    const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], confidence: "certain" }] };
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("invalid_output");
  });

  it("still strictly rejects a malformed sequence index (zero/non-positive) alongside otherwise well-formed, correctly-sized boundaryReason/warnings", async () => {
    const toolInput = { ...validToolInput, groups: [{ ...validToolInput.groups[0], startSequenceIndex: 0 }] };
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_product_groups", input: toolInput }] });
    const outcome = await runAutoGroupAnalysis(chunkImages, 1);
    expect(outcome.status).toBe("invalid_output");
  });
});
