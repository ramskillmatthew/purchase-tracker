import type { ReportSummary } from "@/lib/sales/reporting";
import { formatPenceAsGBP, formatMarginPercent } from "@/lib/sales/money";
import { dashboardProfitTone, profitBadgeTone } from "@/lib/sales/profit";
import styles from "@/app/sales/sales.module.css";

const PROFIT_TONE_CLASS = { red: styles.heroCardNegative, green: styles.heroCardPositive } as const;
// "Average profit per unit" deliberately uses the same red/amber/green
// per-sale-scale bands as the Sales history table's profitBadgeTone (not
// the binary dashboard rule below) — see dashboardProfitTone's own doc
// comment in lib/sales/profit.ts for why the two figures need different
// rules.
const PER_UNIT_TONE_CLASS = { red: styles.avgProfitRed, amber: styles.avgProfitAmber, green: styles.avgProfitGreen } as const;

/**
 * Revenue and profit are the two figures the task calls out as most
 * important, so they alone get the larger "hero" card treatment; every
 * other figure (stock cost, fees, postage, orders, units, AOV, avg
 * profit/unit, margin) shares one smaller, equally-weighted grid beneath —
 * avoiding a wall of equally prominent numbers.
 */
export default function ReportSummaryCards({ summary }: { summary: ReportSummary }) {
  const profitTone = dashboardProfitTone(summary.profitPence);
  const avgProfitTone = summary.averageProfitPerUnitPence === null ? null : profitBadgeTone(summary.averageProfitPerUnitPence);

  return <>
    <div className={styles.heroCardsGrid}>
      <div className={styles.heroCard}>
        <span>Total revenue</span>
        <strong>{formatPenceAsGBP(summary.revenuePence)}</strong>
      </div>
      <div className={`${styles.heroCard} ${PROFIT_TONE_CLASS[profitTone]}`}>
        <span>Total profit</span>
        <strong>{formatPenceAsGBP(summary.profitPence)}</strong>
      </div>
    </div>

    <div className={styles.cardsGrid}>
      <div className={styles.summaryCard}><span>Stock cost</span><strong>{formatPenceAsGBP(summary.stockCostPence)}</strong></div>
      <div className={styles.summaryCard}><span>Platform fees</span><strong>{formatPenceAsGBP(summary.feesPence)}</strong></div>
      <div className={styles.summaryCard}><span>Postage</span><strong>{formatPenceAsGBP(summary.postagePence)}</strong></div>
      <div className={styles.summaryCard}><span>Orders completed</span><strong>{summary.orders.toLocaleString("en-GB")}</strong></div>
      <div className={styles.summaryCard}><span>Units sold</span><strong>{summary.units.toLocaleString("en-GB")}</strong></div>
      <div className={styles.summaryCard}><span>Average order value</span><strong>{formatPenceAsGBP(summary.averageOrderValuePence)}</strong></div>
      <div className={styles.summaryCard}>
        <span>Average profit per unit</span>
        <strong className={avgProfitTone ? PER_UNIT_TONE_CLASS[avgProfitTone] : undefined}>
          {formatPenceAsGBP(summary.averageProfitPerUnitPence)}
        </strong>
      </div>
      <div className={styles.summaryCard}><span>Profit margin</span><strong>{formatMarginPercent(summary.marginPercent)}</strong></div>
    </div>
  </>;
}
