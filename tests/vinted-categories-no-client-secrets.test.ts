import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Milestone 7 follow-up — "no service-role secret exposed to client
 * code." app/settings/page.tsx is a "use client" component (ships to the
 * browser); it must talk to the snapshot-import/refresh endpoints only
 * over fetch(), never by referencing a server secret directly.
 */
describe("app/settings/page.tsx — no server secrets or credentials referenced", () => {
  const source = fs.readFileSync("app/settings/page.tsx", "utf8");

  it("never references the Supabase service-role/secret key", () => {
    expect(source).not.toMatch(/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("never references the Anthropic API key", () => {
    expect(source).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("never references a Vinted cookie, session token, or auth header", () => {
    expect(source).not.toMatch(/vinted[_-]?(cookie|session|token)/i);
  });

  it("is a client component that only ever talks to the Vinted category endpoints via fetch()", () => {
    expect(source).toMatch(/"use client"/);
    expect(source).toMatch(/fetch\("\/api\/listing-studio\/vinted-categories\/import"/);
    expect(source).toMatch(/fetch\("\/api\/listing-studio\/vinted-categories\/refresh"/);
  });
});
