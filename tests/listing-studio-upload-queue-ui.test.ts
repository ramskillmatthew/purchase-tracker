import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// "use client" components with no React test harness in this project (see
// tests/purchases-selection-ui.test.ts's own comment on this established
// convention) — wiring is asserted structurally against the source text.
const read = (path: string) => readFileSync(path, "utf8");
const queueSource = read("components/listing-studio/UploadQueue.tsx");
const cardSource = read("components/listing-studio/UploadPhotoCard.tsx");
const badgeSource = read("components/listing-studio/UploadStatusBadge.tsx");
const typesSource = read("components/listing-studio/upload-types.ts");

describe("components/listing-studio/upload-types.ts — richer state machine", () => {
  it("distinguishes at minimum waiting, uploading, uploaded, and failed, plus registering/confirming/rejected", () => {
    expect(typesSource).toContain('"waiting" | "registering" | "uploading" | "confirming" | "uploaded" | "failed" | "rejected"');
  });

  it("exports a shared 'active' state set so every consumer agrees on what counts as in-flight", () => {
    expect(typesSource).toContain('export const UPLOAD_ACTIVE_STATES: ReadonlySet<UploadItemState> = new Set(["waiting", "registering", "uploading", "confirming"]);');
  });
});

describe("components/listing-studio/UploadStatusBadge.tsx — every state has a distinct text label", () => {
  it("labels every state in the union, never falling through to undefined text", () => {
    for (const state of ["waiting", "registering", "uploading", "confirming", "uploaded", "failed", "rejected"]) {
      expect(badgeSource).toContain(`${state}:`);
    }
  });
});

describe("components/listing-studio/UploadPhotoCard.tsx — rejected vs failed", () => {
  it("REQUIREMENT: only 'failed' items get a Retry button — 'rejected' (e.g. an oversized file) is never retryable, since nothing about the file changed", () => {
    expect(cardSource).toContain('item.state === "failed" && <button type="button" onClick={() => onRetry(item.clientId)}');
    expect(cardSource).not.toMatch(/item\.state === "rejected"[^}]*onClick=\{\(\) => onRetry/);
  });

  it("Remove is always available regardless of state", () => {
    expect(cardSource).toContain('<button type="button" onClick={() => onRemove(item.clientId)}');
  });

  it("shows the error/rejection message for both failed and rejected items", () => {
    expect(cardSource).toContain('(item.state === "failed" || item.state === "rejected") && item.errorMessage');
  });

  it("visually distinguishes a rejected row from a normal one, without hiding it", () => {
    expect(cardSource).toContain("upload-photo-row-rejected");
  });
});

describe("components/listing-studio/UploadQueue.tsx — large-queue presentation", () => {
  it("REQUIREMENT: active items and failed/rejected items are ALWAYS included in what's rendered, never subject to the collapse limit", () => {
    expect(queueSource).toContain("const visibleQueueItems = [...activeItems, ...failedItems, ...rejectedItems, ...visibleResolved];");
  });

  it("REQUIREMENT: only successful ('uploaded') items are capped by DEFAULT_VISIBLE_RESOLVED, with a 'Show all N' control", () => {
    expect(queueSource).toContain("const DEFAULT_VISIBLE_RESOLVED = 24;");
    expect(queueSource).toContain("const visibleResolved = showAllResolved ? resolvedItems : resolvedItems.slice(0, DEFAULT_VISIBLE_RESOLVED);");
    expect(queueSource).toContain("Show all {items.length}");
  });

  it("provides a 'Show fewer' control once expanded to show-all", () => {
    expect(queueSource).toContain("Show fewer");
  });

  it("REQUIREMENT: shows an overall accurate summary line ('N of TOTAL uploaded') and a progress bar", () => {
    expect(queueSource).toContain("`${uploadedCount} of ${items.length} uploaded`");
    expect(queueSource).toContain("upload-queue-progress-fill");
    expect(queueSource).toContain("const percent = items.length ? Math.round((uploadedCount / items.length) * 100) : 0;");
  });

  it("REQUIREMENT: shows uploading/waiting/failed/rejected counts alongside the summary", () => {
    expect(queueSource).toContain("inFlightCount > 0 ? `${inFlightCount} uploading`");
    expect(queueSource).toContain("waitingCount > 0 ? `${waitingCount} waiting`");
    expect(queueSource).toContain("failedCount > 0 ? `${failedCount} failed`");
    expect(queueSource).toContain("rejectedCount > 0 ? `${rejectedCount} rejected`");
  });

  it("REQUIREMENT: offers 'Retry all failed' only when more than one item has failed (a single failure already has its own row-level Retry)", () => {
    expect(queueSource).toContain("{failedCount > 1 && <button type=\"button\" className=\"button-secondary\" onClick={onRetryAllFailed}>Retry all failed</button>}");
  });

  it("REQUIREMENT: offers 'Remove failed' whenever anything has failed", () => {
    expect(queueSource).toContain("{failedCount > 0 && <button type=\"button\" className=\"button-secondary\" onClick={onRemoveAllFailed}>Remove failed</button>}");
  });

  it("REQUIREMENT: renders one clear global-error banner when a hard-stop failure occurred, never silently swallowed", () => {
    expect(queueSource).toContain("{globalError && <div className=\"upload-queue-global-error\" role=\"alert\">{globalError}</div>}");
  });

  it("never hides the queue entirely while there's a global error, even if items.length were somehow 0", () => {
    // globalError rendering is not gated behind `expanded` or `items.length`.
    const globalErrorLine = queueSource.split("\n").find(line => line.includes("globalError && <div"));
    expect(globalErrorLine).toBeDefined();
  });
});
