import { describe, expect, it } from "vitest";
import { buildStatusHistoryEntry, canMarkReady, isValidStatusTransition } from "@/lib/listing-studio/status";
import { listingDraftStatuses } from "@/lib/listing-studio/types";

describe("isValidStatusTransition — the Stage 1 status lifecycle (§12)", () => {
  it("allows the normal forward path: uploading -> grouping -> analysing -> needs_review -> ready", () => {
    expect(isValidStatusTransition("uploading", "grouping")).toBe(true);
    expect(isValidStatusTransition("grouping", "analysing")).toBe(true);
    expect(isValidStatusTransition("analysing", "needs_review")).toBe(true);
    expect(isValidStatusTransition("needs_review", "ready")).toBe(true);
  });

  it("allows analysing to go straight to ready when the pipeline is fully confident", () => {
    expect(isValidStatusTransition("analysing", "ready")).toBe(true);
  });

  it("allows failed to be retried back into grouping or analysing", () => {
    expect(isValidStatusTransition("failed", "grouping")).toBe(true);
    expect(isValidStatusTransition("failed", "analysing")).toBe(true);
  });

  it("allows a ready draft to be sent back to needs_review, or archived", () => {
    expect(isValidStatusTransition("ready", "needs_review")).toBe(true);
    expect(isValidStatusTransition("ready", "archived")).toBe(true);
  });

  it("allows an archived draft to be unarchived back to needs_review only", () => {
    expect(isValidStatusTransition("archived", "needs_review")).toBe(true);
    expect(isValidStatusTransition("archived", "ready")).toBe(false);
    expect(isValidStatusTransition("archived", "analysing")).toBe(false);
  });

  it("rejects skipping straight from uploading to ready", () => {
    expect(isValidStatusTransition("uploading", "ready")).toBe(false);
  });

  it("rejects a no-op transition to the same status", () => {
    for (const status of listingDraftStatuses) expect(isValidStatusTransition(status, status)).toBe(false);
  });

  it("rejects going backwards from ready to uploading/grouping", () => {
    expect(isValidStatusTransition("ready", "uploading")).toBe(false);
    expect(isValidStatusTransition("ready", "grouping")).toBe(false);
  });
});

describe("canMarkReady — the specific gate for reaching 'ready'", () => {
  it("true only when the transition is structurally valid AND readiness passed", () => {
    expect(canMarkReady("needs_review", { ready: true })).toBe(true);
  });

  it("false when readiness failed even if the transition shape is valid", () => {
    expect(canMarkReady("needs_review", { ready: false })).toBe(false);
  });

  it("false when the transition itself is invalid even if readiness somehow passed", () => {
    expect(canMarkReady("uploading", { ready: true })).toBe(false);
  });

  it("REGRESSION: an already-archived draft can never be marked ready directly, regardless of readiness", () => {
    expect(canMarkReady("archived", { ready: true })).toBe(false);
  });
});

describe("buildStatusHistoryEntry — pure shape builder", () => {
  it("captures previous/new status and an optional reason", () => {
    expect(buildStatusHistoryEntry("analysing", "needs_review", "consistency check flagged a conflict")).toEqual({
      previousStatus: "analysing", newStatus: "needs_review", reason: "consistency check flagged a conflict",
    });
  });

  it("defaults reason to null when omitted", () => {
    expect(buildStatusHistoryEntry(null, "uploading")).toEqual({ previousStatus: null, newStatus: "uploading", reason: null });
  });
});
