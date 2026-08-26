import type { CancellationStockAction, SalesProcessStatus, SalesStatus } from "@/lib/types";
import { salesProcessStatuses } from "@/lib/validation/sales";

export type SalesProcessTone = "amber" | "blue" | "cyan" | "teal" | "green" | "orange" | "red" | "neutral";

export const SALES_PROCESS_STATUS_OPTIONS: ReadonlyArray<{
  value: SalesProcessStatus;
  label: string;
  shortLabel: string;
  tone: Exclude<SalesProcessTone, "neutral">;
}> = [
  { value: "awaiting_dispatch", label: "Item awaiting dispatch", shortLabel: "Awaiting dispatch", tone: "amber" },
  { value: "sent", label: "Item sent", shortLabel: "Item sent", tone: "blue" },
  { value: "delivered_awaiting_payout", label: "Delivered · awaiting payout", shortLabel: "Delivered · awaiting payout", tone: "cyan" },
  { value: "completed", label: "Sale completed", shortLabel: "Sale completed", tone: "green" },
  { value: "return_in_process", label: "Return in process", shortLabel: "Return in process", tone: "orange" },
  { value: "cancelled", label: "Sale cancelled", shortLabel: "Sale cancelled", tone: "red" },
  { value: "returned_cancelled", label: "Item returned · sale cancelled", shortLabel: "Item returned · sale cancelled", tone: "red" },
];

const OPTION_BY_VALUE = new Map(SALES_PROCESS_STATUS_OPTIONS.map(option => [option.value, option]));

export function isSalesProcessStatus(value: unknown): value is SalesProcessStatus {
  return typeof value === "string" && (salesProcessStatuses as readonly string[]).includes(value);
}

export function processStatusOption(value: SalesProcessStatus) {
  return OPTION_BY_VALUE.get(value)!;
}

/**
 * Safe display fallback for records created before the v4 migration.
 * A cancelled record is only called "returned" when the durable v3 audit
 * field proves it was returned to stock; other cancellations stay explicitly
 * ambiguous instead of fabricating a customer-return event.
 */
export function effectiveSalesProcessStatus(order: {
  process_status?: SalesProcessStatus | null;
  status: SalesStatus;
  cancellation_stock_action: CancellationStockAction | null;
}): SalesProcessStatus | null {
  if (isSalesProcessStatus(order.process_status)) return order.process_status;
  if (order.status === "completed") return "completed";
  if (order.status === "cancelled" && order.cancellation_stock_action === "returned_to_stock") return "returned_cancelled";
  return null;
}

export function salesProcessPresentation(order: Parameters<typeof effectiveSalesProcessStatus>[0]) {
  const value = effectiveSalesProcessStatus(order);
  if (value) return processStatusOption(value);
  return { value: "cancelled" as const, label: "Sale cancelled", shortLabel: "Sale cancelled", tone: "red" as const };
}
