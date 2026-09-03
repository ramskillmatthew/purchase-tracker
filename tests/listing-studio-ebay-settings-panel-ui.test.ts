import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Fault 4 fix — "the eBay settings panel is permanently expanded, needs a
// compact collapsed summary by default with an 'Edit settings' action, an
// expandable card, correct visual hierarchy, keyboard accessibility, and
// responsive behaviour." Source-text assertions, matching this repo's own
// established convention for every other *-ui.test.ts file (no
// @testing-library/react dependency in this project).
describe("components/listing-studio/EbayDraftSettingsPanel.tsx — Fault 4 fix: collapsed by default", () => {
  const source = read("components/listing-studio/EbayDraftSettingsPanel.tsx");

  it("REQUIREMENT: opens collapsed — expanded defaults to false", () => {
    expect(source).toContain("const [expanded, setExpanded] = useState(false);");
  });

  it("REQUIREMENT: the collapsed view shows a one-line summary and an explicit 'Edit settings' action, never the full form", () => {
    const collapsedBlock = source.slice(source.indexOf("if (!expanded) {"), source.indexOf("return (\n    <div className=\"ebay-settings-panel data-panel\">"));
    expect(collapsedBlock).toContain("{summariseSettings(settings)}");
    expect(collapsedBlock).toContain(">Edit settings</button>");
    expect(collapsedBlock).not.toContain("Default quantity");
    expect(collapsedBlock).not.toContain("Postage profile");
  });

  it("REQUIREMENT: keyboard-accessible toggle — a real <button> with aria-expanded reflecting collapsed/expanded state, not a div onClick", () => {
    expect(source).toContain('aria-expanded={false} onClick={() => setExpanded(true)}');
    expect(source).toContain('aria-expanded={true} onClick={() => setExpanded(false)}');
  });

  it("REQUIREMENT: the expanded editor has an explicit 'Done' action to collapse it again — never a dead end with no way back", () => {
    const expandedBlock = source.slice(source.indexOf('<div className="ebay-settings-panel data-panel">'));
    expect(expandedBlock).toContain(">Done</button>");
  });

  it("REGRESSION: expanding/collapsing never re-fetches or discards in-memory settings — the same `settings` state feeds both views", () => {
    expect(source).toContain("{summariseSettings(settings)}");
    expect(source.match(/useEffect\(/g)?.length).toBe(1); // only the initial load effect — no fetch tied to expanded
  });

  it("every existing field survives unchanged in the expanded editor (Content, Listing format, Default quantity, Allow offers, Postage/Return profile, Package size, Automation)", () => {
    const expandedBlock = source.slice(source.indexOf('<div className="ebay-settings-panel data-panel">'));
    for (const label of ["Content", "Listing format", "Default quantity", "Allow offers", "Postage profile", "Return profile", "Package size", "Automation"]) {
      expect(expandedBlock).toContain(label);
    }
  });

  it("REGRESSION: never calls AI, and the save path is unchanged from before this fix", () => {
    expect(source).not.toMatch(/anthropic|Anthropic/i);
    expect(source).toContain('fetch("/api/listing-studio/marketplace-settings", {');
  });
});

describe("app/globals.css — Fault 4 fix: collapsed settings panel styling", () => {
  const css = read("app/globals.css");

  it("defines dedicated collapsed-state classes rather than reusing the expanded editor's own layout rules for both", () => {
    expect(css).toMatch(/\.ebay-settings-panel-collapsed\s*\{/);
    expect(css).toMatch(/\.ebay-settings-summary-row\s*\{[^}]*flex-wrap: wrap;/); // wraps on narrow widths, matching this codebase's other responsive summary rows
    expect(css).toMatch(/\.ebay-settings-summary-line\s*\{/);
  });
});
