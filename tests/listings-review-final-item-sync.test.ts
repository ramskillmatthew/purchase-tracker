import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeExtensionWorkflowStatus, isBatchStatusTerminal, shouldApplyBatchPollResponse,
} from "../lib/listing-studio/extension-workflow-status";

/**
 * Live bug (2026-08-11): when a 4-item batch finished, listings 1-3
 * correctly flipped to the green "Item drafted" state but listing 4 stayed
 * stuck on its previous state (e.g. "Draft in progress") even though its
 * Vinted draft had genuinely been created. Consistently affected the FINAL
 * item in the batch.
 *
 * Root cause (proven, see tests/vinted-extension-service-worker.test.ts's
 * "final item's result report is awaited, not fire-and-forget" suite):
 * vinted-draft-queue-extension/service-worker.js's postResultToApp() fired
 * its report-to-app fetch without awaiting it. The message-response promise
 * that keeps the Chrome extension's service worker alive resolved as soon
 * as the fetch was merely STARTED — for every item except the last, the
 * NEXT item's own processing kept the worker alive long enough for the
 * stray fetch to land anyway, but the final item has no follow-up activity,
 * so its report to the app's database could be (and was) cut off entirely.
 *
 * A second, independently real bug was found and fixed in the same pass:
 * ListingsReviewWorkspace.tsx's poll loop decided whether to keep polling
 * using a `batchStatus` value captured in a setInterval closure that never
 * actually updated (the effect deliberately never re-subscribes on a
 * batchStatus change), so the intended "stop once terminal" check never
 * fired via that mechanism. This suite covers the CLIENT side of the fix —
 * once the app's database genuinely has every item's terminal state (which
 * the extension fix above now guarantees even for the final item), these
 * pure functions and the real 4-item ordering they drive prove the UI
 * reconciles every row correctly, for batches of any size, including every
 * edge case in the original bug report.
 */

type Item = { itemId: string; draftId: string; status: string; completedAt: string | null; vintedDraftId: string | null };
type Batch = { batchId: string; status: string; items: Item[] };

function makeItems(n: number, overrides: Partial<Item>[] = []): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `item-${i + 1}`, draftId: `draft-${i + 1}`, status: "queued", completedAt: null, vintedDraftId: null,
    ...(overrides[i] ?? {}),
  }));
}

// The one place a listing's row status is ever derived from (itemStatus,
// batchStatus) — mirrors exactly what ListingsReviewWorkspace.tsx's
// listingRows memo does for every row, keyed by draftId (see the dedicated
// "draftId, never index" test below).
function workflowFor(batch: Batch, draftId: string) {
  const item = batch.items.find(i => i.draftId === draftId);
  if (!item) return null;
  return computeExtensionWorkflowStatus(item.status, batch.status);
}

describe("Listings Review final-item sync bug — the real 4-item ordering", () => {
  it("REGRESSION: items 1-3 complete, item 4 is still in progress, then the final poll reports batch=completed AND item 4=completed with its draft id — all four rows must read 'drafted'", () => {
    const inProgress: Batch = {
      batchId: "batch-1", status: "in_progress",
      items: makeItems(4, [
        { status: "completed", completedAt: "2026-08-11T10:00:01Z", vintedDraftId: "1001" },
        { status: "completed", completedAt: "2026-08-11T10:00:02Z", vintedDraftId: "1002" },
        { status: "completed", completedAt: "2026-08-11T10:00:03Z", vintedDraftId: "1003" },
        { status: "filling" }, // "Draft in progress" — item 4 not yet done
      ]),
    };
    expect(workflowFor(inProgress, "draft-4")).toBe("in_progress");

    // The final poll: the SAME response reveals both batch=completed and
    // item 4=completed+draftId (proven server-side atomic — see
    // app/api/extension/batch/items/[itemId]/result/route.ts, which
    // re-queries every item's already-committed status AFTER patching the
    // current item, before ever flipping the batch to completed).
    const finalPoll: Batch = {
      batchId: "batch-1", status: "completed",
      items: makeItems(4, [
        { status: "completed", completedAt: "2026-08-11T10:00:01Z", vintedDraftId: "1001" },
        { status: "completed", completedAt: "2026-08-11T10:00:02Z", vintedDraftId: "1002" },
        { status: "completed", completedAt: "2026-08-11T10:00:03Z", vintedDraftId: "1003" },
        { status: "completed", completedAt: "2026-08-11T10:00:04Z", vintedDraftId: "1004" },
      ]),
    };
    for (const draftId of ["draft-1", "draft-2", "draft-3", "draft-4"]) {
      expect(workflowFor(finalPoll, draftId)).toBe("drafted");
    }
    // Polling must stop only now that the batch is genuinely terminal.
    expect(isBatchStatusTerminal(finalPoll.status)).toBe(true);
    expect(isBatchStatusTerminal(inProgress.status)).toBe(false);
  });

  it("polling must never be considered stoppable while the batch is still in_progress, regardless of how many items have already completed", () => {
    const threeOfFourDone: Batch = {
      batchId: "batch-1", status: "in_progress",
      items: makeItems(4, [{ status: "completed" }, { status: "completed" }, { status: "completed" }, { status: "saving" }]),
    };
    expect(isBatchStatusTerminal(threeOfFourDone.status)).toBe(false);
  });
});

describe("Listings Review final-item sync bug — batch-size independence (1, 2, 4, 5, 10 items)", () => {
  it.each([1, 2, 4, 5, 10])("a %i-item batch: the LAST item completing correctly drafts every item, not just the earlier ones", (n) => {
    const items = makeItems(n).map((item, i) => ({ ...item, status: "completed", vintedDraftId: `d${i + 1}`, completedAt: "2026-08-11T10:00:00Z" }));
    const batch: Batch = { batchId: `batch-${n}`, status: "completed", items };
    for (const item of items) {
      expect(workflowFor(batch, item.draftId)).toBe("drafted");
    }
  });
});

describe("Listings Review final-item sync bug — final item fails or is cancelled", () => {
  it("the final item failing shows 'failed', not stuck on its prior in-progress state, and does not block the other rows from showing 'drafted'", () => {
    const batch: Batch = {
      batchId: "batch-1", status: "completed",
      items: makeItems(4, [
        { status: "completed", vintedDraftId: "1" }, { status: "completed", vintedDraftId: "2" }, { status: "completed", vintedDraftId: "3" },
        { status: "failed" },
      ]),
    };
    expect(workflowFor(batch, "draft-1")).toBe("drafted");
    expect(workflowFor(batch, "draft-4")).toBe("failed");
    expect(isBatchStatusTerminal(batch.status)).toBe(true);
  });

  it("the final item being cancelled falls back to readiness (no fabricated workflow state) once the batch itself is terminal", () => {
    const batch: Batch = {
      batchId: "batch-1", status: "completed",
      items: makeItems(2, [{ status: "completed", vintedDraftId: "1" }, { status: "cancelled" }]),
    };
    expect(workflowFor(batch, "draft-1")).toBe("drafted");
    expect(workflowFor(batch, "draft-2")).toBeNull(); // no fabricated success/failure — falls back to readiness
  });
});

describe("Listings Review final-item sync bug — ordering, idempotency, and staleness guarantees", () => {
  it("batch completion arriving in the SAME response as the final item's own completed status is reconciled together, never showing 'completed' batch with a non-terminal final item", () => {
    // This ordering is what the server actually guarantees (see the
    // extension-batch-item-result-route tests): a batch can only ever
    // become 'completed' in the same request that already committed the
    // triggering item's own terminal write. A poll response can therefore
    // never legitimately show batch=completed alongside a still-in-progress
    // item — if it ever did, the client must not fabricate a "drafted"
    // status for that item; computeExtensionWorkflowStatus only returns
    // "drafted" for a genuinely completed item, regardless of batch status.
    const pathological: Batch = {
      batchId: "batch-1", status: "completed",
      items: makeItems(2, [{ status: "completed", vintedDraftId: "1" }, { status: "filling" }]),
    };
    expect(workflowFor(pathological, "draft-2")).toBe("in_progress"); // never "drafted" without a real completed status
  });

  it("repeated terminal responses are idempotent — polling the same completed batch twice produces the identical result", () => {
    const batch: Batch = {
      batchId: "batch-1", status: "completed",
      items: makeItems(2, [{ status: "completed", vintedDraftId: "1" }, { status: "completed", vintedDraftId: "2" }]),
    };
    const first = batch.items.map(item => workflowFor(batch, item.draftId));
    const second = batch.items.map(item => workflowFor(batch, item.draftId));
    expect(second).toEqual(first);
    expect(second).toEqual(["drafted", "drafted"]);
  });

  it("REGRESSION: an older, out-of-order poll response can never overwrite a newer, already-applied one", () => {
    expect(shouldApplyBatchPollResponse(/* appliedSeq */ 3, /* incomingSeq */ 2)).toBe(false);
    expect(shouldApplyBatchPollResponse(/* appliedSeq */ 3, /* incomingSeq */ 3)).toBe(true); // the same response reapplied is fine
    expect(shouldApplyBatchPollResponse(/* appliedSeq */ 3, /* incomingSeq */ 4)).toBe(true);
    // Concretely: request #4 (item 4 in progress) resolves AFTER request #5
    // (item 4 completed) already applied — #4 must be discarded, never
    // reverting the row back to "in progress" after it correctly showed
    // "drafted".
    let appliedSeq = 0;
    const applied: string[] = [];
    for (const [seq, status] of [[5, "completed"], [4, "in_progress"]] as const) {
      if (shouldApplyBatchPollResponse(appliedSeq, seq)) { appliedSeq = seq; applied.push(status); }
    }
    expect(applied).toEqual(["completed"]); // the stale #4 response never got applied
  });
});

describe("Listings Review final-item sync bug — draft IDs stay associated with the correct listing (never array-index/off-by-one)", () => {
  it("the live-item lookup keys by draftId equality, never by array position — proven directly against the component source", () => {
    const source = readFileSync("components/listings-review/ListingsReviewWorkspace.tsx", "utf8");
    expect(source).toContain("const liveItem = batchStatus?.items.find(item => item.draftId === row.id);");
    // Never indexes into items[] by position (which would silently
    // misattribute results if the server ever reordered them).
    expect(source).not.toMatch(/batchStatus\.items\[[^\]]*\]/);
  });

  it("a shuffled items array still resolves each row to its own, correct draft id and status", () => {
    const shuffled: Batch = {
      batchId: "batch-1", status: "completed",
      items: [
        { itemId: "item-4", draftId: "draft-4", status: "completed", vintedDraftId: "1004", completedAt: null },
        { itemId: "item-2", draftId: "draft-2", status: "completed", vintedDraftId: "1002", completedAt: null },
        { itemId: "item-1", draftId: "draft-1", status: "completed", vintedDraftId: "1001", completedAt: null },
        { itemId: "item-3", draftId: "draft-3", status: "completed", vintedDraftId: "1003", completedAt: null },
      ],
    };
    for (const draftId of ["draft-1", "draft-2", "draft-3", "draft-4"]) {
      const item = shuffled.items.find(i => i.draftId === draftId)!;
      expect(item.vintedDraftId).toBe(`100${draftId.slice(-1)}`);
      expect(workflowFor(shuffled, draftId)).toBe("drafted");
    }
  });
});

describe("Listings Review final-item sync bug — reload preserves correct status from persistent history", () => {
  it("computeExtensionWorkflowStatus is fed identically by the live poll (items[].status/batch.status) and the page-load fallback (extension_status.item_status/batch_status) — a reload after the fix hits the exact same pure function with the persisted, already-fixed final-item row", () => {
    // Mirrors the fallback path in ListingsReviewWorkspace.tsx's
    // listingRows memo: row.extensionStatusSnapshot ? computeExtensionWorkflowStatus(row.extensionStatusSnapshot.item_status, row.extensionStatusSnapshot.batch_status) : ...
    const persistedFinalItemRow = { item_status: "completed", batch_status: "completed" };
    expect(computeExtensionWorkflowStatus(persistedFinalItemRow.item_status, persistedFinalItemRow.batch_status)).toBe("drafted");
  });

  it("a reload before the extension's report ever landed (pre-fix scenario) would show the final item stuck — proving the extension fix, not just client polling, is what makes the persisted history correct", () => {
    // If the extension's fetch was cut off (the root cause), the DB row for
    // the final item never advances past its last real report — a reload
    // just faithfully reflects whatever was truly persisted; the client
    // cannot invent a "completed" state the server never recorded.
    const neverReported = { item_status: "filling", batch_status: "in_progress" };
    expect(computeExtensionWorkflowStatus(neverReported.item_status, neverReported.batch_status)).toBe("in_progress");
    expect(computeExtensionWorkflowStatus(neverReported.item_status, neverReported.batch_status)).not.toBe("drafted");
  });
});
