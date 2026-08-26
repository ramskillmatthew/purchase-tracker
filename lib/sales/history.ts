import type { ItemDescriptionGroup, SalesOrderListItem } from "@/lib/types";
import { poundsToPence } from "./money";

export const HISTORY_PAGE_SIZES = [10, 25, 50, 100] as const;
export type HistorySort = "date" | "revenue" | "profit" | "margin" | "units";
export type HistoryDirection = "asc" | "desc";

export type SalesHistoryKpis = {
  completedSales: number;
  revenuePence: number;
  profitPence: number;
  margin: number;
  averageOrderPence: number;
};

export type SalesHistoryResponse = {
  rows: SalesOrderListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  kpis: SalesHistoryKpis;
  today: { orders: number; revenuePence: number; profitPence: number };
  recentActivity: SalesOrderListItem[];
  platforms: string[];
};

export function orderMargin(order: Pick<SalesOrderListItem, "total_revenue" | "profitPence">): number {
  const revenue = poundsToPence(Number(order.total_revenue));
  return revenue === 0 ? 0 : order.profitPence / revenue * 100;
}

export function computeHistoryKpis(orders: SalesOrderListItem[]): SalesHistoryKpis {
  const completed = orders.filter(order => order.status === "completed");
  const revenuePence = completed.reduce((sum, order) => sum + poundsToPence(Number(order.total_revenue)), 0);
  const profitPence = completed.reduce((sum, order) => sum + order.profitPence, 0);
  return {
    completedSales: completed.length,
    revenuePence,
    profitPence,
    margin: revenuePence === 0 ? 0 : profitPence / revenuePence * 100,
    averageOrderPence: completed.length === 0 ? 0 : Math.round(revenuePence / completed.length),
  };
}

export function itemGroupsText(groups: ItemDescriptionGroup[]): string {
  return groups.map(group => `${group.description} ${group.quantity}`).join(" ").toLowerCase();
}

export function compareHistoryOrders(a: SalesOrderListItem, b: SalesOrderListItem, sort: HistorySort, direction: HistoryDirection): number {
  const values: Record<HistorySort, [number | string, number | string]> = {
    date: [a.sale_date, b.sale_date],
    revenue: [poundsToPence(Number(a.total_revenue)), poundsToPence(Number(b.total_revenue))],
    profit: [a.profitPence, b.profitPence],
    margin: [orderMargin(a), orderMargin(b)],
    units: [a.itemCount, b.itemCount],
  };
  const [av, bv] = values[sort];
  const primary = av < bv ? -1 : av > bv ? 1 : 0;
  if (primary !== 0) return direction === "asc" ? primary : -primary;
  const created = b.created_at.localeCompare(a.created_at);
  return created || b.id.localeCompare(a.id);
}
