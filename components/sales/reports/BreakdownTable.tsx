"use client";
import { useMemo, useState } from "react";
import styles from "@/app/sales/sales.module.css";

export type BreakdownColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => string;
  align?: "left" | "right";
};

export type BreakdownSortOption<T> = {
  key: string;
  label: string;
  compare: (a: T, b: T) => number;
};

type Props<T> = {
  title: string;
  rows: T[];
  rowKey: (row: T) => string;
  rowLabel: (row: T) => string;
  columns: BreakdownColumn<T>[];
  sortOptions: BreakdownSortOption<T>[];
  barValue: (row: T) => number;
  emptyMessage: string;
};

/**
 * One shared table+bar presentation reused for the Category, Condition, and
 * Platform comparisons — the underlying columns genuinely differ per
 * section (see app/sales/reports/page.tsx), but the "sortable rows with a
 * revenue-proportional horizontal bar next to the label" structure and
 * styling is identical across all three, so it lives here once rather than
 * being copy-pasted three times.
 *
 * Sorting is entirely client-side over the already-fetched rows for the
 * current filter — changing sort never re-fetches or re-aggregates, since
 * the full breakdown for the period is already in hand.
 */
export default function BreakdownTable<T>({ title, rows, rowKey, rowLabel, columns, sortOptions, barValue, emptyMessage }: Props<T>) {
  const [sortKey, setSortKey] = useState(sortOptions[0]?.key);
  const activeSort = sortOptions.find(option => option.key === sortKey) ?? sortOptions[0];

  const sortedRows = useMemo(() => {
    if (!activeSort) return rows;
    return [...rows].sort(activeSort.compare);
  }, [rows, activeSort]);

  const maxBarValue = Math.max(1, ...rows.map(row => Math.abs(barValue(row))));

  return <section className={styles.reportSection}>
    <div className={styles.reportSectionHeader}>
      <h2>{title}</h2>
      {sortOptions.length > 1 && <div className={styles.sortGroup} role="group" aria-label={`Sort ${title.toLowerCase()}`}>
        {sortOptions.map(option => <button key={option.key} type="button" className={sortKey === option.key ? styles.sortGroupActive : undefined} onClick={() => setSortKey(option.key)}>{option.label}</button>)}
      </div>}
    </div>

    {rows.length === 0 ? <div className={styles.comparisonPanel}><div className={styles.emptyState}><span>{emptyMessage}</span></div></div> : <div className={styles.comparisonPanel}>
      <table className={styles.comparisonTable}>
        <thead><tr>
          <th className={styles.comparisonLabelCell}>{/* label + bar */}</th>
          {columns.map(column => <th key={column.key} className={column.align === "right" ? styles.numeric : undefined}>{column.label}</th>)}
        </tr></thead>
        <tbody>
          {sortedRows.map(row => {
            const value = barValue(row);
            const widthPercent = Math.min(100, (Math.abs(value) / maxBarValue) * 100);
            return <tr key={rowKey(row)}>
              <td className={styles.comparisonLabelCell}>
                <div>{rowLabel(row)}</div>
                <div className={styles.comparisonBarTrack}>
                  <div className={`${styles.comparisonBarFill} ${value < 0 ? styles.comparisonBarFillNegative : ""}`} style={{ width: `${widthPercent}%` }} />
                </div>
              </td>
              {columns.map(column => <td key={column.key} className={column.align === "right" ? styles.numeric : undefined}>{column.render(row)}</td>)}
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
  </section>;
}
