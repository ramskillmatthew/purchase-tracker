"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Expense, Purchase, SalesOrderListItem } from "@/lib/types";
import type { SalesHistoryResponse } from "@/lib/sales/history";
import TodaysTasksCard from "@/components/TodaysTasksCard";
import { computeHomeReport, periods, type Period } from "@/lib/home-report";
import { calculateInStockValue } from "@/lib/purchases";
import { HOME_PERIOD_TO_SALES_PRESET, homeSalesChart, pendingHomeSales, recentHomeSales } from "@/lib/home-sales";
import { salesProcessPresentation } from "@/lib/sales/process-status";
import styles from "./home.module.css";

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const shortMoney = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

function Icon({ name }: { name: "purchases" | "spend" | "revenue" | "profit" | "margin" | "stock" }) {
  const paths = {
    purchases: <><path d="M3 4h2l1.4 9h9.8l2-6H6"/><circle cx="9" cy="18" r="1"/><circle cx="16" cy="18" r="1"/></>,
    spend: <><path d="M4 5v6l8 8 7-7-8-8H5a1 1 0 0 0-1 1Z"/><circle cx="8" cy="8" r="1"/></>,
    revenue: <><path d="M4 17 9 12l3 3 7-8"/><path d="M14 7h5v5"/><path d="M4 20h16"/></>,
    profit: <><path d="M14.5 6.5c-.4-1.8-1.6-3-3.5-3-2.2 0-3.5 1.5-3.5 3.7 0 3.4 4 3.6 4 6.2 0 1.5-1 2.6-2.6 2.6-1.1 0-2-.3-2.9-1"/><path d="M5 10h8M5 19h11"/></>,
    margin: <><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/><path d="m18 4-12 16"/></>,
    stock: <><path d="M4 7h16v5H4zM6 14h12v5H6z"/><path d="M10 9.5h4M10 16.5h4"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function platformLabel(row: SalesOrderListItem) { return row.platform === "other" && row.custom_platform_name ? row.custom_platform_name : row.platform === "ebay" ? "eBay" : row.platform.charAt(0).toUpperCase() + row.platform.slice(1); }
function itemLabel(row: SalesOrderListItem) { return row.itemGroups.map(group => group.quantity > 1 ? `${group.description} × ${group.quantity}` : group.description).join(", ") || "Sale"; }
function salesUrl(period: Period, status: "completed" | "pending" | "all") { return `/api/sales?status=${status}&preset=${HOME_PERIOD_TO_SALES_PRESET[period]}&pageSize=100&sort=date&direction=desc`; }

export default function HomePage() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>("month");
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [completed, setCompleted] = useState<SalesHistoryResponse | null>(null);
  const [pending, setPending] = useState<SalesOrderListItem[]>([]);
  const [recentSales, setRecentSales] = useState<SalesOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [salesLoading, setSalesLoading] = useState(true);
  const [error, setError] = useState("");
  const [salesError, setSalesError] = useState("");

  useEffect(() => {
    Promise.all([fetch("/api/purchases"), fetch("/api/expenses")]).then(async ([purchaseResponse, expenseResponse]) => {
      if (!purchaseResponse.ok || !expenseResponse.ok) throw new Error("Could not load purchasing information.");
      const [purchaseRows, expenseRows] = await Promise.all([purchaseResponse.json(), expenseResponse.json()]);
      setPurchases(purchaseRows); setExpenses(expenseRows);
    }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSalesLoading(true); setSalesError("");
    Promise.all([fetch(salesUrl(period, "completed"), { signal: controller.signal }), fetch(salesUrl(period, "pending"), { signal: controller.signal }), fetch(salesUrl(period, "all"), { signal: controller.signal })]).then(async responses => {
      if (responses.some(response => !response.ok)) throw new Error("Could not load sales information.");
      const [completedBody, pendingBody, allBody] = await Promise.all(responses.map(response => response.json())) as SalesHistoryResponse[];
      setCompleted(completedBody); setPending(pendingHomeSales(pendingBody.rows)); setRecentSales(recentHomeSales(allBody.rows));
    }).catch(reason => { if (reason.name !== "AbortError") setSalesError(reason.message); }).finally(() => { if (!controller.signal.aborted) setSalesLoading(false); });
    return () => controller.abort();
  }, [period]);

  const report = useMemo(() => computeHomeReport(period, purchases, expenses), [period, purchases, expenses]);
  const stockValue = useMemo(() => calculateInStockValue(purchases), [purchases]);
  const chart = useMemo(() => homeSalesChart(completed?.rows ?? []), [completed]);
  const chartMax = Math.max(1, ...chart.flatMap(point => [point.revenuePence, Math.max(0, point.profitPence)]));
  const selectedPeriod = periods.find(option => option.value === period)?.label ?? "This Month";
  const kpis = completed?.kpis;
  const metricCards = [
    { name: "purchases" as const, label: "Purchases", value: loading ? "—" : report.periodPurchases.length.toLocaleString("en-GB"), caption: selectedPeriod },
    { name: "spend" as const, label: "Stock spend", value: loading ? "—" : money.format(report.stockSpend), caption: "Purchases in period" },
    { name: "revenue" as const, label: "Revenue", value: salesLoading ? "—" : money.format((kpis?.revenuePence ?? 0) / 100), caption: "Sales in period" },
    { name: "profit" as const, label: "Net profit", value: salesLoading ? "—" : money.format((kpis?.profitPence ?? 0) / 100), caption: "Profit in period", profit: true },
    { name: "margin" as const, label: "Margin", value: salesLoading ? "—" : `${(kpis?.margin ?? 0).toFixed(2)}%`, caption: "Profit margin" },
    { name: "stock" as const, label: "Stock value", value: loading ? "—" : money.format(stockValue), caption: `${purchases.filter(row => row.stock_status === "in_stock").length} items in stock` },
  ];

  return <section className={`page-shell ${styles.page}`}>
    <header className={styles.header}><h1>Home</h1><div className={styles.periodControl}><span className={styles.periodLabel}>Compare period</span><div className={styles.periodSwitch} aria-label="Compare period">{periods.map(option => <button key={option.value} type="button" className={period === option.value ? styles.active : ""} aria-pressed={period === option.value} onClick={() => setPeriod(option.value)}>{option.label}</button>)}</div></div></header>
    {error && <div className={styles.error}>{error}</div>}{salesError && <div className={styles.error}>{salesError}</div>}
    <div className={styles.kpis} aria-busy={loading || salesLoading}>{metricCards.map(card => <article className={styles.kpi} key={card.label}><span className={`${styles.kpiIcon} ${card.profit ? styles.profitIcon : ""}`}><Icon name={card.name}/></span><span className={styles.kpiLabel}>{card.label}</span><strong className={`${styles.kpiValue} ${card.profit ? styles.profit : ""}`}>{card.value}</strong><small className={styles.kpiCaption}>{card.caption}</small></article>)}</div>

    <div className={styles.grid}><TodaysTasksCard maxTasks={4}/><section className={styles.panel}><div className={styles.heading}><h2>Sales Overview</h2><span>{selectedPeriod}</span></div><div className={styles.overviewBody}><div className={styles.overviewStats}>
      <div className={styles.stat}><span className={styles.statIcon}>▢</span><strong>{salesLoading ? "—" : kpis?.completedSales ?? 0}</strong><small>Completed sales</small></div>
      <div className={styles.stat}><span className={styles.statIcon}>£</span><strong>{salesLoading ? "—" : money.format((kpis?.revenuePence ?? 0) / 100)}</strong><small>Total revenue</small></div>
      <div className={styles.stat}><span className={`${styles.statIcon} ${styles.profitIcon}`}>£</span><strong className={styles.profit}>{salesLoading ? "—" : money.format((kpis?.profitPence ?? 0) / 100)}</strong><small>Total profit</small></div><Link className={styles.viewSales} href="/sales">View sales →</Link>
    </div><div className={styles.chart} role="img" aria-label={`Revenue and profit chart for ${selectedPeriod}. Revenue ${money.format((kpis?.revenuePence ?? 0) / 100)}, profit ${money.format((kpis?.profitPence ?? 0) / 100)}.`}><div className={styles.legend}><span><i/>Revenue</span><span><i/>Profit</span></div>{chart.length ? <div className={styles.bars}>{chart.map(point => <span className={styles.barGroup} key={point.key} title={`${point.label}: revenue ${money.format(point.revenuePence / 100)}, profit ${money.format(point.profitPence / 100)}`}><i className={styles.bar} style={{height:`${Math.max(2,point.revenuePence/chartMax*115)}px`}}/><i className={`${styles.bar} ${styles.barProfit}`} style={{height:`${Math.max(2,Math.max(0,point.profitPence)/chartMax*115)}px`}}/><small>{point.label}</small></span>)}</div> : <div className={styles.empty}>{salesLoading ? "Loading sales…" : "No completed sales in this period."}</div>}</div></div></section></div>

    <div className={styles.grid}><section className={styles.panel}><div className={styles.heading}><h2>Pending Orders</h2><span>{salesLoading ? "" : `${pending.length} orders`}</span></div><div className={styles.orderRows}>{pending.length ? pending.map(row => { const status = salesProcessPresentation(row); return <Link href={`/sales/${row.id}`} className={styles.orderRow} key={row.id}><span className={`${styles.status} ${styles[status.tone]}`}><i className={styles.dot}/>{status.shortLabel}</span><span className={styles.item}>{itemLabel(row)}</span><span className={styles.platform}>{platformLabel(row)}</span><span className={styles.amount}>{money.format(Number(row.total_revenue))}</span><span aria-hidden="true">›</span></Link>; }) : <div className={styles.empty}>{salesLoading ? "Loading orders…" : "No pending orders."}</div>}</div></section>
      <section className={styles.panel}><div className={styles.heading}><h2>Recent Sales</h2><span>Latest 5</span></div><div className={styles.tableWrap}><table className={`${styles.table} ${styles.recentSales}`}><thead><tr><th>Date</th><th>Item</th><th>Platform</th><th>Revenue</th><th>Profit</th><th>Status</th></tr></thead><tbody>{recentSales.length ? recentSales.map(row => { const status = salesProcessPresentation(row); return <tr key={row.id} tabIndex={0} onClick={() => router.push(`/sales/${row.id}`)} onKeyDown={event => { if(event.key === "Enter") router.push(`/sales/${row.id}`); }}><td>{new Date(`${row.sale_date}T00:00:00`).toLocaleDateString("en-GB")}</td><td title={itemLabel(row)}>{itemLabel(row)}</td><td>{platformLabel(row)}</td><td>{money.format(Number(row.total_revenue))}</td><td className={`${styles.profitCell} ${row.profitPence < 0 ? styles.negative : ""}`}>{money.format(row.profitPence/100)}</td><td><span className={`${styles.statusCell} ${styles[status.tone]}`}><i className={styles.dot}/>{status.shortLabel}</span></td></tr>; }) : <tr><td colSpan={6}>{salesLoading ? "Loading sales…" : "No recent sales."}</td></tr>}</tbody></table></div></section></div>

    <div className={styles.grid}><section className={styles.panel}><div className={styles.heading}><h2>Where My Money Went</h2><span>{report.sources.length} sources</span></div><div className={styles.spendBody}>{report.sources.length ? report.sources.slice(0,5).map(source => <div className={styles.source} key={source.source}><div className={styles.sourceMeta}><strong>{source.source}</strong><span>{shortMoney.format(source.spend)} <i>{source.percentage.toFixed(0)}%</i></span></div><div className={styles.track}><span style={{width:`${source.percentage}%`}}/></div></div>) : <div className={styles.empty}>No purchase spending in this period.</div>}</div></section>
      <section className={styles.panel}><div className={styles.heading}><h2>Recent Purchases</h2><span>Latest 6</span></div><div className={styles.tableWrap}><table className={`${styles.table} ${styles.recentPurchases}`}><thead><tr><th>Date</th><th>Description</th><th>Size</th><th>Price</th><th>SKU</th></tr></thead><tbody>{report.recent.slice(0,6).map(row => <tr key={row.id} tabIndex={0} onClick={() => router.push(`/purchases/${row.id}`)} onKeyDown={event => { if(event.key === "Enter") router.push(`/purchases/${row.id}`); }}><td>{new Date(`${row.order_date}T00:00:00`).toLocaleDateString("en-GB")}</td><td>{row.item_description}</td><td>{row.item_size}</td><td>{money.format(Number(row.price_purchased))}</td><td><span className={styles.sku}>{row.sku}</span></td></tr>)}{!report.recent.length && <tr><td colSpan={5}>{loading ? "Loading purchases…" : "No purchases in this period."}</td></tr>}</tbody></table></div></section></div>
  </section>;
}
