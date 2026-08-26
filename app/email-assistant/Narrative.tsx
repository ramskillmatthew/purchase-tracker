"use client";
import { parseNarrative, type InlineSegment, type ListItem } from "@/lib/narrative/parse";

function InlineText({ segments }: { segments: InlineSegment[] }) {
  return <>{segments.map((segment, index) => segment.bold ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</>;
}

function ListItems({ items }: { items: ListItem[] }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>
          <InlineText segments={item.segments} />
          {item.children.length > 0 && <ListItems items={item.children} />}
        </li>
      ))}
    </ul>
  );
}

const HEADING_TAG = { 1: "h4", 2: "h5", 3: "h6" } as const;

/**
 * Renders Claude's narrative as plain React elements from a parsed block
 * structure (see lib/narrative/parse.ts) — headings, horizontal rules,
 * short paragraphs, nested bullet observations, and small tables read
 * cleanly instead of as a raw markdown dump of literal "#"/"-"/"|"
 * characters. Never uses dangerouslySetInnerHTML: the text this renders
 * comes from a model whose context includes untrusted email content, so
 * only ever rendering it as plain text nodes (never as parsed HTML) keeps
 * that untrusted content from ever becoming markup.
 */
export function Narrative({ text }: { text: string }) {
  const blocks = parseNarrative(text);
  return (
    <div className="narrative">
      {blocks.map((block, index) => {
        if (block.type === "heading") { const Tag = HEADING_TAG[block.level]; return <Tag key={index}><InlineText segments={block.segments} /></Tag>; }
        if (block.type === "hr") return <hr key={index} />;
        if (block.type === "paragraph") return <p key={index}><InlineText segments={block.segments} /></p>;
        if (block.type === "list") return <ListItems key={index} items={block.items} />;
        return (
          <table key={index}>
            <thead><tr>{block.headers.map((header, headerIndex) => <th key={headerIndex}>{header}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
          </table>
        );
      })}
    </div>
  );
}
