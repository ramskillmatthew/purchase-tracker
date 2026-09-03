import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", async importOriginal => {
  // Phase 1/9 fix — the module under test now does `instanceof
  // AuthenticationError` etc. for safe error classification, so this
  // mock keeps the SDK's own real error classes (never mocked — they're
  // plain classes with no network/side effects of their own) and only
  // replaces the default export's constructor.
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  return { ...actual, default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }) };
});
const { APIError, AuthenticationError, RateLimitError, APIConnectionTimeoutError } = await import("@anthropic-ai/sdk");

const { runEbayListingGeneration } = await import("@/lib/listing-studio/ebay-listing-generation-ai");

const facts = {
  brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Blue", "Grey"],
  material: "Mesh", ukSize: "4", vintedAudience: "womens", notes: null, knownConditionEvidence: null,
};

function toolInput(overrides: Record<string, unknown> = {}) {
  return {
    styleCode: null, styleCodeConfidence: null, styleCodeEvidence: null,
    otherKeywords: [], conditionEvidence: null, categorySearchTerms: [], warnings: [],
    ...overrides,
  };
}

function toolResponse(input: Record<string, unknown>) {
  return { model: "claude-sonnet-5-20260101", usage: { input_tokens: 200, output_tokens: 80 }, content: [{ type: "tool_use", name: "propose_ebay_listing_facts", input }] };
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_MODEL = "test-model";
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("runEbayListingGeneration — genuine runtime path (mocked Anthropic client)", () => {
  it("returns not_configured, and never calls the API, when env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: never re-sends photos — this is a text-only call", async () => {
    mockCreate.mockResolvedValue(toolResponse(toolInput({ categorySearchTerms: ["On Running", "Cloud 5"] })));
    await runEbayListingGeneration(facts);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toEqual(expect.any(String)); // plain text, never an image content array
    expect(JSON.stringify(call.messages)).not.toMatch(/base64|image/i);
  });

  it("REQUIREMENT: uses the SAME model env var as every other AI call", async () => {
    mockCreate.mockResolvedValue(toolResponse(toolInput()));
    await runEbayListingGeneration(facts);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
  });

  it("Problem 2/3 fix: the AI response carries no title or description text at all — only structured facts", async () => {
    mockCreate.mockResolvedValue(toolResponse(toolInput({
      styleCode: "M2002RST", styleCodeConfidence: "high", styleCodeEvidence: "Visible on box label",
      otherKeywords: ["Lightweight"], conditionEvidence: "Light sole wear visible.",
      categorySearchTerms: ["On Running", "Cloud 5", "Trainers"],
    })));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.data.styleCode).toBe("M2002RST");
      expect(outcome.data.styleCodeConfidence).toBe("high");
      expect(outcome.data.conditionEvidence).toBe("Light sole wear visible.");
      expect(outcome.data).not.toHaveProperty("titleComponents");
      expect(outcome.data).not.toHaveProperty("description");
    }
  });

  it("REGRESSION (adversarial, safety-critical): rejects a response with additional/unexpected properties", async () => {
    mockCreate.mockResolvedValue(toolResponse({ ...toolInput(), title: "Not allowed" }));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REGRESSION (adversarial): rejects a styleCodeConfidence value outside the fixed enum", async () => {
    mockCreate.mockResolvedValue(toolResponse(toolInput({ styleCode: "ABC", styleCodeConfidence: "certain" })));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REGRESSION (adversarial): rejects more than 4 otherKeywords", async () => {
    mockCreate.mockResolvedValue(toolResponse(toolInput({ otherKeywords: ["a", "b", "c", "d", "e"] })));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("invalid_output");
  });

  it("no_tool_call when the model responds with prose instead of the forced tool", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Sure, here's a listing..." }] });
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("request_failed on a thrown/rejected API call, never leaking the raw error", async () => {
    mockCreate.mockRejectedValue(new Error("upstream secret: sk-abc123"));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-abc123");
  });

  // Phase 1/9 fix — this is THE exact reported failure, reproduced. A
  // real, direct call to the live Anthropic API (same system prompt, same
  // tool schema, same real garbled `notes` value pulled from the actual
  // database row for this product) returned a genuinely well-formed
  // response — except one of its warnings was 223 characters, over the
  // schema's old 200-character cap. The whole response was discarded for
  // that reason alone.
  it("REGRESSION (the exact reported bug): an otherwise-perfect response with one overlong warning is repaired and returns success, not invalid_output", async () => {
    const overlongWarning = "Model identification is medium confidence only — photo analysis suggests Cloud 5 but an earlier Cloud iteration (e.g. Cloud 3 or Cloud Classic) cannot be ruled out. Verify the exact model name before finalising the listing.";
    expect(overlongWarning.length).toBeGreaterThan(200); // proves this is genuinely the reported scenario
    mockCreate.mockResolvedValue(toolResponse(toolInput({
      categorySearchTerms: ["On Running", "Cloud 5", "Running Trainers"],
      warnings: [overlongWarning, "No condition evidence was provided."],
    })));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.data.warnings[0].length).toBeLessThanOrEqual(300);
      expect(outcome.data.warnings[0]).toContain("Model identification is medium confidence only");
    }
  });

  it("REGRESSION: repair never rescues a response missing a genuinely required field — a missing required key stays invalid_output", async () => {
    const { styleCode: _omit, ...withoutStyleCode } = toolInput();
    mockCreate.mockResolvedValue(toolResponse(withoutStyleCode));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REQUIREMENT (Phase 9): classifies a 401 as EBAY_AI_AUTH_FAILED, never the generic bucket", async () => {
    mockCreate.mockRejectedValue(new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers()));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("request_failed");
    if (outcome.status === "request_failed") expect(outcome.code).toBe("EBAY_AI_AUTH_FAILED");
  });

  it("REQUIREMENT (Phase 9): classifies a 429 as EBAY_AI_RATE_LIMITED", async () => {
    mockCreate.mockRejectedValue(new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "rate limited", new Headers()));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("request_failed");
    if (outcome.status === "request_failed") expect(outcome.code).toBe("EBAY_AI_RATE_LIMITED");
  });

  it("REQUIREMENT (Phase 9): classifies a connection timeout as EBAY_AI_TIMEOUT", async () => {
    mockCreate.mockRejectedValue(new APIConnectionTimeoutError());
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("request_failed");
    if (outcome.status === "request_failed") expect(outcome.code).toBe("EBAY_AI_TIMEOUT");
  });

  it("REQUIREMENT (Phase 9): a generic APIError still classifies safely without leaking its body", async () => {
    mockCreate.mockRejectedValue(new APIError(500, { type: "api_error", message: "upstream secret detail" }, "upstream secret detail", new Headers()));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("request_failed");
    if (outcome.status === "request_failed") expect(outcome.code).toBe("EBAY_AI_UNKNOWN");
    expect(JSON.stringify(outcome)).not.toContain("upstream secret detail");
  });

  it("REQUIREMENT (Phase 9): invalid_output carries safe field-path issues, never the model's own generated text", async () => {
    mockCreate.mockResolvedValue(toolResponse(toolInput({ styleCodeConfidence: "certain" })));
    const outcome = await runEbayListingGeneration(facts);
    expect(outcome.status).toBe("invalid_output");
    if (outcome.status === "invalid_output") {
      expect(outcome.code).toBe("EBAY_AI_VALIDATION_FAILED");
      expect(outcome.issues.length).toBeGreaterThan(0);
      expect(outcome.issues[0]).toContain("styleCodeConfidence");
    }
  });
});
