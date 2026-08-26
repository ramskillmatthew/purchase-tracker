import { describe, expect, it } from "vitest";
import { emailSearchSchema } from "@/lib/validation/email";
import { countQueries } from "@/lib/yahoo/imap-queries";

type OrClause = { text?: string; subject?: string };
const criteria = (overrides: Record<string, unknown> = {}) => emailSearchSchema.parse({ terms: [], ...overrides });
const orClauses = (query: ReturnType<typeof countQueries>[number]) => (Array.isArray(query.or) ? (query.or as OrClause[]) : []);
const allTexts = (queries: ReturnType<typeof countQueries>) => queries.flatMap(query => (query.text ? [query.text] : orClauses(query).map(clause => clause.text))).filter((text): text is string => Boolean(text));

describe("countQueries", () => {
  it("never drops the sender when broadening — every query stays scoped to that sender, not the whole mailbox", () => {
    const withSubjectHint = countQueries(criteria({ sender: "pokemon center", terms: ["cancellation"] }));
    const broadened = countQueries(criteria({ sender: "pokemon center", terms: [] }));
    for (const queries of [withSubjectHint, broadened]) {
      expect(queries.length).toBeGreaterThan(0);
      expect(allTexts(queries).length).toBeGreaterThan(0);
    }
  });

  it("tries both the accented and unaccented Pokémon/Pokemon spelling, never silently only one", () => {
    const texts = allTexts(countQueries(criteria({ sender: "pokemon center", terms: [] })));
    expect(texts.some(text => /pokémon/i.test(text))).toBe(true);
    expect(texts.some(text => /pokemon/i.test(text) && !/pokémon/i.test(text))).toBe(true);
  });

  it("combines the sender with the cancellation subject-intent term for a typed count", () => {
    const clauses = orClauses(countQueries(criteria({ sender: "pokemon center", terms: ["cancellation"] }))[0]);
    expect(clauses.some(clause => clause.text && clause.subject === "cancelled")).toBe(true);
    expect(clauses.some(clause => /pokémon/i.test(clause.text || ""))).toBe(true);
  });

  it("broadening drops the subject-line requirement (searches more places) without dropping the sender (counts the same thing)", () => {
    const broadened = countQueries(criteria({ sender: "pokemon center", terms: [] }));
    expect(broadened).toHaveLength(1);
    expect(broadened[0].subject).toBeUndefined();
    expect(orClauses(broadened[0]).every(clause => !clause.subject)).toBe(true);
    expect(allTexts(broadened).some(text => /pokemon center|pokémon center/i.test(text))).toBe(true);
  });

  it("uses a strict From match only for a literal email address, never a broad text search", () => {
    const queries = countQueries(criteria({ sender: "orders@pokemoncenter.com", terms: ["cancellation"] }));
    expect(queries.every(query => query.from === "orders@pokemoncenter.com")).toBe(true);
  });

  describe("tier-2 broadening never uses truncated sender fragments as bare text probes", () => {
    it("does not emit \"poke\" or \"cent\" (or any other truncated/typo-deletion fragment) as a text probe", () => {
      const texts = allTexts(countQueries(criteria({ sender: "pokemon center", terms: [] })));
      expect(texts).not.toContain("poke");
      expect(texts).not.toContain("cent");
      for (const text of texts) expect(text.length).toBeGreaterThanOrEqual(6);
    });

    it("only emits whole-phrase spelling variants (accented/unaccented, UK/US), matching searchVariants exactly", () => {
      const texts = allTexts(countQueries(criteria({ sender: "pokemon centre", terms: [] })));
      expect(new Set(texts)).toEqual(new Set(["pokemon centre", "pokemon center", "pokémon centre", "pokémon center"]));
    });

    it("resolves UK/US spelling and accented/unaccented Pokémon Center to the same underlying set of probes either way", () => {
      const lower = (texts: string[]) => new Set(texts.map(text => text.toLowerCase()));
      const fromUnaccentedUS = lower(allTexts(countQueries(criteria({ sender: "pokemon center", terms: [] }))));
      const fromAccentedUK = lower(allTexts(countQueries(criteria({ sender: "Pokémon Centre", terms: [] }))));
      expect(fromUnaccentedUS).toEqual(fromAccentedUK);
    });

    it("still preserves the sender constraint after tightening — never falls back to an unrestricted mailbox-wide search", () => {
      const texts = allTexts(countQueries(criteria({ sender: "meaco", terms: [] })));
      expect(texts).toEqual(["meaco"]);
    });
  });
});
