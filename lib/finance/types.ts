export type FinanceDateKind = "exact" | "range" | "unknown";
export type IncomingConfidence = "confirmed" | "estimated";
export type FinanceMarketplace = "vinted" | "ebay" | "other";
export type FinanceOutgoingStatus = "planned" | "partially_paid" | "paid" | "cancelled";

export type FinanceDate = {
  dateKind: FinanceDateKind;
  exactDate?: string | null;
  rangeStart?: string | null;
  rangeEnd?: string | null;
};

export type ForecastIncoming = FinanceDate & {
  id: string;
  amountPence: number;
  confidence: IncomingConfidence;
  cancelled?: boolean;
};

export type ForecastOutgoing = FinanceDate & {
  id: string;
  totalPence: number;
  paidPence: number;
  status: FinanceOutgoingStatus;
  kind: "stock_purchase" | "expense" | "subscription" | "other";
};

export type StatementDue = {
  id: string;
  amountPence: number;
  dueDate: string;
  paidPence?: number;
};

export type FinancePositionInput = {
  accountBalancesPence: number[];
  allocationBalancesPence: number[];
  cardBalancesPence: number[];
  incoming: ForecastIncoming[];
  outgoings: ForecastOutgoing[];
  statements: StatementDue[];
  rangeStart: string;
  rangeEnd: string;
};

export type FinancePosition = {
  trackedCashPence: number;
  pendingIncomingPence: number;
  estimatedIncomingPence: number;
  confirmedIncomingInRangePence: number;
  reservedPence: number;
  availableAfterReservationsPence: number;
  dueOutInRangePence: number;
  statementBalancesDuePence: number;
  cardDebtPence: number;
  projectedPositionPence: number;
};
