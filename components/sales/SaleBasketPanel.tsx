"use client";
import { useState } from "react";
import type { Purchase } from "@/lib/types";
import { groupBasketItems, totalStockCostPence } from "@/lib/sales/basket";
import type { UnitAllocation } from "@/lib/sales/allocation";
import { formatPenceAsGBP } from "@/lib/sales/money";
import styles from "@/app/sales/sales.module.css";

/**
 * Shared basket display — used identically by Quick Sale and Order Sale.
 * Groups visually-identical units (same description/category/condition)
 * for a compact view, but every remove action and the underlying selection
 * always operates on exact purchase UUIDs, never the group as a whole
 * concept — removing "a group" is simply removing every UUID currently in
 * it, nothing is ever matched by description/SKU text.
 */
export default function SaleBasketPanel({ items, onRemoveUnit, onRemoveGroup, onClear, revenueMode, unitPrices, onUnitPriceChange, unitAllocations, children }: {
  items: Purchase[];
  onRemoveUnit: (id: string) => void;
  onRemoveGroup: (groupKey: string) => void;
  onClear: () => void;
  revenueMode: "total" | "average" | "itemised";
  unitPrices: Record<string, string>;
  onUnitPriceChange: (groupKey: string, value: string) => void;
  // Exact per-unit revenue/fee/postage/profit, keyed by purchase UUID —
  // computed by the parent via computeBasketAllocation (see
  // lib/sales/allocation.ts) so this component never re-derives money math,
  // it only displays it. Never renders the UUID key itself, only the
  // human-facing fields on each allocation.
  unitAllocations: Map<string, UnitAllocation>;
  // The financial summary (revenue/fees/postage/profit/margin) and Record
  // Sale button live in the SAME sticky panel as the basket contents,
  // passed in from the parent so this component stays focused purely on
  // "what's in the basket" — see app/sales/new/page.tsx.
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = groupBasketItems(items);

  function toggleExpanded(key: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return <div className={styles.basketPanel}>
    <div className={styles.basketHeading}>
      <h2>Basket</h2>
      <span className={styles.basketCount}>{items.length}</span>
    </div>

    {items.length === 0 && <p className={styles.basketEmpty}>No units selected yet. Search above to add exact purchase units.</p>}

    {items.length > 0 && <>
      <div className={styles.basketGroupList}>
        {groups.map(group => {
          const isExpanded = expanded.has(group.key) || group.items.length === 1;
          const groupCostPence = totalStockCostPence(group.items);
          const groupAllocations = group.items.map(item => unitAllocations.get(item.id)).filter((a): a is UnitAllocation => a !== undefined);
          const averageUnitProfitPence = groupAllocations.length > 0
            ? groupAllocations.reduce((sum, a) => sum + a.profitPence, 0) / groupAllocations.length
            : null;
          return <div key={group.key} className={styles.basketGroup}>
            <div className={styles.basketGroupHeader}>
              {group.items.length > 1 && <button type="button" className={styles.iconButton} aria-label={isExpanded ? `Collapse ${group.description}` : `Expand ${group.description}`} aria-expanded={isExpanded} onClick={() => toggleExpanded(group.key)}>
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }}><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>}
              <div className={styles.basketGroupInfo}>
                <span className={styles.basketGroupTitle}>{group.description}{group.items.length > 1 ? ` × ${group.items.length}` : ""}</span>
                <span className={styles.basketGroupMeta}>{group.category} · {group.condition}</span>
              </div>
              <div className={styles.basketGroupFinance}>
                <span className={styles.basketGroupCost}>{formatPenceAsGBP(groupCostPence)}</span>
                {averageUnitProfitPence !== null && <span className={`${styles.basketGroupProfit} ${averageUnitProfitPence < 0 ? styles.negative : ""}`}>
                  Profit/unit {formatPenceAsGBP(averageUnitProfitPence)}
                </span>}
              </div>
              <button type="button" className={styles.iconButton} aria-label={`Remove all ${group.description} from basket`} onClick={() => onRemoveGroup(group.key)}>
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>
            </div>

            {revenueMode === "itemised" && <div className={styles.unitPriceRow}>
              <label htmlFor={`unit-price-${group.key}`}>Sale price each</label>
              <input
                id={`unit-price-${group.key}`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={unitPrices[group.key] ?? ""}
                onChange={event => onUnitPriceChange(group.key, event.target.value)}
                placeholder="0.00"
                aria-label={`Sale price each for ${group.description}`}
              />
            </div>}

            {isExpanded && <div className={styles.basketUnitList}>
              {group.items.map(item => {
                const allocation = unitAllocations.get(item.id);
                return <div key={item.id} className={styles.basketUnitDetail}>
                  <div className={styles.basketUnitTop}>
                    <span className={styles.basketUnitLabel}>{item.purchased_from} · {item.order_date}</span>
                    <span className={`${styles.basketUnitProfit} ${allocation && allocation.profitPence < 0 ? styles.negative : ""}`}>
                      {allocation ? formatPenceAsGBP(allocation.profitPence) : "—"}
                    </span>
                    {group.items.length > 1 && <button type="button" className={styles.iconButton} aria-label={`Remove this ${item.item_description} unit (${item.purchased_from}, ${item.order_date}) from basket`} onClick={() => onRemoveUnit(item.id)}>
                      <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                    </button>}
                  </div>
                  {allocation && <div className={styles.basketUnitBreakdown}>
                    Cost {formatPenceAsGBP(allocation.costPence)} · Revenue {formatPenceAsGBP(allocation.revenuePence)}
                    {(allocation.feePence > 0 || allocation.postagePence > 0) ? ` · Fees ${formatPenceAsGBP(allocation.feePence)} · Postage ${formatPenceAsGBP(allocation.postagePence)}` : ""}
                  </div>}
                </div>;
              })}
            </div>}
          </div>;
        })}
      </div>

      <div className={styles.basketTotals}>
        <div className={styles.basketTotalsRow}><span>Total units</span><span>{items.length}</span></div>
        <div className={styles.basketTotalsRow}><span>Total stock cost</span><span>{formatPenceAsGBP(totalStockCostPence(items))}</span></div>
      </div>
      <button type="button" className="button-secondary" onClick={onClear}>Clear basket</button>
    </>}
    {items.length > 0 && children}
  </div>;
}
