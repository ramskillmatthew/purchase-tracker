import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/listing-studio-listing-generation-ai-runtime.test.ts's and
// tests/vinted-category-selection-ai-runtime.test.ts's established
// convention: mock "server-only" and the Anthropic SDK's client, then
// exercise the real response-handling logic in
// lib/listing-studio/vinted-audience-reassessment-ai.ts.
vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }),
}));

const { runVintedAudienceTextReassessment, runVintedAudiencePhotoReassessment, describeVintedAudienceReassessmentFailure } =
  await import("@/lib/listing-studio/vinted-audience-reassessment-ai");

const textInput = { brand: "New Balance", model: "327", productType: "Trainers", priorVintedAudience: "unknown" as const, priorEvidence: [] as string[] };

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_MODEL = "test-model";
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("runVintedAudienceTextReassessment — genuine runtime path (mocked Anthropic client)", () => {
  it("returns not_configured, and never calls the API, when env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a valid forced tool call reporting mens with model evidence succeeds and carries model/usage for cost tracking", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5-20260101", usage: { input_tokens: 200, output_tokens: 15 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "mens", vintedAudienceEvidence: ["Model identified as the men's version"] } }],
    });
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.vintedAudience).toBe("mens");
      expect(outcome.vintedAudienceEvidence).toEqual(["Model identified as the men's version"]);
      expect(outcome.model).toBe("claude-sonnet-5-20260101");
      expect(outcome.inputTokens).toBe(200);
      expect(outcome.outputTokens).toBe(15);
    }
  });

  it("REGRESSION: forces the request to the single reassess_vinted_audience tool — never leaves the model free to respond with prose", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "womens", vintedAudienceEvidence: ["Style code belongs to women's release"] } }],
    });
    await runVintedAudienceTextReassessment(textInput);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tool_choice: { type: "tool", name: "reassess_vinted_audience" } }));
  });

  it("REGRESSION: never sends image content — this is the text-only variant, no photos re-sent", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "unknown", vintedAudienceEvidence: [] } }],
    });
    await runVintedAudienceTextReassessment(textInput);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages).toHaveLength(1);
    expect(typeof call.messages[0].content).toBe("string");
    expect(call.messages[0].content).not.toContain("base64");
  });

  it("includes the draft's already-stored brand/model/productType and prior audience/evidence in the request text — uses stored evidence first, never re-derives from scratch", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "unknown", vintedAudienceEvidence: [] } }],
    });
    await runVintedAudienceTextReassessment({
      brand: "New Balance", model: "327", productType: "Trainers",
      priorVintedAudience: "unknown", priorEvidence: ["Label in photo 1 shows UK 5 / EU 37.5"],
    });
    const call = mockCreate.mock.calls[0][0];
    const text = call.messages[0].content as string;
    expect(text).toContain("New Balance");
    expect(text).toContain("327");
    expect(text).toContain("Trainers");
    expect(text).toContain("Label in photo 1 shows UK 5 / EU 37.5");
  });

  it("a genuinely unisex report with explicit evidence succeeds", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "unisex", vintedAudienceEvidence: ["Explicitly marketed as one single unisex line"] } }],
    });
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.vintedAudience).toBe("unisex");
  });

  it("conflicting/insufficient text evidence can still legitimately report unknown with empty evidence", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "unknown", vintedAudienceEvidence: [] } }],
    });
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.vintedAudience).toBe("unknown");
      expect(outcome.vintedAudienceEvidence).toEqual([]);
    }
  });

  it("no tool_use block is classified as no_tool_call", async () => {
    mockCreate.mockResolvedValue({ model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "..." }] });
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("REGRESSION: a tool call whose input fails schema validation is classified as invalid_output", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "not-a-real-value", vintedAudienceEvidence: [] } }],
    });
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REGRESSION: an API/network failure is classified as request_failed and never surfaces raw error text", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset with key sk-ant-secret123"));
    const outcome = await runVintedAudienceTextReassessment(textInput);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-ant-secret123");
  });
});

describe("runVintedAudiencePhotoReassessment — genuine runtime path (mocked Anthropic client)", () => {
  const image = (n: number) => ({
    imageId: `00000000-0000-4000-8000-00000000000${n}`,
    content: { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: `IMG${n}` } },
  });
  const images = [image(1), image(2)];

  it("REGRESSION: sends every supplied photo, unlike the text-only variant", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "mens", vintedAudienceEvidence: ["Box label explicitly says Men's"] } }],
    });
    await runVintedAudiencePhotoReassessment(images, textInput);
    const call = mockCreate.mock.calls[0][0];
    const content = call.messages[0].content;
    expect(content).toContainEqual(images[0].content);
    expect(content).toContainEqual(images[1].content);
  });

  it("a valid forced tool call succeeds and carries usage for cost tracking", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5-20260101", usage: { input_tokens: 900, output_tokens: 20 },
      content: [{ type: "tool_use", name: "reassess_vinted_audience", input: { vintedAudience: "womens", vintedAudienceEvidence: ["Box label explicitly says WMNS"] } }],
    });
    const outcome = await runVintedAudiencePhotoReassessment(images, textInput);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.vintedAudience).toBe("womens");
      expect(outcome.inputTokens).toBe(900);
      expect(outcome.outputTokens).toBe(20);
    }
  });
});

describe("describeVintedAudienceReassessmentFailure — safe, actionable, fixed messages", () => {
  it("returns a non-empty string for every failure status, never a raw internal code", () => {
    const statuses = ["not_configured", "request_failed", "no_tool_call", "invalid_output"] as const;
    for (const status of statuses) {
      const message = describeVintedAudienceReassessmentFailure(status);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(status);
    }
  });
});
