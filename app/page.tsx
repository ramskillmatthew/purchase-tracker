"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Expense, Purchase, SalesOrderListItem, Task } from "@/lib/types";
import type { SalesHistoryResponse } from "@/lib/sales/history";
import TodaysTasksCard from "@/components/TodaysTasksCard";
import { netProfitWithReturnsLossesPence } from "@/lib/returns/net-profit";
import { RETURNS_CHANGED_EVENT } from "@/lib/returns/events";
import { calculateAwaitingArrivalValue, countAwaitingArrival } from "@/lib/purchases";
import { homeReportChart, pendingHomeSales, recentHomeSales } from "@/lib/home-sales";
import type { SalesReportResponse } from "@/lib/sales/reporting";
import { salesProcessPresentation } from "@/lib/sales/process-status";
import { isTaskActionableToday, isTaskOverdue } from "@/lib/tasks";
import { poundsToPence } from "@/lib/sales/money";
import { DASHBOARD_SCENE_EVENT, DASHBOARD_SCENE_STORAGE_KEY, isDashboardSceneMode, resolveDashboardScene, type DashboardSceneMode } from "@/lib/dashboard-scene";
import { homeSpendBreakdown } from "@/lib/home-spend";
import { COMPANY_YEAR_CHANGED_EVENT, COMPANY_YEAR_STORAGE_KEY, DEFAULT_COMPANY_YEAR_START, companyYearDates, parseCompanyYearStart } from "@/lib/company-year";
import styles from "./home.module.css";

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const shortMoney = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
type DashboardPeriod = "7-days" | "30-days" | "90-days" | "month" | "tax-year" | "all-time";
const periods: { value: DashboardPeriod; label: string }[] = [
  { value: "7-days", label: "7 days" }, { value: "30-days", label: "30 days" }, { value: "90-days", label: "90 days" },
  { value: "month", label: "This month" }, { value: "tax-year", label: "Company year" }, { value: "all-time", label: "All time" },
];

function dateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function periodRange(period: DashboardPeriod, companyYearStart = DEFAULT_COMPANY_YEAR_START): { start: string; end: string } | null {
  const now = new Date(); const end = dateKey(now);
  if (period === "all-time") return null;
  if (period === "month") return { start: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)), end };
  if (period === "tax-year") {
    const companyYear = companyYearDates(now, parseCompanyYearStart(companyYearStart));
    return { start: companyYear.start, end: companyYear.today };
  }
  const days = period === "7-days" ? 7 : period === "30-days" ? 30 : 90;
  const start = new Date(now); start.setDate(start.getDate() - (days - 1));
  return { start: dateKey(start), end };
}
function queryForPeriod(period: DashboardPeriod, companyYearStart = DEFAULT_COMPANY_YEAR_START) {
  if (period === "all-time") return "preset=all-time";
  if (period === "month") return "preset=this-month";
  const range = periodRange(period, companyYearStart)!;
  return `preset=custom&start=${range.start}&end=${range.end}`;
}
function netProfitAdjustmentUrl(period: DashboardPeriod, companyYearStart = DEFAULT_COMPANY_YEAR_START) {
  return `/api/returns-losses/net-profit-adjustment?preset=${queryForPeriod(period, companyYearStart).replace(/^preset=/, "")}`;
}
function periodOperatingExpensePence(period: DashboardPeriod, expenses: readonly Expense[], companyYearStart = DEFAULT_COMPANY_YEAR_START) {
  const range = periodRange(period, companyYearStart);
  const rows = range ? expenses.filter(row => row.purchase_date >= range.start && row.purchase_date <= range.end) : expenses;
  return rows.reduce((sum, row) => sum + poundsToPence(Number(row.cost || 0)), 0);
}
function salesUrl(period: DashboardPeriod, status: "completed" | "all", companyYearStart = DEFAULT_COMPANY_YEAR_START) { return `/api/sales?status=${status}&${queryForPeriod(period, companyYearStart)}&pageSize=100&sort=date&direction=desc&includeMeta=false`; }
function salesReportUrl(period: DashboardPeriod, companyYearStart = DEFAULT_COMPANY_YEAR_START) { return `/api/sales/reports?${queryForPeriod(period, companyYearStart)}`; }
function operationalSalesUrl(status: "pending" | "all") { return `/api/sales?status=${status}&preset=all-time&pageSize=10&sort=date&direction=desc&includeMeta=false`; }
async function fetchDashboardHistory(url: string, signal: AbortSignal): Promise<SalesHistoryResponse> {
  let lastError = "Sales information could not be loaded.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, { signal });
    const body = await response.json().catch(() => null);
    if (response.ok) return body as SalesHistoryResponse;
    lastError = body?.error || lastError;
    if (response.status < 500 || attempt === 1) break;
  }
  throw new Error(lastError);
}
function platformLabel(row: SalesOrderListItem) { return row.platform === "other" && row.custom_platform_name ? row.custom_platform_name : row.platform === "ebay" ? "eBay" : row.platform.charAt(0).toUpperCase() + row.platform.slice(1); }
function itemLabel(row: SalesOrderListItem) { return row.itemGroups.map(group => group.quantity > 1 ? `${group.description} × ${group.quantity}` : group.description).join(", ") || "Sale"; }
function orderCountLabel(total: number) { return `${total} ${total === 1 ? "order" : "orders"}`; }

function MetricIcon({ name }: { name: "profit" | "revenue" | "stock" | "locked" }) {
  if (name === "profit") return <span aria-hidden="true">£</span>;
  const paths = {
    revenue: <><path d="M4 17 9 12l3 3 7-8"/><path d="M14 7h5v5"/></>,
    stock: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>,
    locked: <><circle cx="12" cy="12" r="7"/><path d="m12 12 4-4M12 3v3m0 12v3M3 12h3m12 0h3"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function LineChart({ rows, label }: { rows: ReturnType<typeof homeReportChart>; label: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (!rows.length) return <div className={styles.chartEmpty}>No completed sales in this period.</div>;
  const width = 600, height = 190, left = 54, right = 18, top = 24, bottom = 34;
  const max = Math.max(1, ...rows.flatMap(row => [row.revenuePence, Math.max(0, row.profitPence)]));
  const point = (value: number, index: number) => `${left + (rows.length === 1 ? 0 : index * ((width - left - right) / (rows.length - 1)))},${top + (1 - Math.max(0, value) / max) * (height - top - bottom)}`;
  const revenue = rows.map((row, index) => point(row.revenuePence, index));
  const profit = rows.map((row, index) => point(row.profitPence, index));
  const firstX = revenue[0].split(",")[0], lastX = revenue[revenue.length - 1].split(",")[0], floor = height - bottom;
  const activeIndex = hoverIndex === null ? null : Math.min(rows.length - 1, Math.max(0, hoverIndex));
  const activeRow = activeIndex === null ? null : rows[activeIndex];
  const activeX = activeIndex === null ? 0 : left + (rows.length === 1 ? 0 : activeIndex * ((width-left-right)/(rows.length-1)));
  function selectPoint(clientX: number, element: HTMLDivElement) {
    const bounds = element.getBoundingClientRect();
    const chartX = ((clientX - bounds.left) / bounds.width) * width;
    const ratio = Math.min(1, Math.max(0, (chartX - left) / (width - left - right)));
    setHoverIndex(rows.length === 1 ? 0 : Math.round(ratio * (rows.length - 1)));
  }
  return <div className={styles.lineChart} role="img" aria-label={`Revenue and profit chart for ${label}`} tabIndex={0} onPointerMove={event => selectPoint(event.clientX, event.currentTarget)} onPointerLeave={() => setHoverIndex(null)} onFocus={() => setHoverIndex(rows.length - 1)} onBlur={() => setHoverIndex(null)}>
    <div className={styles.legend}><span><i/>Revenue</span><span><i/>Profit</span></div>
    {activeRow && <div className={styles.chartTooltip} style={{ left: `${Math.min(76, Math.max(24, (activeX / width) * 100))}%` }}><strong>{activeRow.label}</strong><span><i/>Revenue <b>{money.format(activeRow.revenuePence/100)}</b></span><span><i/>Profit <b>{money.format(activeRow.profitPence/100)}</b></span></div>}
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="revenueArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7657ff" stopOpacity=".35"/><stop offset="1" stopColor="#7657ff" stopOpacity="0"/></linearGradient><linearGradient id="profitArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1ee6a0" stopOpacity=".25"/><stop offset="1" stopColor="#1ee6a0" stopOpacity="0"/></linearGradient></defs>
      {[0, .25, .5, .75, 1].map(step => <line key={step} x1={left} x2={width-right} y1={top + step*(height-top-bottom)} y2={top + step*(height-top-bottom)} className={styles.gridLine}/>)}
      <polygon points={`${firstX},${floor} ${revenue.join(" ")} ${lastX},${floor}`} fill="url(#revenueArea)"/><polygon points={`${firstX},${floor} ${profit.join(" ")} ${lastX},${floor}`} fill="url(#profitArea)"/>
      <polyline points={revenue.join(" ")} className={styles.revenueLine}/><polyline points={profit.join(" ")} className={styles.profitLine}/>
      {activeIndex !== null && <line x1={activeX} x2={activeX} y1={top} y2={floor} className={styles.hoverGuide}/>}
      {revenue.map((coords, index) => <circle key={rows[index].key} cx={coords.split(",")[0]} cy={coords.split(",")[1]} r="3.5" className={styles.revenueDot}/>)}
      {activeIndex !== null && <><circle cx={activeX} cy={revenue[activeIndex].split(",")[1]} r="5" className={styles.activeRevenueDot}/><circle cx={activeX} cy={profit[activeIndex].split(",")[1]} r="5" className={styles.activeProfitDot}/></>}
      {rows.map((row, index) => <text key={row.key} x={left + (rows.length === 1 ? 0 : index * ((width-left-right)/(rows.length-1)))} y={height-8} textAnchor={index === 0 ? "start" : index === rows.length-1 ? "end" : "middle"} className={styles.axisText}>{row.axisLabel ?? row.label}</text>)}
    </svg>
  </div>;
}

export default function HomePage() {
  const router = useRouter();
  const [period, setPeriod] = useState<DashboardPeriod>("month");
  const [companyYearStart, setCompanyYearStart] = useState(DEFAULT_COMPANY_YEAR_START);
  const [purchases, setPurchases] = useState<Purchase[]>([]); const [expenses, setExpenses] = useState<Expense[]>([]);
  const [completed, setCompleted] = useState<SalesHistoryResponse | null>(null); const [allSalesKpis, setAllSalesKpis] = useState<SalesHistoryResponse["kpis"] | null>(null);
  const [salesReport, setSalesReport] = useState<SalesReportResponse | null>(null);
  const [pending, setPending] = useState<SalesOrderListItem[]>([]); const [pendingTotal, setPendingTotal] = useState(0); const [recentSales, setRecentSales] = useState<SalesOrderListItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]); const [now, setNow] = useState(new Date());
  const [dashboardSceneMode, setDashboardSceneMode] = useState<DashboardSceneMode>("auto");
  const [loading, setLoading] = useState(true); const [salesLoading, setSalesLoading] = useState(true); const [opsLoading, setOpsLoading] = useState(true);
  const [returnLossAdjustmentPence, setReturnLossAdjustmentPence] = useState(0); const [returnsRefreshKey, setReturnsRefreshKey] = useState(0);
  const [lockedInScore, setLockedInScore] = useState(82); const [lockedInDraft, setLockedInDraft] = useState(82); const [editingLockedIn, setEditingLockedIn] = useState(false);
  const [dashboardError, setDashboardError] = useState(""); const [salesError, setSalesError] = useState(""); const [opsError, setOpsError] = useState("");

  useEffect(() => {
    document.documentElement.classList.add("dark", "space", "home-dashboard"); localStorage.setItem("purchase-tracker-theme", "space"); window.dispatchEvent(new Event("purchase-theme-change"));
    const syncSceneMode = () => { const saved = window.localStorage.getItem(DASHBOARD_SCENE_STORAGE_KEY); setDashboardSceneMode(isDashboardSceneMode(saved) ? saved : "auto"); };
    syncSceneMode(); window.addEventListener(DASHBOARD_SCENE_EVENT, syncSceneMode);
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => { document.documentElement.classList.remove("home-dashboard"); delete document.documentElement.dataset.dashboardScene; window.removeEventListener(DASHBOARD_SCENE_EVENT, syncSceneMode); window.clearInterval(timer); };
  }, []);
  useEffect(() => { document.documentElement.dataset.dashboardScene = resolveDashboardScene(dashboardSceneMode, now); }, [dashboardSceneMode, now]);
  useEffect(() => { const saved = window.localStorage.getItem("home-locked-in-score"); if (saved === null) return; const stored = Number(saved); if (Number.isFinite(stored) && stored >= 0 && stored <= 100) { setLockedInScore(stored); setLockedInDraft(stored); } }, []);
  useEffect(() => { const sync = () => setCompanyYearStart(window.localStorage.getItem(COMPANY_YEAR_STORAGE_KEY) || DEFAULT_COMPANY_YEAR_START); sync(); window.addEventListener(COMPANY_YEAR_CHANGED_EVENT, sync); return () => window.removeEventListener(COMPANY_YEAR_CHANGED_EVENT, sync); }, []);
  useEffect(() => { const onChange = () => setReturnsRefreshKey(key => key + 1); window.addEventListener(RETURNS_CHANGED_EVENT, onChange); return () => window.removeEventListener(RETURNS_CHANGED_EVENT, onChange); }, []);
  useEffect(() => {
    setDashboardError(""); Promise.all([fetch("/api/purchases"), fetch("/api/expenses"), fetch("/api/tasks")]).then(async responses => { if (responses.some(response => !response.ok)) throw new Error("Some dashboard information could not be loaded."); const [purchaseRows, expenseRows, taskRows] = await Promise.all(responses.map(response => response.json())); setPurchases(purchaseRows); setExpenses(expenseRows); setTasks(taskRows); }).catch((reason: Error) => setDashboardError(reason.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setSalesLoading(true); setSalesError("");
    Promise.all([
      fetchDashboardHistory(salesUrl(period, "completed", companyYearStart), controller.signal),
      fetchDashboardHistory(salesUrl(period, "all", companyYearStart), controller.signal),
      fetch(salesReportUrl(period, companyYearStart), { signal: controller.signal }).then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Sales chart could not be loaded.");
        return body as SalesReportResponse;
      }),
    ]).then(([completedBody, allBody, reportBody]) => { setCompleted(completedBody); setAllSalesKpis(allBody.kpis); setSalesReport(reportBody); }).catch(reason => { if (reason.name !== "AbortError") setSalesError(reason.message); }).finally(() => { if (!controller.signal.aborted) setSalesLoading(false); });
    fetch(netProfitAdjustmentUrl(period, companyYearStart), { signal: controller.signal }).then(response => response.ok ? response.json() : { adjustmentPence: 0 }).then(body => setReturnLossAdjustmentPence(Number(body?.adjustmentPence) || 0)).catch(() => { if (!controller.signal.aborted) setReturnLossAdjustmentPence(0); });
    return () => controller.abort();
  }, [period, returnsRefreshKey, companyYearStart]);
  useEffect(() => {
    const controller = new AbortController(); setOpsLoading(true); setOpsError("");
    Promise.all([fetchDashboardHistory(operationalSalesUrl("pending"), controller.signal), fetchDashboardHistory(operationalSalesUrl("all"), controller.signal)]).then(([pendingBody, recentBody]) => { setPendingTotal(pendingBody.total); setPending(pendingHomeSales(pendingBody.rows)); setRecentSales(recentHomeSales(recentBody.rows)); }).catch(reason => { if (reason.name !== "AbortError") setOpsError(reason.message || "Orders could not be loaded."); }).finally(() => { if (!controller.signal.aborted) setOpsLoading(false); });
    return () => controller.abort();
  }, [returnsRefreshKey]);

  const range = useMemo(() => periodRange(period, companyYearStart), [period, companyYearStart]);
  const periodPurchases = useMemo(() => range ? purchases.filter(row => row.order_date >= range.start && row.order_date <= range.end) : purchases, [purchases, range]);
  const operatingExpensePence = periodOperatingExpensePence(period, expenses, companyYearStart);
  const recentPurchases = useMemo(() => [...periodPurchases].sort((a,b) => b.order_date.localeCompare(a.order_date) || b.created_at.localeCompare(a.created_at)).slice(0,6), [periodPurchases]);
  const spendCategories = useMemo(() => homeSpendBreakdown(periodPurchases), [periodPurchases]);
  const donutStyle = useMemo(() => { const stops = spendCategories.rows.map((row, index) => { const start = spendCategories.rows.slice(0, index).reduce((sum, item) => sum + item.percentage, 0); const end = start + row.percentage; return `${row.color} ${start}% ${end}%`; }); return { "--donut": stops.length ? `conic-gradient(${stops.join(",")})` : "conic-gradient(#273043 0 100%)" } as CSSProperties; }, [spendCategories]);
  const chart = useMemo(() => homeReportChart(salesReport?.chart.daily ?? salesReport?.chart.monthly ?? []), [salesReport]);
  const selectedPeriod = periods.find(option => option.value === period)?.label ?? "This month";
  const kpis = completed?.kpis; const allValidSalesProfitPence = allSalesKpis?.profitPence ?? 0;
  const netProfitPence = netProfitWithReturnsLossesPence(allValidSalesProfitPence, operatingExpensePence, returnLossAdjustmentPence);
  const completedRevenuePence = kpis?.revenuePence ?? 0; const pendingRevenuePence = Math.max(0, (allSalesKpis?.revenuePence ?? 0) - completedRevenuePence);
  const pendingSalesCount = Math.max(0, (allSalesKpis?.completedSales ?? 0) - (kpis?.completedSales ?? 0));
  const netMargin = (allSalesKpis?.revenuePence ?? 0) ? netProfitPence / (allSalesKpis?.revenuePence ?? 1) * 100 : 0;
  const inStockUnits = purchases.filter(row => row.stock_status === "in_stock").reduce((sum,row) => sum + Math.max(1, Number(row.quantity)||1), 0);
  const awaitingValue = calculateAwaitingArrivalValue(purchases); const awaitingCount = countAwaitingArrival(purchases);
  const actionableTasks = tasks.filter(task => isTaskActionableToday(task)); const overdueTasks = tasks.filter(task => isTaskActionableToday(task) && isTaskOverdue(task));
  const hour = now.getHours(); const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const error = dashboardError || salesError || opsError;

  function saveLockedIn() { const score = Math.min(100, Math.max(0, Math.round(lockedInDraft))); setLockedInScore(score); setLockedInDraft(score); window.localStorage.setItem("home-locked-in-score", String(score)); setEditingLockedIn(false); }

  return <section className={styles.page}>
    <section className={styles.hero}>
      <div className={styles.constellation} aria-hidden="true"><i/><i/><i/><i/><i/><i/></div>
      <div className={styles.heroCopy}><span className={styles.eyebrow}>Overview</span><h1>{greeting}, Matthew</h1><div className={styles.heroBadges}><Link href="/tasks">☑ <b>{actionableTasks.length}</b> tasks due</Link><Link href="/tasks" className={styles.overdue}>△ <b>{overdueTasks.length}</b> overdue</Link><Link href="/sales?status=pending">◇ <b>{pendingTotal}</b> pending orders</Link></div></div>
      <div className={styles.clock}><span>{now.toLocaleDateString("en-GB", { weekday: "long" })}</span><strong>{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}</strong><small>{now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</small></div>
      <div className={styles.health}><span><i/>All running</span><span><i/>Database synced</span><span><i/>eBay synced</span></div>
      <div className={styles.periodSwitch} aria-label="Dashboard period">{periods.map(option => <button key={option.value} type="button" className={period === option.value ? styles.active : ""} onClick={() => setPeriod(option.value)} aria-pressed={period === option.value}>{option.label}</button>)}</div>
    </section>
    {error && <div className={styles.error}>{error}</div>}
    <section className={styles.metrics} aria-busy={loading || salesLoading}>
      <article className={`${styles.metric} ${styles.profitMetric}`}><span className={styles.metricLabel}>Net profit</span><span className={styles.metricIcon}><MetricIcon name="profit"/></span><strong>{salesLoading ? "—" : money.format(netProfitPence/100)}</strong><small><b>{salesLoading ? "—" : `${netMargin.toFixed(1)}%`}</b> margin</small></article>
      <article className={`${styles.metric} ${styles.revenueMetric}`}><span className={styles.metricLabel}>Revenue</span><span className={styles.metricIcon}><MetricIcon name="revenue"/></span><div className={styles.revenueSplit}><span><small>Completed</small><strong>{salesLoading ? "—" : money.format(completedRevenuePence/100)}</strong><em>{kpis?.completedSales ?? 0} completed sales</em></span><span><small>Pending</small><strong>{salesLoading ? "—" : money.format(pendingRevenuePence/100)}</strong><em>{pendingSalesCount} pending sales</em></span></div></article>
      <article className={`${styles.metric} ${styles.stockMetric}`}><span className={styles.metricLabel}>Stock</span><span className={styles.metricIcon}><MetricIcon name="stock"/></span><strong>{loading ? "—" : `${inStockUnits.toLocaleString("en-GB")} units in stock`}</strong><small>{loading ? "Loading stock…" : `${money.format(awaitingValue)} incoming · ${awaitingCount} units`}</small></article>
      <article className={`${styles.metric} ${styles.lockedMetric}`}><span className={styles.metricLabel}>Locked in</span><span className={styles.metricIcon}><MetricIcon name="locked"/></span><strong>{lockedInScore} <i>/ 100</i></strong><small>Your efficiency rating</small><button className={styles.editScore} type="button" aria-label="Edit Locked In score" onClick={() => { setLockedInDraft(lockedInScore); setEditingLockedIn(value => !value); }}>✎</button>{editingLockedIn && <div className={styles.scorePopover}><h3>Edit Locked In score</h3><div className={styles.scoreControl}><input type="range" min="0" max="100" value={lockedInDraft} onChange={event => setLockedInDraft(Number(event.target.value))}/><output>{lockedInDraft}</output></div><p>Your personal efficiency rating</p><div><button type="button" onClick={() => setEditingLockedIn(false)}>Cancel</button><button type="button" onClick={saveLockedIn}>Save</button></div></div>}</article>
    </section>

    <div className={styles.grid}><TodaysTasksCard maxTasks={4}/><section className={styles.panel}><div className={styles.heading}><h2>Sales Overview</h2><span>{selectedPeriod}</span></div><div className={styles.overviewBody}><div className={styles.overviewStats}><div><span>□</span><strong>{salesLoading ? "—" : kpis?.completedSales ?? 0}</strong><small>Completed sales</small></div><div><span>£</span><strong>{salesLoading ? "—" : money.format(completedRevenuePence/100)}</strong><small>Completed revenue</small></div><div><span>£</span><strong className={styles.green}>{salesLoading ? "—" : money.format((kpis?.profitPence ?? 0)/100)}</strong><small>Total profit</small></div><Link href="/sales">View sales →</Link></div><LineChart rows={chart} label={selectedPeriod}/></div></section></div>
    <div className={styles.grid}><section className={styles.panel}><div className={styles.heading}><h2>Pending Orders</h2><span>{opsLoading || opsError ? "" : orderCountLabel(pendingTotal)}</span></div><div className={styles.orderRows}>{pending.length ? pending.map(row => { const status = salesProcessPresentation(row); return <Link href={`/sales/${row.id}`} className={styles.orderRow} key={row.id}><span className={styles.status}><i/>{status.shortLabel}</span><strong title={itemLabel(row)}>{itemLabel(row)}</strong><span>{platformLabel(row)}</span><b>{money.format(Number(row.total_revenue))}</b><em>›</em></Link>; }) : <div className={styles.empty}>{opsLoading ? "Loading orders…" : opsError ? "Pending orders could not be loaded." : "No pending orders."}</div>}</div></section><section className={styles.panel}><div className={styles.heading}><h2>Recent Sales</h2><span>{opsLoading || opsError ? "" : "Latest 5"}</span></div><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Date</th><th>Item</th><th>Platform</th><th>Revenue</th><th>Profit</th><th>Status</th></tr></thead><tbody>{recentSales.length ? recentSales.map(row => { const status=salesProcessPresentation(row); return <tr key={row.id} onClick={() => router.push(`/sales/${row.id}`)}><td>{new Date(`${row.sale_date}T00:00:00`).toLocaleDateString("en-GB")}</td><td>{itemLabel(row)}</td><td>{platformLabel(row)}</td><td>{money.format(Number(row.total_revenue))}</td><td className={row.profitPence < 0 ? styles.red : styles.green}>{money.format(row.profitPence/100)}</td><td><span className={styles.status}><i/>{status.shortLabel}</span></td></tr>}) : <tr><td colSpan={6} className={styles.empty}>{opsLoading ? "Loading sales…" : opsError ? "Recent sales could not be loaded." : "No recent sales."}</td></tr>}</tbody></table></div></section></div>
    <div className={styles.grid}><section className={styles.panel}><div className={styles.heading}><h2>Where My Money Went</h2><span>{selectedPeriod}</span></div><div className={styles.spendBody}>{spendCategories.rows.length ? <><div className={styles.donut} style={donutStyle}><div><strong>{shortMoney.format(spendCategories.total)}</strong><span>Total spent</span></div></div><div className={styles.categoryList}>{spendCategories.rows.map(row => <div key={row.name}><i style={{background:row.color}}/><strong>{row.name}</strong><b>{shortMoney.format(row.value)}</b><span>{row.percentage.toFixed(1)}%</span></div>)}</div></> : <div className={styles.empty}>No purchase spending in this period.</div>}</div></section><section className={styles.panel}><div className={styles.heading}><h2>Recent Purchases</h2><span>Latest 6</span></div><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Date</th><th>Description</th><th>Size</th><th>Price</th><th>SKU</th></tr></thead><tbody>{recentPurchases.map(row => <tr key={row.id} onClick={() => router.push(`/purchases/${row.id}`)}><td>{new Date(`${row.order_date}T00:00:00`).toLocaleDateString("en-GB")}</td><td>{row.item_description}</td><td>{row.item_size}</td><td>{money.format(Number(row.price_purchased))}</td><td>{row.sku}</td></tr>)}</tbody></table></div></section></div>
    <footer className={styles.footer}><span>TROTTER&apos;S ATTIRE</span><i/>Trading HQ<nav><a href="#">Help</a><a href="#">Privacy</a><a href="#">Terms</a><b><i/>All systems operational</b></nav></footer>
  </section>;
}
