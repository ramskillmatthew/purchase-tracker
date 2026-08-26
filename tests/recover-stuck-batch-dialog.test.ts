import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("components/listings-review/RecoverStuckBatchDialog.tsx", "utf8");

describe("RecoverStuckBatchDialog — required content", () => {
  it("REQUIREMENT: uses the EXACT confirmation text, verbatim", () => {
    expect(source).toContain(
      "Recover this stuck batch? Unfinished draft attempts will be released and can be sent again. Confirmed Vinted drafts\n"
      + "          will be preserved.",
    );
  });

  it("REQUIREMENT: offers exactly the two named actions — Keep waiting / Recover stuck batch", () => {
    expect(source).toMatch(/className="lr-recover-dialog-keep-waiting"[\s\S]*?Keep waiting/);
    expect(source).toMatch(/stillActiveWarning \? "Recover anyway" : "Recover stuck batch"/);
  });

  it("REQUIREMENT: shows every required fact — batch number/id, status, last genuine activity, hidden state, completed/unfinished counts", () => {
    expect(source).toContain("shortBatchId(batch.batchId)");
    expect(source).toContain("<dd>{batch.status}</dd>");
    expect(source).toContain("formatLastActivity(batch.lastExtensionActivityAt)");
    expect(source).toContain('{batch.isHidden ? "Hidden from the grid" : "Visible"}');
    expect(source).toContain("<dd>{batch.completedCount}</dd>");
    expect(source).toContain("<dd>{batch.unfinishedCount}</dd>");
  });

  it("REQUIREMENT: warns the owner to make sure the extension has genuinely stopped", () => {
    expect(source).toMatch(/associated Vinted Draft Queue browser extension has stopped/);
  });

  it("REQUIREMENT: shows the real affected listings list — never a count-only summary", () => {
    expect(source).toContain("listings.map(listing =>");
  });

  it("never renders its own confirm action as already-forced by default — force is only ever true after an explicit stillActiveWarning re-confirmation", () => {
    expect(source).toContain("onClick={() => onRecover(stillActiveWarning)}");
  });

  it("clicking outside the dialog body (the overlay) also offers Keep waiting — but a click inside the dialog itself never bubbles to close it", () => {
    expect(source).toContain('onClick={onKeepWaiting}');
    expect(source).toContain("onClick={event => event.stopPropagation()}");
  });

  it("presentational only — never calls fetch itself", () => {
    expect(source).not.toContain("fetch(");
  });
});
