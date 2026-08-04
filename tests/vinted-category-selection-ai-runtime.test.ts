import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/listing-studio-listing-generation-ai-runtime.test.ts's
// established convention: mock "server-only" and the Anthropic SDK's
// client, then exercise the real response-handling logic in
// lib/listing-studio/vinted-category-selection-ai.ts.
vi.mock("server-only", () => ({}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: mockCreate } }; }),
}));

const { runVintedCategorySelection } = await import("@/lib/listing-studio/vinted-category-selection-ai");

const candidates = [
  { id: 1906, fullPath: "Women > Shoes > Trainers" },
  { id: 1907, fullPath: "Women > Shoes > Running shoes" },
];
const input = { brand: "Nike", model: "Pegasus", productType: "Trainers", audience: "women", itemFamily: "footwear" };

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_MODEL = "test-model";
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("runVintedCategorySelection — genuine runtime path (mocked Anthropic client)", () => {
  it("returns not_configured, and never calls the API, when the env vars are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await runVintedCategorySelection(input, candidates);
    expect(outcome.status).toBe("not_configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a valid forced tool call choosing a real candidate succeeds and carries model/usage for cost tracking", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5-20260101", usage: { input_tokens: 512, output_tokens: 12 },
      content: [{ type: "tool_use", name: "select_vinted_category", input: { vintedCategoryId: 1906 } }],
    });
    const outcome = await runVintedCategorySelection(input, candidates);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.vintedCategoryId).toBe(1906);
      expect(outcome.model).toBe("claude-sonnet-5-20260101");
      expect(outcome.inputTokens).toBe(512);
      expect(outcome.outputTokens).toBe(12);
    }
  });

  it("a null selection (no confident match) succeeds", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 400, output_tokens: 8 },
      content: [{ type: "tool_use", name: "select_vinted_category", input: { vintedCategoryId: null } }],
    });
    const outcome = await runVintedCategorySelection(input, candidates);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.vintedCategoryId).toBeNull();
  });

  it("REGRESSION: the tool's own JSON schema enum is built from exactly the supplied candidate ids (plus null) — never the full catalogue", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "select_vinted_category", input: { vintedCategoryId: 1906 } }],
    });
    await runVintedCategorySelection(input, candidates);
    const call = mockCreate.mock.calls[0][0];
    const enumValues = call.tools[0].input_schema.properties.vintedCategoryId.enum;
    expect(enumValues.sort()).toEqual([null, 1906, 1907].sort());
    expect(call.tool_choice).toEqual({ type: "tool", name: "select_vinted_category" });
  });

  it("REGRESSION: an out-of-candidate-set id returned by the model is rejected as invalid_output — schema-level enforcement, never trusted on its own", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "select_vinted_category", input: { vintedCategoryId: 9999 } }],
    });
    const outcome = await runVintedCategorySelection(input, candidates);
    expect(outcome.status).toBe("invalid_output");
  });

  it("REGRESSION: never sends image content — this is a bounded, text-only call, never re-sent photos", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: "select_vinted_category", input: { vintedCategoryId: 1906 } }],
    });
    await runVintedCategorySelection(input, candidates);
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages).toHaveLength(1);
    const content = call.messages[0].content;
    expect(typeof content).toBe("string");
    expect(content).not.toContain("base64");
  });

  it("no tool_use block is classified as no_tool_call", async () => {
    mockCreate.mockResolvedValue({ model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "..." }] });
    const outcome = await runVintedCategorySelection(input, candidates);
    expect(outcome.status).toBe("no_tool_call");
  });

  it("an API/network failure is classified as request_failed and never surfaces raw error text", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset with key sk-ant-secret123"));
    const outcome = await runVintedCategorySelection(input, candidates);
    expect(outcome.status).toBe("request_failed");
    expect(JSON.stringify(outcome)).not.toContain("sk-ant-secret123");
  });
});
