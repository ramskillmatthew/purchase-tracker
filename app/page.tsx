"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Expense, Purchase } from "@/lib/types";
import TodaysTasksCard from "@/components/TodaysTasksCard";
import { computeHomeReport, periods, type Period } from "@/lib/home-report";

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const shortMoney = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

export default function HomePage() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>("month");
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([fetch("/api/purchases"), fetch("/api/expenses")])
      .then(async ([purchaseResponse, expenseResponse]) => {
        if (!purchaseResponse.ok || !expenseResponse.ok) throw new Error("Could not load business totals.");
        const [purchaseRows, expenseRows] = await Promise.all([purchaseResponse.json(), expenseResponse.json()]);
        setPurchases(purchaseRows);
        setExpenses(expenseRows);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  const report = useMemo(() => computeHomeReport(period, purchases, expenses), [period, purchases, expenses]);

  return <section className="page-shell home-page">
    <header className="home-header">
      <h1>Home</h1>
      <div className="period-control"><span>Compare period</span><div className="period-switch" aria-label="Compare period">
        {periods.map(option => <button key={option.value} type="button" className={period === option.value ? "period-active" : ""} onClick={() => setPeriod(option.value)}>{option.label}</button>)}
      </div>
      </div>
    </header>

    {error && <div className="home-error">{error}</div>}

    <div className="summary-grid" aria-busy={loading}>
      <article><span>Purchases</span><strong>{loading ? "—" : report.periodPurchases.length.toLocaleString("en-GB")}</strong><small>{periods.find(item => item.value === period)?.label}</small></article>
      <article><span>Stock spend</span><strong>{loading ? "—" : money.format(report.stockSpend)}</strong><small>{period === "all-time" ? "Purchases across all time" : "Purchases in period"}</small></article>
      <article><span>Business expenses</span><strong>{loading ? "—" : money.format(report.expenseSpend)}</strong><small>{period === "all-time" ? "Expenses across all time" : "Expenses in period"}</small></article>
      <article className="summary-total"><span>Total spend</span><strong>{loading ? "—" : money.format(report.stockSpend + report.expenseSpend)}</strong><small>Stock + expenses</small></article>
    </div>

    <TodaysTasksCard />

    <div className="home-content-grid">
      <section className="home-panel money-panel">
        <div className="home-panel-heading"><h2>Where My Money Went</h2><span>{report.sources.length} sources</span></div>
        <div className="source-bars">
          {report.sources.length ? report.sources.map((source, index) => <div className="source-bar-row" key={source.source}>
            <div className="source-bar-meta"><strong>{source.source}</strong><span>{shortMoney.format(source.spend)} <i>{source.percentage.toFixed(0)}%</i></span></div>
            <div className="source-bar-track"><span style={{ width: `${source.percentage}%`, opacity: Math.max(.48, 1 - index * .09) }} /></div>
          </div>) : <div className="home-inline-empty">No purchase spending in this period.</div>}
        </div>
      </section>

      <section className="home-panel source-table-panel">
        <div className="home-panel-heading"><h2>Top Spending Sources</h2><span>Highest spend first</span></div>
        <div className="home-table-scroll"><table className="home-table"><thead><tr><th>Purchased From</th><th>Total Spend</th><th>Purchases</th><th>Average</th></tr></thead><tbody>
          {report.sources.length ? report.sources.map(source => <tr key={source.source}><td>{source.source}</td><td>{money.format(source.spend)}</td><td>{source.purchases}</td><td>{money.format(source.average)}</td></tr>) : <tr className="home-table-empty"><td colSpan={4}>No spending sources in this period.</td></tr>}
        </tbody></table></div>
      </section>
    </div>

    <section className="home-panel recent-panel">
      <div className="home-panel-heading"><h2>Recent Purchases</h2><span>Latest 10 in period</span></div>
      <div className="home-table-scroll"><table className="home-table recent-table"><thead><tr><th>Date</th><th>Seller</th><th>Description</th><th>Size</th><th>Price</th><th>SKU</th></tr></thead><tbody>
        {report.recent.length ? report.recent.map(row => <tr key={row.id} tabIndex={0} onClick={() => router.push(`/purchases/${row.id}`)} onKeyDown={event => { if (event.key === "Enter") router.push(`/purchases/${row.id}`); }}><td>{new Date(`${row.order_date}T00:00:00`).toLocaleDateString("en-GB")}</td><td>{row.seller_name || "—"}</td><td>{row.item_description}</td><td>{row.item_size}</td><td>{money.format(Number(row.price_purchased))}</td><td><span className="home-sku">{row.sku}</span></td></tr>) : <tr className="home-table-empty"><td colSpan={6}>No purchases in this period.</td></tr>}
      </tbody></table></div>
    </section>
  </section>;
}
