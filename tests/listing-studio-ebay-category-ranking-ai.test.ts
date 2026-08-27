import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }),
}));

const { runEbayCategoryRanking } = await import("@/lib/listing-studio/ebay-category-ranking-ai");

const candidates = [
  { categoryId: "183454", categoryName: "CCG Sealed Boxes", categoryPath: "Collectables > Collectable Card Games > CCG Sealed Boxes", relevancy: "180.0" },
  { categoryId: "183455", categoryName: "Individual Cards", categoryPath: "Collectables > Collectable Card Games > Individual Cards", relevancy: "165.0" },
];
const input = { brand: "Pokémon TCG", productType: "Elite Trainer Box", model: null, set: "Prismatic Evolutions", searchTerms: "Pokémon TCG Prismatic Evolutions Elite Trainer Box sealed" };

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_MODEL = "test-model";
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("runEbayCategoryRanking — genuine runtime path (mocked Anthropic client)", () => {
  it("returns not_configured, and never calls the API, when the env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runEbayCategoryRanking(input, candidates);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: uses the SAME Anthropic client/model env vars as every other AI call — no second provider", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "select_ebay_category", input: { categoryId: null, reason: "" } }] });
    await runEbayCategoryRanking(input, candidates);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
  });

  it("a valid forced tool call choosing a real candidate succeeds and carries model/usage", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5-20260101", usage: { input_tokens: 512, output_tokens: 12 },
      content: [{ type: "tool_use", name: "select_ebay_category", input: { categoryId: "183454", reason: "Matches a sealed trading card game box." } }],
    });
    const outcome = await runEbayCategoryRanking(input, candidates);
    expect(outcome).toMatchObject({ status: "success", categoryId: "183454", reason: "Matches a sealed trading card game box.", model: "claude-sonnet-5-20260101", inputTokens: 512, outputTokens: 12 });
  });

  it("REGRESSION: rejects an id the model returns that was NOT in the supplied candidate list — never trusts an invented id", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "select_ebay_category", input: { categoryId: "999999999", reason: "invented" } }] });
    const outcome = await runEbayCategoryRanking(input, candidates);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REQUIREMENT: the tool schema itself only allows the exact supplied candidate ids (plus null) — never an open string", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "select_ebay_category", input: { categoryId: null, reason: "" } }] });
    await runEbayCategoryRanking(input, candidates);
    const call = mockCreate.mock.calls[0][0];
    const tool = call.tools[0];
    expect(tool.input_schema.properties.categoryId.enum).toEqual(["183454", "183455", null]);
    expect(call.tool_choice).toEqual({ type: "tool", name: "select_ebay_category" });
  });

  it("accepts a genuine null (no confident match) as a valid success outcome", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "select_ebay_category", input: { categoryId: null, reason: "" } }] });
    const outcome = await runEbayCategoryRanking(input, candidates);
    expect(outcome).toMatchObject({ status: "success", categoryId: null });
  });

  it("no_tool_call when the model responds with prose instead of the forced tool", async () => {
    mockCreate.mockResolvedValue({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "I'm not sure." }] });
    const outcome = await runEbayCategoryRanking(input, candidates);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("request_failed on a thrown/rejected API call, never an unhandled rejection, and never leaks the raw error", async () => {
    mockCreate.mockRejectedValue(new Error("upstream secret: sk-abc123"));
    const outcome = await runEbayCategoryRanking(input, candidates);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-abc123");
  });
});
