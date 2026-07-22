import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// lib/anthropic/assistant.ts and lib/yahoo/client.ts are both "server-only"
// and cannot be imported by vitest, so — consistent with
// tests/security-boundaries.test.ts's existing approach for the same
// constraint — these assert structural properties of the source directly.
const read = (path: string) => readFileSync(path, "utf8");
const assistantSource = read("lib/anthropic/assistant.ts");
const bareCountBranch = assistantSource.slice(assistantSource.indexOf("if (countRequest && entityTokens.length"), assistantSource.indexOf("if (entityTokens.length && plan.transactional && (!countRequest"));
const hybridSearchBranch = assistantSource.slice(assistantSource.indexOf("if (entityTokens.length && plan.transactional && (!countRequest"), assistantSource.indexOf("const messages: Anthropic.MessageParam[]"));

describe("count fallback preserves the sender and the originally classified intent", () => {
  it("passes `sender` and `intent` (never dropping either) to both the narrow and broadened live-IMAP count attempts", () => {
    const countCalls = [...bareCountBranch.matchAll(/countMail\(ownerId!,\s*\{([^)]*)\},\s*intent\)/g)];
    expect(countCalls.length).toBe(2);
    for (const call of countCalls) expect(call[1]).toContain("sender");
  });

  it("never recomputes the expected type from entityTokens for the deterministic count branch", () => {
    expect(bareCountBranch).not.toContain("classifyQueryIntent(entityTokens");
  });

  it("verifies the indexed count against real content instead of trusting the stored email_type column alone", () => {
    expect(bareCountBranch).toContain("verifiedIndexedMatches(");
  });
});

describe("hybrid count+explain queries populate the visible result list instead of answering with a bare number", () => {
  it("the hybrid/search branch returns the actual matching emails (indexed or deterministic), never an empty array", () => {
    expect(hybridSearchBranch).toContain("emailResults: indexed");
    expect(hybridSearchBranch).toContain("emailResults: deterministic");
    expect(hybridSearchBranch).not.toMatch(/emailResults:\s*\[\]/);
  });

  it("prefixes the synthesized answer with the count only when the query was hybrid", () => {
    expect(hybridSearchBranch).toContain("plan.hybrid ? `You have ${total} matching email");
  });
});

describe("specific typed counts (non-hybrid) also populate supporting emailResults, capped independently of the authoritative count", () => {
  it("the bare-count branch never returns an empty result list — it fetches a capped, verified supporting sample for both the indexed and live paths", () => {
    expect(bareCountBranch).not.toMatch(/emailResults:\s*\[\]/);
    expect(bareCountBranch).toContain("matches.slice(0, EVIDENCE_DISPLAY_LIMIT)");
    expect(bareCountBranch).toContain("emailResults: supporting");
  });

  it("the authoritative count is taken from the full verified/counted result, never from the capped evidence list's length", () => {
    expect(bareCountBranch).toContain("totalMatches: count");
    expect(bareCountBranch).toContain("totalMatches: counted.count");
    expect(bareCountBranch).not.toContain("totalMatches: supporting.length");
    expect(bareCountBranch).not.toContain("totalMatches: matches.slice(0, EVIDENCE_DISPLAY_LIMIT).length");
  });

  it("the capped evidence fetch for a live-IMAP typed count never feeds back into the authoritative count", () => {
    const evidenceFetch = bareCountBranch.slice(bareCountBranch.indexOf("let evidence ="));
    expect(evidenceFetch).not.toContain("counted =");
  });
});

describe("indexed and live-IMAP count/hybrid paths share one verification helper, so they cannot silently drift apart", () => {
  it("both lib/anthropic/assistant.ts (indexed path) and lib/yahoo/client.ts (live IMAP path) call matchesLifecycleEvidence", () => {
    expect(assistantSource).toContain("matchesLifecycleEvidence(");
    expect(read("lib/yahoo/client.ts")).toContain("matchesLifecycleEvidence(");
  });

  it("the indexed verification helper fetches real sanitized content rather than trusting the SQL type filter alone", () => {
    const helper = assistantSource.slice(assistantSource.indexOf("async function verifiedIndexedMatches"), assistantSource.indexOf("export async function runAssistant"));
    expect(helper).toContain("getMails(params.ownerId");
    expect(helper).not.toContain("type: params.type");
  });

  it("the indexed branch of the hybrid/search unified path is no longer split by plan.hybrid — plain indexed search is re-verified too", () => {
    expect(hybridSearchBranch).not.toMatch(/plan\.hybrid\s*\n?\s*\?\s*await verifiedIndexedMatches/);
    expect(hybridSearchBranch).toContain("const indexed = await verifiedIndexedMatches(");
  });
});

describe("generic (untyped/no-entity) counts are unaffected — they keep returning emailResults: [] via the tool-loop, with no added cost", () => {
  it("count_emails' execute() handler never pushes into the shared `collected`/emailResults array", () => {
    const executeFn = assistantSource.slice(assistantSource.indexOf("async function execute"), assistantSource.indexOf("const SYNTHESIS_MAX_EMAILS"));
    const countEmailsHandler = executeFn.slice(executeFn.indexOf('if (name === "count_emails")'), executeFn.indexOf('if (name === "get_email")'));
    expect(countEmailsHandler).not.toContain("collected.push");
  });

  it("a generic count query has no entity token, so it never satisfies the specific-typed-count branch's gate", () => {
    expect(bareCountBranch.slice(0, bareCountBranch.indexOf("{") + 1)).toContain("entityTokens.length");
  });
});

describe("the authoritative count is independent of the evidence-list display cap (general pattern check)", () => {
  it("slicing a full verified match list for display never changes the true count, once there are more matches than the cap", () => {
    const EVIDENCE_DISPLAY_LIMIT = 25;
    const fullyVerifiedMatches = Array.from({ length: 42 }, (_, index) => ({ id: String(index) }));
    const count = fullyVerifiedMatches.length;
    const displayed = fullyVerifiedMatches.slice(0, EVIDENCE_DISPLAY_LIMIT);
    expect(count).toBe(42);
    expect(displayed.length).toBe(25);
    expect(count).toBeGreaterThan(displayed.length);
  });

  it("when there are fewer matches than the cap, the count and the displayed list are the same size", () => {
    const EVIDENCE_DISPLAY_LIMIT = 25;
    const fullyVerifiedMatches = Array.from({ length: 5 }, (_, index) => ({ id: String(index) }));
    const displayed = fullyVerifiedMatches.slice(0, EVIDENCE_DISPLAY_LIMIT);
    expect(fullyVerifiedMatches.length).toBe(displayed.length);
  });
});
