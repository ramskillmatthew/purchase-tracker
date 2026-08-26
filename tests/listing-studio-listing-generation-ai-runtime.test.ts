import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LISTING_GENERATION_TOOL } from "@/lib/listing-studio/listing-generation-schemas";

// Mirrors tests/listing-studio-auto-group-ai-runtime.test.ts's established
// convention exactly: mock "server-only" (which otherwise throws outside a
// real Next.js build) and the Anthropic SDK's client, then exercise the
// real response-handling logic in lib/listing-studio/listing-generation-ai.ts
// rather than only asserting its source text structurally.
vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
// Must be a regular `function`, not an arrow function — the SDK's default
// export is instantiated with `new Anthropic(...)`, and arrow functions
// have no [[Construct]] behavior.
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }),
}));

const { runListingGenerationAnalysis } = await import("@/lib/listing-studio/listing-generation-ai");

const image = (n: number) => ({
  imageId: `00000000-0000-4000-8000-00000000000${n}`,
  content: { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: `IMG${n}` } },
});
const images = [image(1), image(2), image(3)];

const validToolInput = {
  brand: { value: "On", confidence: "high" },
  model: { value: "Cloudmonster", confidence: "high" },
  productType: { value: "Running Trainers", confidence: "high" },
  colours: { value: ["White", "Blue"], confidence: "medium" },
  material: { value: "Mesh", confidence: "medium" },
  sourceSize: { system: "UK", value: "10.5", gender: null, confidence: "high" },
  // Follow-up correction (2026-08-04, extended 2026-08-05).
  vintedAudience: { value: "unisex", confidence: "medium" },
  vintedAudienceEvidence: ["Item design has no gendered distinction"],
  sku: { value: "1648", confidence: "high" },
  notes: null,
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

describe("runListingGenerationAnalysis — genuine runtime path (mocked Anthropic client)", () => {
  it("returns not_configured, and never calls the API, when the env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a valid forced tool call produces a success outcome carrying the validated structured fields", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: validToolInput }] });
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.data.brand.value).toBe("On");
      expect(outcome.data.sku.value).toBe("1648");
    }
  });

  it("REGRESSION: forces the request to the single propose_listing_fields tool via tool_choice — never leaves the model free to respond with prose", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: validToolInput }] });
    await runListingGenerationAnalysis(images);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      tools: [LISTING_GENERATION_TOOL],
      tool_choice: { type: "tool", name: "propose_listing_fields" },
    }));
  });

  it("sends every one of this product's photos in ONE user turn", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: validToolInput }] });
    await runListingGenerationAnalysis(images);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
    const content = call.messages[0].content;
    expect(content).toContainEqual(images[0].content);
    expect(content).toContainEqual(images[1].content);
    expect(content).toContainEqual(images[2].content);
  });

  it("REGRESSION: no tool_use block in the response is classified as no_tool_call — never crashes, never silently treated as success", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "I can't help with that." }] });
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("an empty content array is also classified as no_tool_call, not a crash", async () => {
    mockCreate.mockResolvedValue({ content: [] });
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("REGRESSION: a tool call whose input fails schema validation is classified as invalid_output — a well-formed tool call is never trusted on its own", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: { brand: "not an object" } }] });
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REGRESSION: a tool call that includes a title or description alongside otherwise-valid fields is rejected as invalid_output — the AI is never trusted to author either", async () => {
    const outcome = await (async () => {
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: { ...validToolInput, title: "On Cloudmonster" } }] });
      return runListingGenerationAnalysis(images);
    })();
    expect(outcome.status).toBe("invalid_output");
  });

  it("REGRESSION: an API/network failure is classified as request_failed, never thrown up to the caller, and never surfaces the raw error text", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset by peer at 10.0.0.5:443 with key sk-ant-secret123"));
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-ant-secret123");
  });

  it("every field may legitimately be null (nothing confidently identified) and still succeeds", async () => {
    const allBlank = {
      brand: { value: null, confidence: "low" }, model: { value: null, confidence: "low" },
      productType: { value: null, confidence: "low" }, colours: { value: [], confidence: "low" }, material: { value: null, confidence: "low" },
      sourceSize: { system: null, value: null, gender: null, confidence: "low" },
      // Follow-up correction (2026-08-04): "unknown" (never null) is
      // vintedAudience's own honest "genuinely uncertain" value.
      vintedAudience: { value: "unknown", confidence: "low" },
      vintedAudienceEvidence: [],
      sku: { value: null, confidence: "low" },
      notes: "Item too obscured to identify confidently.",
    };
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: allBlank }] });
    const outcome = await runListingGenerationAnalysis(images);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.data.brand.value).toBeNull();
      expect(outcome.data.sku.value).toBeNull();
    }
  });

  describe("REGRESSION: sourceSize is reported, never a converted ukSize — the AI must not perform the conversion itself", () => {
    it("a tool call reporting an EU size (no conversion, no ukSize field) succeeds and carries the raw system/value/gender through untouched", async () => {
      const toolInput = { ...validToolInput, sourceSize: { system: "EU", value: "44", gender: null, confidence: "high" } };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: toolInput }] });
      const outcome = await runListingGenerationAnalysis(images);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") {
        expect(outcome.data.sourceSize).toEqual({ system: "EU", value: "44", gender: null, confidence: "high" });
      }
    });

    it("a tool call reporting a US size with an explicit gender succeeds and carries gender through untouched", async () => {
      const toolInput = { ...validToolInput, sourceSize: { system: "US", value: "9", gender: "womens", confidence: "medium" } };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: toolInput }] });
      const outcome = await runListingGenerationAnalysis(images);
      expect(outcome.status).toBe("success");
      if (outcome.status === "success") {
        expect(outcome.data.sourceSize.gender).toBe("womens");
      }
    });

    it("a tool call that includes an invented 'ukSize' field alongside sourceSize is rejected as invalid_output — the AI is never trusted to convert", async () => {
      const toolInput = { ...validToolInput, ukSize: { value: "8", confidence: "high" } };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: toolInput }] });
      const outcome = await runListingGenerationAnalysis(images);
      expect(outcome.status).toBe("invalid_output");
    });

    it("an invalid sourceSize.system value (anything other than UK/EU/US) is rejected as invalid_output", async () => {
      const toolInput = { ...validToolInput, sourceSize: { system: "CM", value: "27", gender: null, confidence: "high" } };
      mockCreate.mockResolvedValue({ content: [{ type: "tool_use", name: "propose_listing_fields", input: toolInput }] });
      const outcome = await runListingGenerationAnalysis(images);
      expect(outcome.status).toBe("invalid_output");
    });
  });
});
