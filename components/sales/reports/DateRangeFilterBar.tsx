"use client";
import { dateRangePresets, type DateRangePreset } from "@/lib/sales/report-date-range";
import styles from "@/app/sales/sales.module.css";

type Props = {
  preset: DateRangePreset;
  customStart: string;
  customEnd: string;
  rangeLabel: string | null;
  validationError: string | null;
  onPresetChange: (preset: DateRangePreset) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
};

/**
 * Pure controlled filter bar — every value (preset, custom dates, resolved
 * range label, validation error) is owned by the page, not this component,
 * so a single fetch effect there stays the one source of truth for "what
 * filter is currently applied," matching the requirement that changing
 * filters must refresh every card/chart/comparison together.
 */
export default function DateRangeFilterBar({ preset, customStart, customEnd, rangeLabel, validationError, onPresetChange, onCustomStartChange, onCustomEndChange }: Props) {
  return <div className={styles.filterBar}>
    <div className={styles.presetGroup} role="group" aria-label="Filter sales reports by date range">
      {dateRangePresets.map(option => <button
        key={option.value}
        type="button"
        className={`${styles.presetButton} ${preset === option.value ? styles.presetButtonActive : ""}`}
        aria-pressed={preset === option.value}
        onClick={() => onPresetChange(option.value)}
      >
        {option.label}
      </button>)}
    </div>

    {rangeLabel && <div className={styles.rangeInfo}>
      <span className={styles.rangeInfoLabel}>Showing</span>
      <span className={styles.rangeInfoValue}>{rangeLabel}</span>
    </div>}

    {preset === "custom" && <div className={styles.customRangeRow}>
      <div className={styles.customRangeField}>
        <label htmlFor="report-custom-start">Start date</label>
        <input id="report-custom-start" type="text" placeholder="DD/MM/YYYY" value={customStart} onChange={event => onCustomStartChange(event.target.value)} autoComplete="off" />
      </div>
      <div className={styles.customRangeField}>
        <label htmlFor="report-custom-end">End date</label>
        <input id="report-custom-end" type="text" placeholder="DD/MM/YYYY" value={customEnd} onChange={event => onCustomEndChange(event.target.value)} autoComplete="off" />
      </div>
      {validationError && <p className={styles.customRangeError} role="alert">{validationError}</p>}
    </div>}
  </div>;
}
