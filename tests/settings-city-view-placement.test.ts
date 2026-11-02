import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("dashboard city-view controls", () => {
  const header = read("components/AppHeader.tsx");
  const settings = read("app/settings/page.tsx");

  it("keeps Auto, Day and Night out of both navigation menus", () => {
    expect(header).not.toContain('aria-label="City view"');
    expect(header).not.toContain("mobile-scene-control");
    expect(header).not.toContain("chooseDashboardScene");
  });

  it("places the same persistent controls on the Settings page", () => {
    expect(settings).toContain("Dashboard city view");
    expect(settings).toContain("DASHBOARD_SCENE_STORAGE_KEY");
    expect(settings).toContain('chooseDashboardScene("auto")');
    expect(settings).toContain('chooseDashboardScene("day")');
    expect(settings).toContain('chooseDashboardScene("night")');
    expect(settings).toContain("DASHBOARD_SCENE_EVENT");
  });
});

describe("eBay details footer", () => {
  const dialog = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");

  it("uses the top-right X to close and the footer button to save", () => {
    expect(dialog).toContain('<button type="button" onClick={onClose} aria-label="Close">×</button>');
    expect(dialog).not.toContain('className="button-secondary" onClick={onClose}>Close</button>');
    expect(dialog).toContain('footerSaveStatus === "saving" ? "Saving…" : "Save"');
  });

  it("commits the focused field and waits for its persistence request", () => {
    const saveAll = dialog.slice(dialog.indexOf("async function saveAllChanges"), dialog.indexOf("if (loading)"));
    expect(saveAll).toContain("document.activeElement");
    expect(saveAll).toContain("await Promise.resolve()");
    expect(saveAll).toContain("await Promise.allSettled([...pendingSavesRef.current])");
    expect(saveAll.indexOf("onClose();")).toBeGreaterThan(saveAll.indexOf('setFooterSaveStatus("saved")'));
    expect(saveAll.indexOf("onClose();")).toBeGreaterThan(saveAll.indexOf('setFooterSaveStatus("error")'));
  });
});

describe("eBay details four-step editor", () => {
  const dialog = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");

  it("keeps the approved four-step workflow and restrained AI action", () => {
    expect(dialog).toContain('label: "Category"');
    expect(dialog).toContain('label: "Item specifics"');
    expect(dialog).toContain('label: "Postage & price"');
    expect(dialog).toContain('label: "Review"');
    expect(dialog).toContain('"Fill with AI"');
    expect(dialog).toContain('>Run again</button>');
    expect(dialog).toContain('"Save & close"');
  });

  it("only marks populated automatic values as suggested", () => {
    const suggestionMeta = dialog.slice(dialog.indexOf("function SuggestionMeta"), dialog.indexOf("function AspectGroup"));
    expect(suggestionMeta).toContain("if (!hasValue) return null;");
    expect(suggestionMeta).toContain("value.userConfirmed");
    expect(suggestionMeta).toContain("• Suggested");
  });

  it("can explicitly approve an unchanged suggestion for every field mode", () => {
    const controls = dialog.slice(dialog.indexOf("function SuggestionMeta"));
    expect(controls).toContain(">Approve suggestion</button>");
    expect(controls).toContain("onApprove={() => onSave(aspect.name, draftValue.trim() || null)}");
    expect(controls).toContain("onApprove={() => onSave(aspect.name, selected.length ? selected : null)}");
    expect(controls).toContain("onApprove={() => onSave(aspect.name, selectedValue || null)}");
  });
});
