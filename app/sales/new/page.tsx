"use client";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CreateSaleResult, Purchase, SalesPlatform } from "@/lib/types";
import { basketGroupKey, buildItemisedLineRevenuesPence, groupBasketItems, totalStockCostPence } from "@/lib/sales/basket";
import { computeBasketAllocation, normalizeRevenueInputPence, type UnitAllocation } from "@/lib/sales/allocation";
import { calculateMarginPercent } from "@/lib/sales/profit";
import { formatMarginPercent, formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import PurchaseSearchPanel from "@/components/sales/PurchaseSearchPanel";
import SaleBasketPanel from "@/components/sales/SaleBasketPanel";
import styles from "../sales.module.css";

const PLATFORM_LABELS: Record<SalesPlatform, string> = { vinted: "Vinted", ebay: "eBay", depop: "Depop", other: "Other" };
const PLATFORM_OPTIONS: SalesPlatform[] = ["vinted", "ebay", "depop", "other"];
type RevenueMode = "total" | "average" | "itemised";

function todayIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function NewSalePage() {
  return <Suspense fallback={null}><SaleBuilder /></Suspense>;
}

function SaleBuilder() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode: "quick" | "order" = searchParams.get("mode") === "order" ? "order" : "quick";
  const [mode, setMode] = useState<"quick" | "order">(initialMode);

  const [basket, setBasket] = useState<Map<string, Purchase>>(new Map());
  const [saleDate, setSaleDate] = useState(todayIso());
  const [platform, setPlatform] = useState<SalesPlatform>("vinted");
  const [customPlatformName, setCustomPlatformName] = useState("");
  const [revenueMode, setRevenueMode] = useState<RevenueMode>("total");
  const [revenueValue, setRevenueValue] = useState("");
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>({});
  const [fees, setFees] = useState("");
  const [postage, setPostage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [successResult, setSuccessResult] = useState<CreateSaleResult | null>(null);

  const items = useMemo(() => [...basket.values()], [basket]);
  const groups = useMemo(() => groupBasketItems(items), [items]);

  function addUnit(purchase: Purchase) {
    setBasket(current => {
      if (current.has(purchase.id)) return current; // REGRESSION guard: the same purchase UUID must never be added twice
      const next = new Map(current);
      next.set(purchase.id, purchase);
      return next;
    });
  }
  function addAll(purchases: Purchase[]) {
    setBasket(current => {
      const next = new Map(current);
      for (const purchase of purchases) if (!next.has(purchase.id)) next.set(purchase.id, purchase);
      return next;
    });
  }
  function removeUnit(id: string) {
    setBasket(current => { const next = new Map(current); next.delete(id); return next; });
  }
  function removeGroup(groupKey: string) {
    setBasket(current => {
      const next = new Map(current);
      for (const [id, purchase] of current) if (basketGroupKey(purchase) === groupKey) next.delete(id);
      return next;
    });
  }
  function clearBasket() {
    // Only ever clears LOCAL, unsaved selection state — never touches stock
    // or any database record. Nothing is sent to the server by this action.
    setBasket(new Map());
  }

  function changePlatform(next: SalesPlatform) {
    setPlatform(next);
    if (next !== "other") setCustomPlatformName("");
  }

  // Live financial summary — integer pence throughout (see lib/sales/money.ts,
  // lib/sales/allocation.ts, lib/sales/profit.ts). Itemised mode's revenue is
  // entirely DERIVED from the per-group unit prices below — there is no
  // separate "order total" field to reconcile against, so a mismatch is
  // structurally impossible.
  const stockCostPence = totalStockCostPence(items);
  const feesPence = poundsToPence(Number(fees) || 0);
  const postagePence = poundsToPence(Number(postage) || 0);
  const itemisedLines = useMemo(() => {
    const unitPricesPence: Record<string, number> = {};
    for (const [key, value] of Object.entries(unitPrices)) unitPricesPence[key] = poundsToPence(Number(value) || 0);
    return buildItemisedLineRevenuesPence(groups, unitPricesPence);
  }, [groups, unitPrices]);
  const revenuePence = revenueMode === "itemised"
    ? itemisedLines.reduce((sum, line) => sum + line.revenuePence, 0)
    : normalizeRevenueInputPence(revenueMode, poundsToPence(Number(revenueValue) || 0), items.length);
  const profitPence = revenuePence - stockCostPence - feesPence - postagePence;
  const marginPercent = calculateMarginPercent(profitPence, revenuePence);
  const averageProfitPerUnitPence = items.length > 0 ? profitPence / items.length : null;

  // Exact per-unit revenue/fee/postage/profit — mirrors the atomic RPC's own
  // deterministic allocation (see lib/sales/allocation.ts) so the live
  // preview shown in the basket panel agrees to the penny with what gets
  // saved. Never derived by dividing the order total by unit count: units
  // with the same description can carry different purchase costs.
  const itemisedRevenueByPurchaseId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of itemisedLines) map[line.purchaseId] = line.revenuePence;
    return map;
  }, [itemisedLines]);
  const unitAllocations = useMemo(() => {
    const units = items.map(item => ({ purchaseId: item.id, costPence: poundsToPence(Number(item.price_purchased)) }));
    const allocations = computeBasketAllocation(units, revenueMode, revenuePence, feesPence, postagePence, itemisedRevenueByPurchaseId);
    return new Map<string, UnitAllocation>(allocations.map(allocation => [allocation.purchaseId, allocation]));
  }, [items, revenueMode, revenuePence, feesPence, postagePence, itemisedRevenueByPurchaseId]);

  const otherPlatformNameValid = platform !== "other" || customPlatformName.trim().length > 0;
  const revenueEntered = revenueMode === "itemised" ? itemisedLines.some(line => line.revenuePence > 0) || groups.every(group => (unitPrices[group.key] ?? "") !== "") : revenueValue.trim() !== "" && Number(revenueValue) >= 0;
  const canSubmit = items.length > 0 && otherPlatformNameValid && revenueEntered && !submitting;

  async function recordSale() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const purchaseIds = items.map(item => item.id);
      const body = {
        purchaseIds,
        saleDate,
        platform,
        customPlatformName: platform === "other" ? customPlatformName.trim() : null,
        revenueInputMode: revenueMode,
        revenueInputValue: revenueMode === "itemised" ? revenuePence / 100 : Number(revenueValue) || 0,
        lineRevenues: revenueMode === "itemised" ? itemisedLines.map(line => ({ purchaseId: line.purchaseId, revenue: line.revenuePence / 100 })) : undefined,
        platformFees: Number(fees) || 0,
        postage: Number(postage) || 0,
      };
      const response = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        // Server-side availability conflict (or any other rejection) — the
        // basket and every field the user filled in stay exactly as they
        // were, so nothing needs re-entering; only the error changes.
        setSubmitError(responseBody?.error || "Could not record the sale.");
        return;
      }
      setSuccessResult(responseBody as CreateSaleResult);
      setBasket(new Map());
      setRevenueValue("");
      setUnitPrices({});
      setFees("");
      setPostage("");
    } catch {
      setSubmitError("Could not record the sale. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (successResult) {
    return <section className="page-shell">
      <header className={styles.topbar}><div className="title-row"><h1>Sale recorded</h1></div></header>
      <div className={styles.successBanner}>
        <span>✓</span>
        <span>{successResult.items.length} item{successResult.items.length === 1 ? "" : "s"} recorded for {formatPenceAsGBP(poundsToPence(Number(successResult.order.total_revenue)))}.</span>
      </div>
      <div className={styles.topbarActions} style={{ marginTop: 14 }}>
        <button type="button" className="button-secondary" onClick={() => router.push("/sales")}>Back to Sales</button>
        <button type="button" className="button" onClick={() => router.push(`/sales/${successResult.order.id}`)}>View sale</button>
        <button type="button" className="button-secondary" onClick={() => setSuccessResult(null)}>Record another</button>
      </div>
    </section>;
  }

  return <section className="page-shell">
    <header className={styles.topbar}>
      <div className="title-row"><h1>{mode === "quick" ? "Quick Sale" : "Order Sale"}</h1></div>
      <div className={styles.modeSwitch} role="group" aria-label="Sale type">
        <button type="button" className={mode === "quick" ? styles.modeSwitchActive : ""} onClick={() => setMode("quick")}>Quick Sale</button>
        <button type="button" className={mode === "order" ? styles.modeSwitchActive : ""} onClick={() => setMode("order")}>Order Sale (basket)</button>
      </div>
    </header>

    <div className={styles.builderLayout}>
      <div className={styles.builderMain}>
        <PurchaseSearchPanel onAdd={addUnit} onAddAll={addAll} selectedIds={new Set(basket.keys())} />
        {mode === "quick" && groups.length > 1 && <p className={styles.resultHint}>
          This basket now has {groups.length} different products. Switch to Order Sale for accurate per-product pricing, or keep going with Quick Sale's total/average revenue.
        </p>}

        <div className={styles.searchPanel}>
          <div className={styles.detailsGrid}>
            <label className="field"><span className="label">Date sold</span><input className="input" type="date" value={saleDate} onChange={event => setSaleDate(event.target.value)} required /></label>
            <label className="field"><span className="label">Platform</span>
              <select className="input" value={platform} onChange={event => changePlatform(event.target.value as SalesPlatform)}>
                {PLATFORM_OPTIONS.map(option => <option key={option} value={option}>{PLATFORM_LABELS[option]}</option>)}
              </select>
            </label>
            {platform === "other" && <label className="field detailsGridWide"><span className="label">Where did you sell it?</span>
              <input className="input" value={customPlatformName} onChange={event => setCustomPlatformName(event.target.value)} placeholder="e.g. Facebook Marketplace" required aria-required="true" />
            </label>}

            <label className="field detailsGridWide"><span className="label">Revenue entry</span>
              <div className={styles.revenueModeSwitch} role="group" aria-label="Revenue entry mode">
                <button type="button" className={revenueMode === "total" ? styles.revenueModeActive : ""} onClick={() => setRevenueMode("total")}>Total revenue</button>
                <button type="button" className={revenueMode === "average" ? styles.revenueModeActive : ""} onClick={() => setRevenueMode("average")}>Average per item</button>
                {mode === "order" && <button type="button" className={revenueMode === "itemised" ? styles.revenueModeActive : ""} onClick={() => setRevenueMode("itemised")}>Itemised</button>}
              </div>
            </label>

            {revenueMode !== "itemised" && <label className="field detailsGridWide">
              <span className="label">{revenueMode === "average" ? "Average revenue per item (£)" : "Total revenue (£)"}</span>
              <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={revenueValue} onChange={event => setRevenueValue(event.target.value)} placeholder="0.00" required />
              {revenueMode === "average" && <p className={styles.helperNote}>Total revenue = average × {items.length} selected unit{items.length === 1 ? "" : "s"}.</p>}
            </label>}
            {revenueMode === "itemised" && <p className={styles.helperNote}>Enter a sale price each for every product group in the basket — see the basket panel.</p>}

            <label className="field"><span className="label">Platform fees (£, order total)</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={fees} onChange={event => setFees(event.target.value)} placeholder="0.00" /></label>
            <label className="field"><span className="label">Postage (£, order total)</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={postage} onChange={event => setPostage(event.target.value)} placeholder="0.00" /></label>
            <p className={styles.helperNote + " " + styles.detailsGridWide}>Fees and postage are order totals, not per-unit amounts — they're allocated across items automatically.</p>
          </div>
        </div>

        {submitError && <p className={styles.conflictError} role="alert">{submitError}</p>}
      </div>

      <SaleBasketPanel
        items={items}
        onRemoveUnit={removeUnit}
        onRemoveGroup={removeGroup}
        onClear={clearBasket}
        revenueMode={revenueMode}
        unitPrices={unitPrices}
        onUnitPriceChange={(key, value) => setUnitPrices(current => ({ ...current, [key]: value }))}
        unitAllocations={unitAllocations}
      >
        <div className={styles.basketTotals}>
          <div className={styles.basketTotalsRow}><span>Total revenue</span><span>{formatPenceAsGBP(revenuePence)}</span></div>
          <div className={styles.basketTotalsRow}><span>Fees</span><span>{formatPenceAsGBP(feesPence)}</span></div>
          <div className={styles.basketTotalsRow}><span>Postage</span><span>{formatPenceAsGBP(postagePence)}</span></div>
          <div className={`${styles.basketTotalsRow} ${styles.basketTotalsRowLarge}`}><span>Profit</span><span className={profitPence < 0 ? styles.negative : undefined}>{formatPenceAsGBP(profitPence)}</span></div>
          <div className={styles.basketTotalsRow}><span>Margin</span><span>{formatMarginPercent(marginPercent)}</span></div>
          <div className={styles.basketTotalsRow}><span>Average profit per unit</span><span className={averageProfitPerUnitPence !== null && averageProfitPerUnitPence < 0 ? styles.negative : undefined}>{formatPenceAsGBP(averageProfitPerUnitPence)}</span></div>
        </div>
        <button type="button" className={`button ${styles.recordButton}`} disabled={!canSubmit} onClick={recordSale}>
          {submitting ? "Recording…" : `Record ${mode === "quick" ? "Quick" : "Order"} Sale`}
        </button>
      </SaleBasketPanel>
    </div>
  </section>;
}
