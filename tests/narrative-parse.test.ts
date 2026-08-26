import { describe, expect, it } from "vitest";
import { parseNarrative } from "@/lib/narrative/parse";

describe("parseNarrative", () => {
  it("parses a single short paragraph", () => {
    expect(parseNarrative("Your Meaco order was cancelled on 10 Jul.")).toEqual([
      { type: "paragraph", segments: [{ text: "Your Meaco order was cancelled on 10 Jul.", bold: false }] },
    ]);
  });

  it("joins wrapped lines within one paragraph into a single block, separated by a space", () => {
    expect(parseNarrative("Line one\nLine two")).toEqual([
      { type: "paragraph", segments: [{ text: "Line one Line two", bold: false }] },
    ]);
  });

  it("splits blank-line-separated text into multiple paragraphs", () => {
    const blocks = parseNarrative("First paragraph.\n\nSecond paragraph.");
    expect(blocks).toEqual([
      { type: "paragraph", segments: [{ text: "First paragraph.", bold: false }] },
      { type: "paragraph", segments: [{ text: "Second paragraph.", bold: false }] },
    ]);
  });

  it("parses a '- ' bulleted list into a list block", () => {
    expect(parseNarrative("- Ordered 10 Jul\n- Cancelled 12 Jul")).toEqual([
      { type: "list", items: [
        { segments: [{ text: "Ordered 10 Jul", bold: false }], children: [] },
        { segments: [{ text: "Cancelled 12 Jul", bold: false }], children: [] },
      ] },
    ]);
  });

  it("parses a '* ' bulleted list the same as '- '", () => {
    expect(parseNarrative("* First\n* Second")).toEqual([
      { type: "list", items: [
        { segments: [{ text: "First", bold: false }], children: [] },
        { segments: [{ text: "Second", bold: false }], children: [] },
      ] },
    ]);
  });

  it("parses a nested bulleted list into a tree, using indentation to determine nesting depth", () => {
    const text = "- Order MC-1001\n  - Ordered 10 Jul\n  - Cancelled 12 Jul\n- Order MC-2002\n  - Ordered 11 Jul";
    expect(parseNarrative(text)).toEqual([
      { type: "list", items: [
        { segments: [{ text: "Order MC-1001", bold: false }], children: [
          { segments: [{ text: "Ordered 10 Jul", bold: false }], children: [] },
          { segments: [{ text: "Cancelled 12 Jul", bold: false }], children: [] },
        ] },
        { segments: [{ text: "Order MC-2002", bold: false }], children: [
          { segments: [{ text: "Ordered 11 Jul", bold: false }], children: [] },
        ] },
      ] },
    ]);
  });

  it("returns to the outer level once indentation decreases back", () => {
    const text = "- Outer 1\n  - Inner 1a\n- Outer 2";
    const blocks = parseNarrative(text);
    expect(blocks).toEqual([
      { type: "list", items: [
        { segments: [{ text: "Outer 1", bold: false }], children: [{ segments: [{ text: "Inner 1a", bold: false }], children: [] }] },
        { segments: [{ text: "Outer 2", bold: false }], children: [] },
      ] },
    ]);
  });

  it("parses '#'/'##'/'###' as headings, levels 1 through 3", () => {
    expect(parseNarrative("# Summary")).toEqual([{ type: "heading", level: 1, segments: [{ text: "Summary", bold: false }] }]);
    expect(parseNarrative("## Orders")).toEqual([{ type: "heading", level: 2, segments: [{ text: "Orders", bold: false }] }]);
    expect(parseNarrative("### Detail")).toEqual([{ type: "heading", level: 3, segments: [{ text: "Detail", bold: false }] }]);
  });

  it("does not treat a bare '#' hashtag-like mention mid-sentence as a heading", () => {
    expect(parseNarrative("Use the #cancelled tag.")).toEqual([
      { type: "paragraph", segments: [{ text: "Use the #cancelled tag.", bold: false }] },
    ]);
  });

  it("parses '---'/'***'/'___' as a horizontal rule", () => {
    expect(parseNarrative("---")).toEqual([{ type: "hr" }]);
    expect(parseNarrative("***")).toEqual([{ type: "hr" }]);
    expect(parseNarrative("___")).toEqual([{ type: "hr" }]);
    expect(parseNarrative("- - -")).toEqual([{ type: "hr" }]);
  });

  it("separates content before and after a horizontal rule into distinct blocks", () => {
    const blocks = parseNarrative("Summary above.\n\n---\n\nDetail below.");
    expect(blocks.map(block => block.type)).toEqual(["paragraph", "hr", "paragraph"]);
  });

  it("parses a pipe-delimited table with a header separator row", () => {
    const blocks = parseNarrative("| Order | Status |\n| --- | --- |\n| MC-1001 | Cancelled |\n| MC-2002 | Delivered |");
    expect(blocks).toEqual([
      { type: "table", headers: ["Order", "Status"], rows: [["MC-1001", "Cancelled"], ["MC-2002", "Delivered"]] },
    ]);
  });

  it("does not treat an ordinary line containing a dash as a table", () => {
    expect(parseNarrative("Your order - which cost £10 - was cancelled.")).toEqual([
      { type: "paragraph", segments: [{ text: "Your order - which cost £10 - was cancelled.", bold: false }] },
    ]);
  });

  it("parses inline **bold** segments within a paragraph", () => {
    expect(parseNarrative("This order was **cancelled**, not delivered.")).toEqual([
      { type: "paragraph", segments: [{ text: "This order was ", bold: false }, { text: "cancelled", bold: true }, { text: ", not delivered.", bold: false }] },
    ]);
  });

  it("parses inline **bold** segments within a list item", () => {
    expect(parseNarrative("- The order was **refunded** in full")).toEqual([
      { type: "list", items: [{ segments: [{ text: "The order was ", bold: false }, { text: "refunded", bold: true }, { text: " in full", bold: false }], children: [] }] },
    ]);
  });

  it("handles a mix of paragraph, list, and table blocks in one answer", () => {
    const text = "Here is what happened.\n\n- Ordered 10 Jul\n- Cancelled 12 Jul\n\n| Field | Value |\n| --- | --- |\n| Total | £20.00 |";
    const blocks = parseNarrative(text);
    expect(blocks.map(block => block.type)).toEqual(["paragraph", "list", "table"]);
  });

  it("returns an empty array for empty or whitespace-only text", () => {
    expect(parseNarrative("")).toEqual([]);
    expect(parseNarrative("   \n  \n")).toEqual([]);
  });

  it("never produces raw HTML — every block is plain data (paragraph/list/table), not a markup string", () => {
    const blocks = parseNarrative("<script>alert(1)</script>\n\n- <img src=x onerror=alert(1)>");
    for (const block of blocks) {
      expect(block).not.toHaveProperty("html");
      expect(block).not.toHaveProperty("__html");
    }
  });
});
