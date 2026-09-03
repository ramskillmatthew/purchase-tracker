import { describe, expect, it } from "vitest";
import {
  RETURN_IN_PROGRESS_SALE_STATUS, RETURN_COMPLETED_SALE_STATUS,
  saleStatusForReturnStage, restorableSaleStatuses, resolveRestoreSaleStatus,
  isAllowedWorkflowTransition, RETURN_WORKFLOW_STATUSES,
} from "@/lib/returns/status-sync";
import { salesProcessStatuses } from "@/lib/validation/sales";

describe("linked-sale status synchronisation reuses the existing enum", () => {
  it("2. an active return maps the linked sale to the EXISTING 'return_in_process' status", () => {
    expect(RETURN_IN_PROGRESS_SALE_STATUS).toBe("return_in_process");
    expect(salesProcessStatuses).toContain(RETURN_IN_PROGRESS_SALE_STATUS);
    for (const stage of ["return_started", "item_sent", "return_delivered"] as const) {
      expect(saleStatusForReturnStage(stage)).toBe("return_in_process");
    }
  });

  it("3. a completed return maps the linked sale to the EXISTING 'returned_cancelled' (Item returned - sale cancelled)", () => {
    expect(RETURN_COMPLETED_SALE_STATUS).toBe("returned_cancelled");
    expect(salesProcessStatuses).toContain(RETURN_COMPLETED_SALE_STATUS);
    expect(saleStatusForReturnStage("return_completed")).toBe("returned_cancelled");
  });

  it("21. the Cancel 'restore to...' options are the genuine existing enum (minus the transient return status), never a hard-coded list", () => {
    const options = restorableSaleStatuses();
    expect(options).toEqual(salesProcessStatuses.filter(s => s !== "return_in_process"));
    expect(options).not.toContain("return_in_process");
  });

  it("21. resolveRestoreSaleStatus honours a valid user choice, then the snapshotted previous status, then a safe default", () => {
    expect(resolveRestoreSaleStatus("dispatched" as never, "sent")).toBe("sent"); // invalid choice -> previous
    expect(resolveRestoreSaleStatus("sent", "awaiting_dispatch")).toBe("sent"); // valid choice wins
    expect(resolveRestoreSaleStatus(null, "delivered_awaiting_payout")).toBe("delivered_awaiting_payout");
    expect(resolveRestoreSaleStatus(null, null)).toBe("awaiting_dispatch");
    expect(resolveRestoreSaleStatus("return_in_process", "return_in_process")).toBe("awaiting_dispatch"); // never restores the transient one
  });
});

describe("return workflow transitions", () => {
  it("exposes exactly the five visible stages", () => {
    expect([...RETURN_WORKFLOW_STATUSES]).toEqual([
      "return_started", "item_sent", "return_delivered", "return_completed", "return_cancelled",
    ]);
  });

  it("forward moves (incl. explicit skips) allowed; backward out of completed not allowed; cancel from any active stage", () => {
    expect(isAllowedWorkflowTransition("return_started", "item_sent")).toBe(true);
    expect(isAllowedWorkflowTransition("return_started", "return_delivered")).toBe(true); // explicit skip
    expect(isAllowedWorkflowTransition("return_delivered", "item_sent")).toBe(false); // backwards
    expect(isAllowedWorkflowTransition("return_completed", "return_delivered")).toBe(false);
    expect(isAllowedWorkflowTransition("return_completed", "return_cancelled")).toBe(false); // completed uses a different path
    expect(isAllowedWorkflowTransition("item_sent", "return_cancelled")).toBe(true);
    expect(isAllowedWorkflowTransition("return_cancelled", "return_started")).toBe(true); // re-activate
  });
});
