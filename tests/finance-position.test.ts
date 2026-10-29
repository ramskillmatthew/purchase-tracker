import { describe, expect, it } from "vitest";
import { calculateFinancePosition, financeDateDueByRangeEnd, financeDateFallsInRange } from "@/lib/finance/position";

describe("Finance Hub position", () => {
  it("keeps every headline value separate and projects confirmed dated cash", () => {
    expect(calculateFinancePosition({
      accountBalancesPence: [1_000_000, 842_000],
      allocationBalancesPence: [250_000, 180_000, 50_000],
      cardBalancesPence: [195_000, 428_500, 138_000],
      incoming: [
        { id: "sale", amountPence: 350_000, confidence: "confirmed", dateKind: "exact", exactDate: "2026-09-10" },
        { id: "possible", amountPence: 50_000, confidence: "estimated", dateKind: "exact", exactDate: "2026-09-12" },
        { id: "unknown", amountPence: 25_000, confidence: "confirmed", dateKind: "unknown" },
      ],
      outgoings: [
        { id: "stock", totalPence: 400_000, paidPence: 0, status: "planned", kind: "stock_purchase", dateKind: "exact", exactDate: "2026-09-15" },
      ],
      statements: [{ id: "amex", amountPence: 195_000, dueDate: "2026-09-20" }],
      rangeStart: "2026-09-03",
      rangeEnd: "2026-10-03",
    })).toEqual({
      trackedCashPence: 1_842_000,
      pendingIncomingPence: 425_000,
      estimatedIncomingPence: 50_000,
      confirmedIncomingInRangePence: 350_000,
      reservedPence: 480_000,
      availableAfterReservationsPence: 1_362_000,
      dueOutInRangePence: 400_000,
      statementBalancesDuePence: 195_000,
      cardDebtPence: 761_500,
      projectedPositionPence: 1_597_000,
    });
  });

  it("includes overdue commitments and remaining partial payments", () => {
    const result = calculateFinancePosition({
      accountBalancesPence: [500_000], allocationBalancesPence: [], cardBalancesPence: [], incoming: [],
      outgoings: [{ id: "partial", totalPence: 100_000, paidPence: 30_000, status: "partially_paid", kind: "stock_purchase", dateKind: "exact", exactDate: "2026-08-01" }],
      statements: [{ id: "late", amountPence: 50_000, paidPence: 10_000, dueDate: "2026-08-20" }],
      rangeStart: "2026-09-03", rangeEnd: "2026-10-03",
    });
    expect(result.dueOutInRangePence).toBe(70_000);
    expect(result.statementBalancesDuePence).toBe(40_000);
    expect(result.projectedPositionPence).toBe(390_000);
  });

  it("recognises a date range conservatively on its end date", () => {
    expect(financeDateFallsInRange({ dateKind: "range", rangeStart: "2026-09-01", rangeEnd: "2026-09-08" }, "2026-09-03", "2026-10-03")).toBe(true);
    expect(financeDateFallsInRange({ dateKind: "unknown" }, "2026-09-03", "2026-10-03")).toBe(false);
  });

  it("keeps overdue confirmed incoming in the forecast until resolved", () => {
    expect(financeDateDueByRangeEnd({ dateKind: "exact", exactDate: "2026-08-20" }, "2026-09-03", "2026-10-03")).toBe(true);
  });

  it("allows negative card balances but rejects fractional pence", () => {
    expect(calculateFinancePosition({
      accountBalancesPence: [], allocationBalancesPence: [], cardBalancesPence: [-40_000], incoming: [], outgoings: [], statements: [],
      rangeStart: "2026-09-03", rangeEnd: "2026-10-03",
    }).cardDebtPence).toBe(-40_000);
    expect(() => calculateFinancePosition({
      accountBalancesPence: [0.5], allocationBalancesPence: [], cardBalancesPence: [], incoming: [], outgoings: [], statements: [],
      rangeStart: "2026-09-03", rangeEnd: "2026-10-03",
    })).toThrow("safe integer");
  });
});
