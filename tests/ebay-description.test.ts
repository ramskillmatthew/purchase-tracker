import { describe, expect, it } from "vitest";
import { isAllowedEbayDescriptionUrl, htmlToPlainText } from "../vinted-draft-queue-extension/shared/ebay-description.js";

describe("htmlToPlainText", () => {
  it("REGRESSION: decodes HTML entities, preserves every list entry, and produces useful line breaks with no scripts/styles", () => {
    const html = `
      <html><head><style>.x{color:red}</style></head><body>
      <script>alert('evil')</script>
      <p>Brand New &amp; Unopened</p>
      <ul>
        <li>La Mer mascara</li>
        <li>MAC lipstick</li>
      </ul>
      </body></html>
    `;
    const text = htmlToPlainText(html);
    expect(text).toContain("Brand New & Unopened");
    expect(text).not.toContain("Brand New &amp; Unopened");
    expect(text).toContain("• La Mer mascara");
    expect(text).toContain("• MAC lipstick");
    expect(text).not.toContain("alert(");
    expect(text).not.toContain("color:red");
    // Paragraph and list are on separate lines, not squashed into one line.
    const lines = text.split("\n").map((line: string) => line.trim()).filter(Boolean);
    expect(lines).toContain("Brand New & Unopened");
    expect(lines.some((line: string) => line === "• La Mer mascara")).toBe(true);
    expect(lines.some((line: string) => line === "• MAC lipstick")).toBe(true);
  });

  it("preserves a long multi-paragraph seller description in full — never truncates or summarises", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `<p>Paragraph number ${i + 1} of the seller's full description.</p>`).join("\n");
    const text = htmlToPlainText(paragraphs);
    for (let i = 1; i <= 20; i++) expect(text).toContain(`Paragraph number ${i} of the seller's full description.`);
  });

  it("converts <br> to a line break", () => {
    const text = htmlToPlainText("Line one<br>Line two<br/>Line three");
    expect(text.split("\n").map((l: string) => l.trim())).toEqual(["Line one", "Line two", "Line three"]);
  });

  it("decodes numeric and hex character references", () => {
    expect(htmlToPlainText("Caf&#233; &#x2019;tis the season")).toBe("Café ’tis the season");
  });

  it("decodes common typographic entities real seller descriptions use", () => {
    expect(htmlToPlainText("Price: &pound;25 &mdash; ships &hellip; &ldquo;great gift&rdquo;")).toBe("Price: £25 — ships … “great gift”");
  });

  it("removes noscript and head content entirely, not just their tags", () => {
    const text = htmlToPlainText("<head><title>hidden</title></head><noscript>hidden too</noscript><p>Visible text</p>");
    expect(text).not.toContain("hidden");
    expect(text).toContain("Visible text");
  });

  it("never throws and returns an empty string for non-string input", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(undefined)).toBe("");
    expect(htmlToPlainText(123)).toBe("");
  });

  it("returns an empty string for empty/whitespace-only HTML", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("   <p></p>  ")).toBe("");
  });
});

describe("isAllowedEbayDescriptionUrl", () => {
  it("REQUIREMENT: accepts an HTTPS ebaydesc.com URL", () => {
    expect(isAllowedEbayDescriptionUrl("https://ebaydesc.com/itmdesc/267750791701")).toBe(true);
  });

  it("REQUIREMENT: accepts an HTTPS subdomain of ebaydesc.com (the real itm.ebaydesc.com host)", () => {
    expect(isAllowedEbayDescriptionUrl("https://itm.ebaydesc.com/itmdesc/267750791701?token=abc")).toBe(true);
  });

  it("REGRESSION: rejects an unrelated domain", () => {
    expect(isAllowedEbayDescriptionUrl("https://evil.example/itmdesc/267750791701")).toBe(false);
  });

  it("REGRESSION: rejects a lookalike domain that merely contains ebaydesc.com as a substring, not a real subdomain", () => {
    expect(isAllowedEbayDescriptionUrl("https://ebaydesc.com.evil.com/itmdesc/1")).toBe(false);
    expect(isAllowedEbayDescriptionUrl("https://notebaydesc.com/itmdesc/1")).toBe(false);
    expect(isAllowedEbayDescriptionUrl("https://evilebaydesc.com/itmdesc/1")).toBe(false);
  });

  it("REGRESSION: rejects plain HTTP even for the correct host", () => {
    expect(isAllowedEbayDescriptionUrl("http://itm.ebaydesc.com/itmdesc/267750791701")).toBe(false);
  });

  it("REGRESSION: rejects an invalid URL rather than throwing", () => {
    expect(isAllowedEbayDescriptionUrl("not a url")).toBe(false);
    expect(isAllowedEbayDescriptionUrl("")).toBe(false);
    expect(isAllowedEbayDescriptionUrl(null)).toBe(false);
    expect(isAllowedEbayDescriptionUrl(undefined)).toBe(false);
  });

  it("rejects a non-https scheme such as javascript: or data:", () => {
    expect(isAllowedEbayDescriptionUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedEbayDescriptionUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });
});
