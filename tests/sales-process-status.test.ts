import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { effectiveSalesProcessStatus, isSalesProcessStatus, SALES_PROCESS_STATUS_OPTIONS, salesProcessPresentation } from "@/lib/sales/process-status";

describe("sales order-process status contract", () => {
  it("defines all seven internal values in the approved order with exact labels", () => {
    expect(SALES_PROCESS_STATUS_OPTIONS.map(option => [option.value, option.label])).toEqual([
      ["awaiting_dispatch", "Item awaiting dispatch"],
      ["sent", "Item sent"],
      ["delivered_awaiting_payout", "Delivered · awaiting payout"],
      ["completed", "Sale completed"],
      ["return_in_process", "Return in process"],
      ["cancelled", "Sale cancelled"],
      ["returned_cancelled", "Item returned · sale cancelled"],
    ]);
    for (const option of SALES_PROCESS_STATUS_OPTIONS) expect(isSalesProcessStatus(option.value)).toBe(true);
    expect(isSalesProcessStatus("cancelled")).toBe(true);
    expect(isSalesProcessStatus("made_up")).toBe(false);
  });

  it("maps legacy completed sales safely without changing financial semantics", () => {
    expect(effectiveSalesProcessStatus({ process_status: null, status: "completed", cancellation_stock_action: null })).toBe("completed");
  });

  it("only claims a legacy cancellation was returned when the audit proves it", () => {
    expect(effectiveSalesProcessStatus({ process_status: null, status: "cancelled", cancellation_stock_action: "returned_to_stock" })).toBe("returned_cancelled");
    expect(effectiveSalesProcessStatus({ process_status: null, status: "cancelled", cancellation_stock_action: "kept_out_of_stock" })).toBeNull();
    expect(salesProcessPresentation({ process_status: null, status: "cancelled", cancellation_stock_action: "kept_out_of_stock" }).label).toBe("Sale cancelled");
  });

  it("uses an explicitly persisted process status ahead of the legacy fallback", () => {
    expect(effectiveSalesProcessStatus({ process_status: "sent", status: "completed", cancellation_stock_action: null })).toBe("sent");
  });

  it("gives delivered awaiting payout its own vivid positive cyan treatment", () => {
    expect(SALES_PROCESS_STATUS_OPTIONS.find(option => option.value === "delivered_awaiting_payout")?.tone).toBe("cyan");
  });
});

describe("supabase-sales-v4-process-status.sql", () => {
  const migration = readFileSync("supabase-sales-v4-process-status.sql", "utf8");
  const executable = migration.replace(/--.*$/gm, "");

  it("is additive, constrained, and defaults new sales to awaiting dispatch", () => {
    expect(migration).toContain("add column if not exists process_status text");
    expect(migration).toContain("sales_orders_process_status_check");
    expect(migration).toContain("alter column process_status set default 'awaiting_dispatch'");
    for (const option of SALES_PROCESS_STATUS_OPTIONS) expect(migration).toContain(`'${option.value}'`);
  });

  it("backfills only evidence-supported legacy states", () => {
    expect(migration).toContain("status = 'completed'");
    expect(migration).toContain("cancellation_stock_action = 'returned_to_stock'");
    expect(migration).not.toMatch(/kept_out_of_stock[\s\S]*?returned_cancelled/i);
  });

  it("never mutates money, stock, sale items, Investments, or financial status", () => {
    expect(executable).not.toMatch(/update\s+public\.sale_items/i);
    expect(executable).not.toMatch(/update\s+public\.purchases/i);
    expect(executable).not.toMatch(/update\s+public\.invest/i);
    expect(executable).not.toMatch(/set\s+status\s*=/i);
    expect(executable).not.toMatch(/\b(delete|truncate|drop table)\b/i);
  });
});
