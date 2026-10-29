import type { FinanceDateKind } from "@/lib/finance/types";

export type PlannedOutgoingSummaryInput = {
  id: string; totalPence: number; paidPence: number; status: "planned"|"partially_paid"|"paid"|"cancelled";
  dateKind: FinanceDateKind; dueDate?: string|null; rangeStart?: string|null;
};

export function outstandingPence(row: PlannedOutgoingSummaryInput) {
  return row.status === "cancelled" || row.status === "paid" ? 0 : Math.max(0,row.totalPence-row.paidPence);
}

export function outgoingTiming(row: PlannedOutgoingSummaryInput, today: string, inSevenDays: string, inThirtyDays: string) {
  const date=row.dateKind==="exact"?row.dueDate:row.dateKind==="range"?row.rangeStart:null;
  if (!date) return "no_date" as const;
  if (date<today) return "overdue" as const;
  if (date<=inSevenDays) return "next_7" as const;
  if (date<=inThirtyDays) return "next_30" as const;
  return "later" as const;
}

export function summariseOutgoings(rows: PlannedOutgoingSummaryInput[], today: string, inSevenDays: string, inThirtyDays: string) {
  const result={next7Pence:0,next30Pence:0,overduePence:0,recurringPence:0};
  for(const row of rows){const amount=outstandingPence(row),timing=outgoingTiming(row,today,inSevenDays,inThirtyDays);if(timing==="overdue")result.overduePence+=amount;if(timing==="next_7")result.next7Pence+=amount;if(timing==="next_7"||timing==="next_30")result.next30Pence+=amount;}
  return result;
}
