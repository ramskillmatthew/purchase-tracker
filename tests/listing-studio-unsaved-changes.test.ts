import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("Listing Studio editors — unsaved changes are never silently discarded", () => {
  const ebay = read("components/listing-studio/EbayCategoryAndAspectsDialog.tsx");
  const vinted = read("components/listing-studio/EditListingFieldsDialog.tsx");
  const prompt = read("components/listing-studio/UnsavedChangesDialog.tsx");

  it("uses the same explicit save-or-discard prompt for eBay and Vinted details", () => {
    expect(ebay).toContain("<UnsavedChangesDialog");
    expect(vinted).toContain("<UnsavedChangesDialog");
    expect(prompt).toContain("Save changes and exit");
    expect(prompt).toContain("Exit without saving");
  });

  it("does not write Vinted field edits until Save & close or Save changes and exit is chosen", () => {
    expect(vinted).toContain("const [draft, setDraft]");
    expect(vinted).toContain('>{loading ? "Saving…" : "Save & close"}</button>');
    expect(vinted).toContain("onSaveAndExit={() => { setConfirmingClose(false); onSave(draft); }}");
    expect(vinted).not.toContain("onBlur={");
  });

  it("the eBay close button, backdrop and Escape key all pass through the dirty-state guard", () => {
    expect(ebay).toContain("onClick={requestClose}");
    expect(ebay).toContain("requestClose();");
    expect(ebay).toContain("if (hasUnsavedChanges) setConfirmingClose(true);");
  });
});
