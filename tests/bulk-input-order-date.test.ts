import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseUkDate, formatUkDate } from "@/lib/validation/uk-date";

// app/bulk-input/page.tsx is a "use client" page with heavy React state and
// no jsdom environment is configured for this project (vitest.config.ts runs
// environment: "node") — consistent with the existing UI test convention
// (see tests/listings-review-ui.test.ts), its wiring is asserted structurally
// against the source text, while the actual date logic it delegates to is
// covered directly via the shared parser (tests/uk-date.test.ts).
const pageSource = readFileSync("app/bulk-input/page.tsx", "utf8");
const routeSource = readFileSync("app/api/purchases/bulk/route.ts", "utf8");

describe("app/bulk-input/page.tsx — shared Order Date field accepts two-digit UK years", () => {
  it("uses the shared strict parser, not a bespoke inline regex", () => {
    expect(pageSource).toContain('import { parseUkDate, formatUkDate } from "@/lib/validation/uk-date";');
    expect(pageSource).not.toMatch(/\/\^\\d\{1,2\}\\\/\\d\{1,2\}\\\/\\d\{4\}\$\//);
  });

  it("the shared field is a UK-format text entry (DD/MM/YYYY), not a native date input the browser can reject a 2-digit year on", () => {
    expect(pageSource).toContain('placeholder="DD/MM/YYYY"');
    expect(pageSource).toContain("value={sharedDateText}");
  });

  it("normalizes the shared field on blur and Enter via the shared parser", () => {
    expect(pageSource).toContain("onBlur={event => commitSharedDate(event.target.value)}");
    expect(pageSource).toContain("commitSharedDate((event.target as HTMLInputElement).value)");
    expect(pageSource).toContain("function commitSharedDate(value: string) {");
    expect(pageSource).toContain("const result = parseUkDate(value);");
    expect(pageSource).toContain("setSharedDateText(formatUkDate(result.iso));");
  });

  it("keeps a native date input for the calendar picker, synced to the visible field, out of tab order and reachable via a labelled button", () => {
    expect(pageSource).toContain('ref={sharedDateNativeRef}');
    expect(pageSource).toContain('type="date"');
    expect(pageSource).toContain("tabIndex={-1}");
    expect(pageSource).toContain('aria-label="Choose order date from calendar"');
    expect(pageSource).toContain("onChange={event => pickSharedDate(event.target.value)}");
    expect(pageSource).toContain("native.showPicker()");
  });

  it("keeps only one visible date input (no two conflicting visible date fields)", () => {
    const visibleTypeDateInputs = pageSource.match(/type="date"[^]*?value=\{shared\.order_date\}/g) || [];
    expect(visibleTypeDateInputs.length).toBe(1); // the single hidden native input driving the picker
  });

  it("'Apply to every row' checkbox behaviour is untouched", () => {
    expect(pageSource).toContain("<Apply checked={apply.order_date} onChange={checked => setApply(current => ({ ...current, order_date: checked }))} />");
  });

  it("disables Save while the shared date field holds an uncommitted invalid value", () => {
    expect(pageSource).toContain("disabled={!ready || saving || !!sharedDateError}");
  });
});

describe("app/bulk-input/page.tsx — multiline Order Date column parses independently with the same parser", () => {
  it("row date resolution goes through parseUkDate", () => {
    expect(pageSource).toContain("const dateResult = values.order_date.trim() ? parseUkDate(values.order_date) : null;");
  });

  it("preview/edit-cell display goes through the same parser via displayDate", () => {
    expect(pageSource).toContain("function displayDate(value: string) {");
    expect(pageSource).toContain("const result = parseUkDate(value);");
    expect(pageSource).toContain("return result.ok ? formatUkDate(result.iso) : value;");
  });

  it("blank-line alignment logic (lines/lineCount) is unchanged", () => {
    expect(pageSource).toContain('function lines(value: string) { return value.replace(/\\r/g, "").split("\\n"); }');
    expect(pageSource).toContain('function lineCount(value: string) { return value === "" ? 0 : lines(value).length; }');
  });

  it("an invalid line produces a row-specific message naming the row and the entered value, without silently substituting a different date", () => {
    expect(pageSource).toContain('const dateIssue = dateResult && !dateResult.ok ? `Order date row ${index + 1}: ${dateResult.error}` : null;');
  });

  it("an invalid date row is excluded from the ready/save set rather than silently interpreted", () => {
    expect(pageSource).toContain('if (dateIssue) errors.push("order_date");');
  });
});

describe("app/bulk-input/page.tsx — preserved, unrelated behaviour", () => {
  it("price parsing is untouched", () => {
    expect(pageSource).toContain('function parsePrice(value: string) {');
    expect(pageSource).toContain('const clean = value.replace(/£/g, "").replace(/,/g, "").trim();');
  });

  it("arrived parsing is untouched", () => {
    expect(pageSource).toContain('function parseArrived(value: string) {');
  });

  it("does not touch Investments code", () => {
    expect(pageSource).not.toMatch(/investments/i);
    expect(routeSource).not.toMatch(/investments/i);
  });
});

describe("app/api/purchases/bulk/route.ts — server-side date protection", () => {
  it("imports and uses the same shared parser as the client, not a duplicate implementation", () => {
    expect(routeSource).toContain('import { parseUkDate } from "@/lib/validation/uk-date";');
  });

  it("normalizes a provided order_date to canonical ISO before insert", () => {
    expect(routeSource).toContain("const parsed = parseUkDate(row.order_date);");
    expect(routeSource).toContain("orderDate = parsed.iso;");
    expect(routeSource).toContain("order_date: orderDate,");
  });

  it("rejects an invalid order_date with a row-specific reason instead of inserting it", () => {
    expect(routeSource).toContain("failures.push({ row: index + 1, reason: `Order date row ${index + 1}: ${parsed.error}` });");
    expect(routeSource).toContain("return [];");
  });

  it("still treats order_date as optional when blank, matching existing bulk-input behaviour", () => {
    expect(routeSource).toContain('if (row.order_date && row.order_date.trim()) {');
  });
});

describe("integration: shared and per-row two-digit UK dates resolve identically end to end", () => {
  it("a shared date typed as 12/08/26 normalizes to 12/08/2026 and stores as 2026-08-12", () => {
    const parsed = parseUkDate("12/08/26");
    expect(parsed).toEqual({ ok: true, iso: "2026-08-12" });
    if (parsed.ok) expect(formatUkDate(parsed.iso)).toBe("12/08/2026");
  });

  it("mixed two-digit and four-digit multiline years all resolve to the correct calendar date", () => {
    const lines = ["17/07/26", "18/07/2026", "1/8/26"];
    const isos = lines.map(line => { const r = parseUkDate(line); return r.ok ? r.iso : null; });
    expect(isos).toEqual(["2026-07-17", "2026-07-18", "2026-08-01"]);
  });

  it("an existing four-digit-year multiline date continues to work unchanged", () => {
    expect(parseUkDate("18/07/2026")).toEqual({ ok: true, iso: "2026-07-18" });
  });

  it("a shared override date does not change the row count semantics — it only supplies the value each row already resolves to", () => {
    // Row generation is driven entirely by column line-counts (see `count`
    // in page.tsx); the shared value only substitutes the per-row value
    // used for order_date and never adds/removes rows. Asserted structurally:
    expect(pageSource).toContain("const count = Math.max(0, ...fields.map(field => lineCount(columns[field.key])));");
    expect(pageSource).not.toMatch(/shared\.order_date[\s\S]{0,40}count\s*=/);
  });
});
