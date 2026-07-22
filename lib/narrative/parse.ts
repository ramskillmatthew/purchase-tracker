/**
 * Parses a small, deliberately narrow subset of markdown (headings,
 * horizontal rules, paragraphs, nested "- "/"* " bullet lists, and
 * "|"-delimited tables) out of Claude's free-text answer into a plain data
 * structure — never through an HTML string or a general-purpose markdown
 * library. Claude's context for this answer includes raw email content,
 * which is untrusted (see lib/anthropic/assistant.ts's
 * SYNTHESIS_SYSTEM_PROMPT); rendering anything derived from that text via
 * dangerouslySetInnerHTML would be a stored-XSS risk if adversarial email
 * content ever influenced the model's wording. The caller
 * (app/email-assistant) renders each block as plain React elements instead,
 * so no HTML is ever parsed or injected.
 */

export type InlineSegment = { text: string; bold: boolean };
export type ListItem = { segments: InlineSegment[]; children: ListItem[] };
export type NarrativeBlock =
  | { type: "heading"; level: 1 | 2 | 3; segments: InlineSegment[] }
  | { type: "hr" }
  | { type: "paragraph"; segments: InlineSegment[] }
  | { type: "list"; items: ListItem[] }
  | { type: "table"; headers: string[]; rows: string[][] };

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(trimmed);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(cell => cell.trim());
}

/** "# Heading", "## Heading", "### Heading" — ATX-style, levels 1-3 only
 * (a narrative answer never needs deeper nesting than that). */
function parseHeadingLine(line: string): { level: 1 | 2 | 3; text: string } | null {
  const match = line.match(/^(#{1,3})\s+(.+)$/);
  return match ? { level: match[1].length as 1 | 2 | 3, text: match[2].trim() } : null;
}

/** "---", "***", "___", optionally space-separated ("- - -") — a line made
 * up of three or more of the same rule character and nothing else. */
function isHorizontalRuleLine(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, "");
  return compact.length >= 3 && (/^-+$/.test(compact) || /^\*+$/.test(compact) || /^_+$/.test(compact));
}

/** Splits "plain text **bold text** more plain text" into segments —
 * inline formatting rendered as React elements later, never as HTML. */
function parseInline(text: string): InlineSegment[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(part =>
    part.startsWith("**") && part.endsWith("**") ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false },
  );
}

function isBulletLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function bulletIndent(line: string): number {
  return line.match(/^(\s*)[-*]\s+/)?.[1].length ?? 0;
}

/**
 * Builds a nested list tree from consecutive bullet lines, using each
 * line's leading-whitespace depth relative to its predecessors — any
 * increase in indentation starts a new nested level under the last item at
 * the previous level, matching how nested markdown lists are normally
 * written, without assuming a fixed indent width.
 */
function parseListBlock(lines: string[], startIndex: number): { items: ListItem[]; nextIndex: number } {
  let index = startIndex;
  const root: ListItem[] = [];
  const stack: { indent: number; items: ListItem[] }[] = [{ indent: -1, items: root }];

  while (index < lines.length && isBulletLine(lines[index])) {
    const indent = bulletIndent(lines[index]);
    const text = lines[index].replace(/^\s*[-*]\s+/, "").trim();
    const item: ListItem = { segments: parseInline(text), children: [] };

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].items.push(item);
    stack.push({ indent, items: item.children });

    index += 1;
  }

  return { items: root, nextIndex: index };
}

export function parseNarrative(text: string): NarrativeBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: NarrativeBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const heading = parseHeadingLine(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, segments: parseInline(heading.text) });
      index += 1;
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) { rows.push(splitTableRow(lines[index])); index += 1; }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Checked after the table branch (a "---" separator row only ever
    // appears directly under a table header, which the branch above
    // already consumed) so a standalone rule line is never mistaken for an
    // incomplete table.
    if (isHorizontalRuleLine(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (isBulletLine(line)) {
      const { items, nextIndex } = parseListBlock(lines, index);
      blocks.push({ type: "list", items });
      index = nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length && lines[index].trim() && !isBulletLine(lines[index]) && !isTableRow(lines[index])
      && !isHorizontalRuleLine(lines[index]) && !parseHeadingLine(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", segments: parseInline(paragraphLines.join(" ")) });
  }

  return blocks;
}
