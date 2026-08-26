import { describe, expect, it } from "vitest";
import { validatePokePulseUrl } from "@/lib/investments/providers/pokepulse-url";

describe("PokePulse URL validation", () => {
  it("accepts a real sealed URL", () => {
    const result = validatePokePulseUrl("https://pokepulse.io/sealed/celestial-storm-booster-box");
    expect(result).toEqual({ valid: true, kind: "sealed", slug: "celestial-storm-booster-box" });
  });

  it("accepts a real cards URL, including one that encodes a grade like ACE 10", () => {
    expect(validatePokePulseUrl("https://pokepulse.io/cards/mega-charizard-x-ex-125-094-holo")).toEqual({
      valid: true, kind: "cards", slug: "mega-charizard-x-ex-125-094-holo",
    });
    // A grade-encoding slug — the exact supplied URL is the identity per
    // this feature's own explicit rule; no special-casing of "ace-10"-
    // shaped segments is needed since the slug is opaque to this validator.
    const graded = validatePokePulseUrl("https://pokepulse.io/cards/mega-darkrai-ex-116-084-holo-ace-10");
    expect(graded.valid).toBe(true);
  });

  it("rejects a non-HTTPS URL", () => {
    const result = validatePokePulseUrl("http://pokepulse.io/cards/mega-charizard-x-ex-125-094-holo");
    expect(result.valid).toBe(false);
  });

  it("rejects the wrong host, including a lookalike subdomain", () => {
    expect(validatePokePulseUrl("https://evil.com/cards/foo").valid).toBe(false);
    expect(validatePokePulseUrl("https://pokepulse.io.evil.com/cards/foo").valid).toBe(false);
    expect(validatePokePulseUrl("https://not-pokepulse.io/cards/foo").valid).toBe(false);
    expect(validatePokePulseUrl("https://cdn.pokepulse.io/cards/foo").valid).toBe(false);
  });

  it("rejects a non-standard port", () => {
    expect(validatePokePulseUrl("https://pokepulse.io:8443/cards/foo").valid).toBe(false);
  });

  it("rejects embedded credentials", () => {
    expect(validatePokePulseUrl("https://user:pass@pokepulse.io/cards/foo").valid).toBe(false);
  });

  it("rejects a path that doesn't start with /sealed/ or /cards/", () => {
    expect(validatePokePulseUrl("https://pokepulse.io/products").valid).toBe(false);
    expect(validatePokePulseUrl("https://pokepulse.io/market/cards/foo").valid).toBe(false);
    expect(validatePokePulseUrl("https://pokepulse.io/").valid).toBe(false);
  });

  it("rejects a path with extra segments after the slug (traversal/query-smuggling shaped)", () => {
    expect(validatePokePulseUrl("https://pokepulse.io/cards/foo/../../admin").valid).toBe(false);
    expect(validatePokePulseUrl("https://pokepulse.io/cards/foo/extra").valid).toBe(false);
  });

  it("rejects a slug containing characters outside the observed real slug alphabet", () => {
    expect(validatePokePulseUrl("https://pokepulse.io/cards/<script>").valid).toBe(false);
    expect(validatePokePulseUrl("https://pokepulse.io/cards/foo%20bar").valid).toBe(false);
  });

  it("rejects garbage input without throwing", () => {
    expect(validatePokePulseUrl("not a url at all").valid).toBe(false);
    expect(validatePokePulseUrl("").valid).toBe(false);
  });
});
