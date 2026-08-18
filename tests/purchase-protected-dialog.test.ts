import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// "use client" component with no React test harness in this project — see
// tests/purchases-selection-ui.test.ts's own comment on this established
// convention.
const source = readFileSync("components/PurchaseProtectedDialog.tsx", "utf8");

describe("components/PurchaseProtectedDialog.tsx", () => {
  it("REQUIREMENT: explains exactly why the purchase can't be deleted, verbatim", () => {
    expect(source).toContain("This purchase belongs to a completed sale. Cancel the sale before deleting the purchase.");
  });

  it("REQUIREMENT: never renders a destructive confirm/delete button — only a link to the sale and a close control", () => {
    expect(source).not.toContain("dialog-confirm");
    expect(source).not.toContain("onConfirm");
  });

  it("REQUIREMENT: links directly to the protecting sale's detail page using the exact sale id, never a generic /sales list link", () => {
    expect(source).toContain('href={`/sales/${saleId}`}');
  });

  it("is purely informational — closing makes no request and changes nothing (no fetch call anywhere)", () => {
    expect(source).not.toContain("fetch(");
  });

  it("closes on Escape and on backdrop click, matching the app's other dialogs", () => {
    expect(source).toContain('if (event.key === "Escape") onClose();');
    expect(source).toContain("if (event.target === event.currentTarget) onClose();");
  });
});
