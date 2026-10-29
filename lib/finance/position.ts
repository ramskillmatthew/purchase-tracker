import type { FinanceDate, FinancePosition, FinancePositionInput, ForecastOutgoing } from "@/lib/finance/types";

function assertPence(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer number of pence.`);
}

function sumPence(values: number[], label: string): number {
  values.forEach(value => assertPence(value, label));
  return values.reduce((total, value) => total + value, 0);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateRange(start: string, end: string): void {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) throw new Error("Invalid finance forecast date range.");
}

/**
 * Exact dates contribute when inside the selected range. Date ranges use
 * their end date: that is the conservative point at which the cash can be
 * relied upon. Unknown dates never contribute to a dated projection.
 */
export function financeDateFallsInRange(date: FinanceDate, start: string, end: string): boolean {
  validateRange(start, end);
  if (date.dateKind === "unknown") return false;
  const recognitionDate = date.dateKind === "exact" ? date.exactDate : date.rangeEnd;
  return Boolean(recognitionDate && isIsoDate(recognitionDate) && recognitionDate >= start && recognitionDate <= end);
}

/** Forecasts retain overdue confirmed money until it is resolved. */
export function financeDateDueByRangeEnd(date: FinanceDate, start: string, end: string): boolean {
  validateRange(start, end);
  if (date.dateKind === "unknown") return false;
  const recognitionDate = date.dateKind === "exact" ? date.exactDate : date.rangeEnd;
  return Boolean(recognitionDate && isIsoDate(recognitionDate) && recognitionDate <= end);
}

/** Overdue commitments still matter: include anything due on or before the range end. */
function outgoingDueByRangeEnd(outgoing: ForecastOutgoing, rangeStart: string, rangeEnd: string): boolean {
  validateRange(rangeStart, rangeEnd);
  if (outgoing.status === "paid" || outgoing.status === "cancelled") return false;
  const recognitionDate = outgoing.dateKind === "unknown"
    ? null
    : outgoing.dateKind === "exact"
      ? outgoing.exactDate
      : outgoing.rangeEnd;
  return Boolean(recognitionDate && isIsoDate(recognitionDate) && recognitionDate <= rangeEnd);
}

export function calculateFinancePosition(input: FinancePositionInput): FinancePosition {
  validateRange(input.rangeStart, input.rangeEnd);
  const trackedCashPence = sumPence(input.accountBalancesPence, "Account balance");
  const reservedPence = sumPence(input.allocationBalancesPence, "Allocation balance");
  const cardDebtPence = sumPence(input.cardBalancesPence, "Card balance");

  for (const item of input.incoming) assertPence(item.amountPence, "Incoming amount");
  for (const item of input.outgoings) {
    assertPence(item.totalPence, "Outgoing total");
    assertPence(item.paidPence, "Outgoing paid amount");
  }
  for (const item of input.statements) {
    assertPence(item.amountPence, "Statement amount");
    assertPence(item.paidPence ?? 0, "Statement paid amount");
  }

  const liveIncoming = input.incoming.filter(item => !item.cancelled);
  const pendingIncomingPence = sumPence(liveIncoming.map(item => item.amountPence), "Incoming amount");
  const estimatedIncomingPence = sumPence(liveIncoming.filter(item => item.confidence === "estimated").map(item => item.amountPence), "Estimated incoming amount");
  const confirmedIncomingInRangePence = sumPence(
    liveIncoming.filter(item => item.confidence === "confirmed" && financeDateDueByRangeEnd(item, input.rangeStart, input.rangeEnd)).map(item => item.amountPence),
    "Confirmed incoming amount",
  );

  const dueOutInRangePence = sumPence(
    input.outgoings
      .filter(item => outgoingDueByRangeEnd(item, input.rangeStart, input.rangeEnd))
      .map(item => Math.max(0, item.totalPence - item.paidPence)),
    "Outstanding outgoing amount",
  );

  const statementBalancesDuePence = sumPence(
    input.statements
      .filter(item => isIsoDate(item.dueDate) && item.dueDate <= input.rangeEnd)
      .map(item => Math.max(0, item.amountPence - (item.paidPence ?? 0))),
    "Statement balance due",
  );

  return {
    trackedCashPence,
    pendingIncomingPence,
    estimatedIncomingPence,
    confirmedIncomingInRangePence,
    reservedPence,
    availableAfterReservationsPence: trackedCashPence - reservedPence,
    dueOutInRangePence,
    statementBalancesDuePence,
    cardDebtPence,
    projectedPositionPence: trackedCashPence + confirmedIncomingInRangePence - dueOutInRangePence - statementBalancesDuePence,
  };
}
