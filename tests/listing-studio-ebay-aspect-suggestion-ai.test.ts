import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }),
}));

const { runEbayAspectSuggestion } = await import("@/lib/listing-studio/ebay-aspect-suggestion-ai");

const aspects = [
  { name: "Game", usage: "REQUIRED" as const, mode: "SELECTION_ONLY" as const, cardinality: "SINGLE" as const, maxLength: null, allowedValues: ["Pokémon TCG", "Yu-Gi-Oh!"] },
  { name: "Features", usage: "RECOMMENDED" as const, mode: "SELECTION_ONLY" as const, cardinality: "MULTI" as const, maxLength: null, allowedValues: ["Booster Pack", "Sealed"] },
];
const input = { brand: "Pokémon TCG", productType: "Elite Trainer Box", model: null, title: "Pokémon Prismatic Evolutions ETB", knownFacts: {} };

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_MODEL = "test-model";
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("runEbayAspectSuggestion — genuine runtime path (mocked Anthropic client)", () => {
  it("returns not_configured, and never calls the API, when env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runEbayAspectSuggestion(input, aspects);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns an immediate empty success, no API call, when there are no unresolved aspects to ask about", async () => {
    const outcome = await runEbayAspectSuggestion(input, []);
    expect(outcome).toMatchObject({ status: "success", values: {} });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a valid forced tool call returns values for every requested aspect", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5-20260101", usage: { input_tokens: 300, output_tokens: 20 },
      content: [{ type: "tool_use", name: "suggest_ebay_aspects", input: { Game: "Pokémon TCG", Features: ["Sealed"] } }],
    });
    const outcome = await runEbayAspectSuggestion(input, aspects);
    expect(outcome).toMatchObject({ status: "success", values: { Game: "Pokémon TCG", Features: ["Sealed"] }, model: "claude-sonnet-5-20260101", inputTokens: 300, outputTokens: 20 });
  });

  it("REGRESSION (safety-critical): rejects a value the model returns that is NOT in that aspect's own allowed list", () => {
    mockCreate.mockResolvedValue({
      model: "test-model", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "suggest_ebay_aspects", input: { Game: "Magic: The Gathering", Features: [] } }],
    });
    return runEbayAspectSuggestion(input, aspects).then(outcome => expect(outcome.status).toBe("invalid_output"));
  });

  it("REGRESSION: rejects a MULTI aspect containing even one value outside its allowed list", async () => {
    mockCreate.mockResolvedValue({
      model: "test-model", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "suggest_ebay_aspects", input: { Game: "Pokémon TCG", Features: ["Sealed", "Invented Feature"] } }],
    });
    const outcome = await runEbayAspectSuggestion(input, aspects);
    expect(outcome.status).toBe("invalid_output");
  });

  it("accepts null / empty-array as a genuine 'not confident' answer for any aspect", async () => {
    mockCreate.mockResolvedValue({
      model: "test-model", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "suggest_ebay_aspects", input: { Game: null, Features: [] } }],
    });
    const outcome = await runEbayAspectSuggestion(input, aspects);
    expect(outcome).toMatchObject({ status: "success", values: { Game: null, Features: [] } });
  });

  it("REQUIREMENT: the tool schema's enum for each aspect is built from that exact aspect's own allowed values", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "suggest_ebay_aspects", input: { Game: null, Features: [] } }] });
    await runEbayAspectSuggestion(input, aspects);
    const tool = mockCreate.mock.calls[0][0].tools[0];
    expect(tool.input_schema.properties.Game.enum).toEqual(["Pokémon TCG", "Yu-Gi-Oh!", null]);
    expect(tool.input_schema.properties.Features.items.enum).toEqual(["Booster Pack", "Sealed"]);
  });

  it("no_tool_call when the model responds with prose instead of the forced tool", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "not sure" }] });
    const outcome = await runEbayAspectSuggestion(input, aspects);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("request_failed on a thrown/rejected API call, never leaking the raw error", async () => {
    mockCreate.mockRejectedValue(new Error("upstream secret: sk-abc123"));
    const outcome = await runEbayAspectSuggestion(input, aspects);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-abc123");
  });
});
