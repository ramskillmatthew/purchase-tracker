import { describe, expect, it } from "vitest";
import { resolveSourceProvider, resolveSourceAccount, type SourceProvider } from "@/lib/purchase-import/provider";

describe("resolveSourceProvider", () => {
  it("resolves a Gmail-sourced email as gmail using its own signed id", () => {
    const providerById = new Map<string, SourceProvider>([["signed-gmail-token-abc", "gmail"], ["signed-yahoo-token-xyz", "yahoo"]]);
    expect(resolveSourceProvider("signed-gmail-token-abc", providerById)).toBe("gmail");
  });

  it("resolves a Yahoo-sourced email as yahoo using its own signed id", () => {
    const providerById = new Map<string, SourceProvider>([["signed-gmail-token-abc", "gmail"], ["signed-yahoo-token-xyz", "yahoo"]]);
    expect(resolveSourceProvider("signed-yahoo-token-xyz", providerById)).toBe("yahoo");
  });

  it("REGRESSION: never falls back to yahoo when the id doesn't match — this was the root cause (looking up by order.messageId, a different identifier space per provider, instead of the email's own signed id used to fetch it)", () => {
    const providerById = new Map<string, SourceProvider>([["signed-gmail-token-abc", "gmail"]]);
    // A Gmail email's order.messageId looks like "gmail:<id>" — simulating
    // the old bug of looking that up instead of the signed id.
    expect(resolveSourceProvider("gmail:184abc0def123456", providerById)).toBeNull();
    // A Yahoo email's order.messageId is its raw RFC Message-ID header —
    // also never a key in this map.
    expect(resolveSourceProvider("<CAB1234@mail.yahoo.com>", providerById)).toBeNull();
  });

  it("returns null (never a guessed provider) for any unrecognized id", () => {
    expect(resolveSourceProvider("unknown-id", new Map())).toBeNull();
  });
});

describe("resolveSourceAccount", () => {
  it("REGRESSION: a Gmail candidate is attributed to the connected Gmail address, never the Yahoo mailbox", () => {
    expect(resolveSourceAccount("gmail", { gmailAccountEmail: "me@gmail.com", yahooEmail: "me@yahoo.com" })).toBe("me@gmail.com");
  });

  it("a Yahoo candidate is attributed to the Yahoo mailbox address", () => {
    expect(resolveSourceAccount("yahoo", { gmailAccountEmail: "me@gmail.com", yahooEmail: "me@yahoo.com" })).toBe("me@yahoo.com");
  });

  it("returns null when the relevant account isn't connected/configured, rather than the other provider's address", () => {
    expect(resolveSourceAccount("gmail", { gmailAccountEmail: null, yahooEmail: "me@yahoo.com" })).toBeNull();
  });
});
