import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// lib/anthropic/assistant.ts is "server-only" and cannot be imported by
// vitest, so — consistent with the existing security-boundaries.test.ts /
// count-hybrid-behavior.test.ts pattern — these assert structural
// properties of the source directly. This file specifically verifies the
// Order Reconstruction phase's backward-compatibility boundaries: the bare
// count path, the hybrid count-prefix wording, and the tool-loop are all
// untouched by wiring reconstruction into synthesis.
const source = readFileSync("lib/anthropic/assistant.ts", "utf8");
const synthesizeAnswerFn = source.slice(source.indexOf("async function synthesizeAnswer"), source.indexOf("/**\n * Fetches indexed candidates"));
const bareCountBranch = source.slice(source.indexOf("if (countRequest && entityTokens.length"), source.indexOf("if (entityTokens.length && plan.transactional && (!countRequest"));
const hybridSearchBranch = source.slice(source.indexOf("if (entityTokens.length && plan.transactional && (!countRequest"), source.indexOf("const messages: Anthropic.MessageParam[]"));
const toolLoop = source.slice(source.indexOf("const messages: Anthropic.MessageParam[]"), source.indexOf("export async function suggestSearchCorrection"));
const relevantResultsFn = source.slice(source.indexOf("function relevantResults"), source.indexOf("function indexCanServe"));
const synthesisPrompt = source.slice(source.indexOf("const SYNTHESIS_SYSTEM_PROMPT ="), source.indexOf("const SYNTHESIS_SYSTEM_PROMPT =") + 3000);

describe("synthesis operates on reconstructed orders, sitting only between retrieval and the Claude call", () => {
  it("synthesizeAnswer calls reconstructOrders and renders via renderOrdersForSynthesis", () => {
    expect(synthesizeAnswerFn).toContain("reconstructOrders(emails)");
    expect(synthesizeAnswerFn).toContain("renderOrdersForSynthesis(");
  });

  it("synthesizeAnswer returns orderCount so callers never need to re-fetch/re-reconstruct for fallback wording", () => {
    expect(synthesizeAnswerFn).toContain("orderCount: orders.length");
  });
});

describe("backward compatibility: the bare count path is untouched by order reconstruction", () => {
  it("the bare-count branch never calls synthesizeAnswer or reconstructOrders", () => {
    expect(bareCountBranch).not.toContain("synthesizeAnswer(");
    expect(bareCountBranch).not.toContain("reconstructOrders(");
  });

  it("the bare-count answer still reports a count of matching emails, not orders", () => {
    expect(bareCountBranch).toContain("matching email${count === 1");
    expect(bareCountBranch).toContain("matching email${counted.count === 1");
    expect(bareCountBranch).not.toMatch(/\$\{count\}\s*order/);
  });
});

describe("backward compatibility: the hybrid count-prefix line still counts emails, not orders", () => {
  it("countPrefix reports 'matching email(s)', unchanged — only the synthesized explanation beneath it now reasons about orders", () => {
    expect(hybridSearchBranch).toContain("You have ${total} matching email${total === 1 ? \"\" : \"s\"}${period}. ");
  });

  it("the order-count-based fallback wording is separate from, and does not replace, the count-prefix line", () => {
    const countPrefixLine = hybridSearchBranch.slice(hybridSearchBranch.indexOf("const countPrefix ="), hybridSearchBranch.indexOf("const countPrefix =") + 200);
    expect(countPrefixLine).not.toContain("order");
  });
});

describe("lifecycle status regression fix: reconstruction never uses the count-narrowed type filter", () => {
  it("the bare-count branch still uses indexedType (a typed count is correctly narrow)", () => {
    expect(bareCountBranch).toContain("type: indexedType");
  });

  it("the hybrid/search branch's indexed reconstruction path uses reconstructionTypeFilter, not indexedType, so a status question still sees reversal evidence", () => {
    expect(hybridSearchBranch).toContain("type: reconstructionTypeFilter(intent, message)");
    expect(hybridSearchBranch).not.toContain("type: indexedType");
  });
});

describe("single-order queries: the orders array is narrowed for display via selectRelevantOrders, not the retrieval or synthesis evidence", () => {
  it("both hybrid/search call sites derive their display orders via selectForDisplay, which selects on the internal orders before converting to the public DTO", () => {
    const calls = [...hybridSearchBranch.matchAll(/selectForDisplay\(message, synthesized\?\.orders \?\? \[\]\)/g)];
    expect(calls.length).toBe(2);
  });

  it("selectForDisplay itself selects via selectRelevantOrders before mapping to the public DTO with toPublicOrder", () => {
    const selectForDisplayFn = source.slice(source.indexOf("function selectForDisplay"), source.indexOf("function selectForDisplay") + 400);
    expect(selectForDisplayFn).toContain("selectRelevantOrders(message, orders)");
    expect(selectForDisplayFn).toContain("selected.map(toPublicOrder)");
  });
});

describe("sidebar relevance: usedEmailIds reflects exactly the source emails behind the displayed orders, and recall is never reduced", () => {
  it("selectForDisplay derives usedEmailIds from the selected orders' own sourceEmails, deduplicated", () => {
    const selectForDisplayFn = source.slice(source.indexOf("function selectForDisplay"), source.indexOf("function selectForDisplay") + 400);
    expect(selectForDisplayFn).toContain("selected.flatMap(order => order.sourceEmails)");
  });

  it("every runAssistant return branch includes usedEmailIds, so the API response shape is always consistent", () => {
    const returnStatements = [...source.matchAll(/return \{ answer:[^;]*?\};/g)].map(match => match[0]);
    expect(returnStatements.length).toBeGreaterThan(0);
    for (const statement of returnStatements) expect(statement).toContain("usedEmailIds");
  });

  it("emailResults (the raw sidebar list) is never filtered down using usedEmailIds — only orders/usedEmailIds are derived from selection, emailResults always comes straight from retrieval", () => {
    expect(hybridSearchBranch).toContain("emailResults: indexed");
    expect(hybridSearchBranch).toContain("emailResults: deterministic");
  });
});

describe("backward compatibility: the tool-loop path is untouched", () => {
  it("the tool-loop never calls synthesizeAnswer or reconstructOrders — it has no hook point for the new layer", () => {
    expect(toolLoop).not.toContain("synthesizeAnswer(");
    expect(toolLoop).not.toContain("reconstructOrders(");
  });
});

describe("'most recent'/'latest' selection prefers genuine order-lifecycle evidence before picking a single result", () => {
  it("relevantResults narrows via preferLifecycleEvidence before the recency slice", () => {
    expect(relevantResultsFn).toContain("preferLifecycleEvidence(relevant).slice(0, 1)");
  });
});

describe("ASOS reconstruction-merge regression fix: the live hybrid/search branch never slices the candidate pool down to one email before synthesis", () => {
  it("the live branch builds its candidate set via matchingResults, not relevantResults, so a purchase's confirmation can't be stranded from a later shipment/delivery notice", () => {
    expect(hybridSearchBranch).toContain("const deterministic = matchingResults(message, initial.results);");
    expect(hybridSearchBranch).not.toContain("relevantResults(message, initial.results)");
  });

  it("matchingResults itself never slices to a single result, unlike relevantResults", () => {
    const matchingResultsFn = source.slice(source.indexOf("function matchingResults"), source.indexOf("function matchingResults") + 400);
    expect(matchingResultsFn).not.toContain(".slice(0, 1)");
  });

  it("relevantResults is still used for its other, non-reconstruction callers (unchanged)", () => {
    const toolLoopAndFallback = source.slice(source.indexOf("const messages: Anthropic.MessageParam[]"));
    expect(toolLoopAndFallback).toContain("relevantResults(message, emailResults)");
  });
});

describe("synthesis is instructed to report computed totals exactly, never recompute them itself", () => {
  it("the prompt tells Claude to report a provided total exactly and never combine currencies", () => {
    expect(synthesisPrompt).toMatch(/report that figure exactly/i);
    expect(synthesisPrompt).toMatch(/never re-add, re-derive, round, or otherwise recompute/i);
    expect(synthesisPrompt).toMatch(/never combine amounts across different currencies/i);
  });
});

describe("the deterministic refund total is appended to the answer text in code, not left only as prompt evidence", () => {
  it("synthesizeAnswer appends formatRefundTotalsSummary to the returned text when appendRefundTotal is set, including in the Claude-call-failure fallback", () => {
    expect(synthesizeAnswerFn).toContain("formatRefundTotalsSummary(orders)");
    expect(synthesizeAnswerFn).toContain("[text, refundTotalLine].filter(Boolean).join");
    expect(synthesizeAnswerFn).toContain("catch { return { text: refundTotalLine, orderCount: orders.length, orders }; }");
  });

  it("both hybrid/search call sites gate appendRefundTotal on the query's classified intent being \"refund\"", () => {
    const calls = [...hybridSearchBranch.matchAll(/synthesizeAnswer\([^)]*\{ appendRefundTotal: intent === "refund" \}\)/g)];
    expect(calls.length).toBe(2);
  });
});

describe("synthesis is instructed to distinguish purchase price from refund amount, and to explain uncertainty honestly", () => {
  it("the prompt tells Claude these are two distinct fields, and how to answer when only one is known", () => {
    expect(synthesisPrompt).toMatch(/purchase price and refund amount are two distinct fields, never the same thing/i);
    expect(synthesisPrompt).toMatch(/say plainly that the purchase price could not be determined/i);
    // The instruction explicitly names the wrong behavior ("claiming no
    // pricing information exists") as what NOT to do, framed as "rather
    // than" — i.e. the phrase appears, but only inside the prohibition.
    expect(synthesisPrompt).toMatch(/rather than claiming no pricing information exists/i);
  });
});
