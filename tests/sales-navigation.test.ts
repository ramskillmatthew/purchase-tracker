import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("components/AppHeader.tsx", "utf8");

describe("components/AppHeader.tsx — Sales navigation", () => {
  it("adds a 'Sales' link to /sales with its own icon, without removing or renaming any existing link", () => {
    expect(source).toContain('{ label: "Sales", href: "/sales", icon: "tag" }');
    for (const label of ["Home", "Tasks", "Purchases", "Listing Studio", "Listings Review", "Bulk Input", "Email Assistant", "Purchase Import", "Expenses", "Export", "Investments", "Settings"]) {
      expect(source).toContain(`label: "${label}"`);
    }
  });

  it("defines a distinct tag icon (not reusing Investments' chart icon or any other existing icon key)", () => {
    expect(source).toMatch(/tag:\s*<>\s*<path/);
  });

  it("REQUIREMENT: a sale sub-page (e.g. /sales/new, /sales/<id>) highlights the Sales nav link as active, matching the existing Purchases sub-page pattern", () => {
    expect(source).toMatch(/href === "\/sales"[^\n]*pathname\.startsWith\(`\$\{href\}\/`\)/);
  });

  it("REGRESSION: does not modify the Investments link or its icon", () => {
    expect(source).toContain('{ label: "Investments", href: "/investments", icon: "chart" }');
  });
});
