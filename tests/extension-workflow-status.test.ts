import { describe, expect, it } from "vitest";
import { computeExtensionWorkflowStatus, WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_TONE, WORKFLOW_STATUS_TAB_GROUPS } from "@/lib/listing-studio/extension-workflow-status";

describe("computeExtensionWorkflowStatus — the single source of truth for extension-workflow status", () => {
  it("a completed item is always 'drafted', regardless of batch status", () => {
    for (const batchStatus of ["pending_claim", "claimed", "in_progress", "completed", "expired", "cancelled"]) {
      expect(computeExtensionWorkflowStatus("completed", batchStatus)).toBe("drafted");
    }
  });

  it("a failed item is always 'failed', regardless of batch status", () => {
    for (const batchStatus of ["pending_claim", "claimed", "in_progress", "completed", "expired", "cancelled"]) {
      expect(computeExtensionWorkflowStatus("failed", batchStatus)).toBe("failed");
    }
  });

  it("preparing/filling/saving are all 'in_progress', regardless of batch status", () => {
    for (const itemStatus of ["preparing", "filling", "saving"]) {
      for (const batchStatus of ["claimed", "in_progress", "pending_claim"]) {
        expect(computeExtensionWorkflowStatus(itemStatus, batchStatus)).toBe("in_progress");
      }
    }
  });

  it("a queued item is 'sent' only while the batch itself hasn't been claimed yet", () => {
    expect(computeExtensionWorkflowStatus("queued", "pending_claim")).toBe("sent");
  });

  it("a queued item is 'in_queue' once the batch has been claimed or is in progress", () => {
    expect(computeExtensionWorkflowStatus("queued", "claimed")).toBe("in_queue");
    expect(computeExtensionWorkflowStatus("queued", "in_progress")).toBe("in_queue");
  });

  it("a queued item in an expired or cancelled batch falls back to null (readiness) — the attempt never really happened", () => {
    expect(computeExtensionWorkflowStatus("queued", "expired")).toBeNull();
    expect(computeExtensionWorkflowStatus("queued", "cancelled")).toBeNull();
  });

  it("a cancelled item is always null, regardless of batch status", () => {
    for (const batchStatus of ["pending_claim", "claimed", "in_progress", "completed", "expired", "cancelled"]) {
      expect(computeExtensionWorkflowStatus("cancelled", batchStatus)).toBeNull();
    }
  });

  it("a paused item (in the DB enum but never set by any real code path) or any unrecognised status falls back to null rather than throwing", () => {
    expect(computeExtensionWorkflowStatus("paused", "claimed")).toBeNull();
    expect(computeExtensionWorkflowStatus("something-unexpected", "claimed")).toBeNull();
  });

  it("every ExtensionWorkflowStatus value has a label and a tone — nothing falls through to undefined text/colour", () => {
    for (const status of ["sent", "in_queue", "in_progress", "drafted", "failed"] as const) {
      expect(typeof WORKFLOW_STATUS_LABELS[status]).toBe("string");
      expect(WORKFLOW_STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(typeof WORKFLOW_STATUS_TONE[status]).toBe("string");
    }
  });

  it("'failed' is deliberately excluded from both tab groups — a failed listing is never counted under Drafts or Sent, and is never hidden (reachable via the Filters 'Draft failed' toggle instead)", () => {
    expect(WORKFLOW_STATUS_TAB_GROUPS.drafts).not.toContain("failed");
    expect(WORKFLOW_STATUS_TAB_GROUPS.sent).not.toContain("failed");
  });

  it("the 'Sent' tab group covers everything currently in flight — sent, queued behind another item, and actively being filled", () => {
    expect(WORKFLOW_STATUS_TAB_GROUPS.sent).toEqual(expect.arrayContaining(["sent", "in_queue", "in_progress"]));
  });

  it("the 'Drafts' tab group covers only a genuinely completed Vinted draft", () => {
    expect(WORKFLOW_STATUS_TAB_GROUPS.drafts).toEqual(["drafted"]);
  });
});
