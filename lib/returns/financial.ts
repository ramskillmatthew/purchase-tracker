import { poundsToPence } from "@/lib/sales/money";

/**
 * Returns, Losses & Write-offs — the ONE place the financial formulas live.
 * Every amount is an integer number of PENCE. The only conversion from
 * pounds happens at the edges via poundsToPence (lib/sales/money.ts), the
 * same boundary the sales domain uses. No floating-point money maths.
 *
 * ---------------------------------------------------------------------------
 * MODEL — everything is expressed relative to "the world just after the
 * original sale posted", so a return/loss recognised in a LATER month
 * (the August-sale / September-return rule) only ever produces a negative
 * adjustment in that later month; the original month's history is untouched.
 *
 * For one sale of `saleQty` units with stored sale figures (all pence):
 *   saleRevenuePence  = allocated revenue for those units
 *   saleFeesPence     = allocated marketplace fees + postage for those units
 *   saleCostPence     = original purchase (stock) cost of those units
 *   saleProfitPence   = saleRevenuePence - saleCostPence - saleFeesPence
 *                       (this is the sale's own stored `profit`, COGS-inclusive)
 *
 * A return of `returnedQty` of those units, with:
 *   refundMode        = "full" | "partial"
 *   partialRefundPence (only when refundMode = "partial")
 *   returnPostagePence, unrecoveredCostsPence   (>= 0)
 *   outcome           = "returned_safely" | "buyer_refunded_no_return"
 *
 * Let f = returnedQty / saleQty  (0 < f <= 1). Proportional shares are
 * rounded once, at the point of use, never compounded.
 *
 *   REVENUE REVERSED   Rr = round(saleRevenuePence * f)         [full]
 *                         = partialRefundPence                  [partial]
 *
 *   PROFIT REVERSED    Pr = round(saleProfitPence * f)          [full]
 *                         = partialRefundPence - round(saleFeesPence * f)
 *                                                               [partial, clamped to [0, partialRefundPence]]
 *     Pr is COGS-INCLUSIVE by construction (it is a slice of saleProfitPence
 *     = rev - cost - fees). It is therefore NEVER combined with a separate
 *     cost-of-goods subtraction for a returned_safely outcome.
 *
 *   EXTRA COSTS        Ec = returnPostagePence + unrecoveredCostsPence
 *
 *   INVENTORY WRITE-OFF Wo = round(saleCostPence * f)   when outcome =
 *     "buyer_refunded_no_return" (the unit is gone for good and will NOT be
 *     restored); otherwise Wo = 0.
 *
 *   STOCK VALUE RESTORED Sr = round(saleCostPence * f)  when outcome =
 *     "returned_safely"; otherwise 0. Sr is a BALANCE-SHEET move
 *     (purchases stock value goes back up) — it is NOT a P&L line and is
 *     never added to the net-profit impact.
 *
 *   NET P&L IMPACT (recognition month) = -(Pr) - Ec - Wo
 *
 * Why this never double-counts cost of goods:
 *   returned_safely:  impact = -Pr - Ec.  Combined with the original month's
 *     +Pr, the two months net to -Ec (you are out only the return shipping /
 *     unrecovered fees) and you own the item again at cost (via Sr). Correct.
 *   buyer_refunded_no_return:  -Pr expands to (-rev + cost + fees)*f; adding
 *     -Wo = -cost*f cancels the +cost*f term, leaving (-rev + fees)*f. With
 *     the original +Pr, the two months net to exactly -cost*f - Ec: you have
 *     lost the cost of the goods you gave away plus the return costs, and
 *     the cost of goods appears exactly ONCE. Correct.
 * ---------------------------------------------------------------------------
 */

export type ReturnOutcome = "returned_safely" | "buyer_refunded_no_return";

export type ReturnReversalInput = {
  saleRevenuePence: number;
  saleFeesPence: number;
  saleCostPence: number;
  saleProfitPence: number;
  saleQty: number;
  returnedQty: number;
  refundMode: "full" | "partial";
  partialRefundPence?: number;
  returnPostagePence?: number;
  unrecoveredCostsPence?: number;
  outcome: ReturnOutcome;
};

export type ReturnReversal = {
  revenueReversedPence: number;
  profitReversedPence: number;
  extraCostsPence: number;
  inventoryWriteOffPence: number;
  stockValueRestoredPence: number;
  /** Negative (or zero) — the amount the recognition month's net profit moves by. */
  netProfitImpactPence: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeReturnReversal(input: ReturnReversalInput): ReturnReversal {
  const {
    saleRevenuePence, saleFeesPence, saleCostPence, saleProfitPence,
    saleQty, returnedQty, refundMode, outcome,
  } = input;
  if (saleQty <= 0) throw new Error("saleQty must be positive");
  if (returnedQty <= 0 || returnedQty > saleQty) throw new Error("returnedQty must be within 1..saleQty");

  const partialRefundPence = Math.max(0, Math.round(input.partialRefundPence ?? 0));
  const returnPostagePence = Math.max(0, Math.round(input.returnPostagePence ?? 0));
  const unrecoveredCostsPence = Math.max(0, Math.round(input.unrecoveredCostsPence ?? 0));
  const f = returnedQty / saleQty;

  const revenueReversedPence = refundMode === "partial"
    ? partialRefundPence
    : Math.round(saleRevenuePence * f);

  const profitReversedPence = refundMode === "partial"
    ? clamp(partialRefundPence - Math.round(saleFeesPence * f), 0, partialRefundPence)
    : Math.round(saleProfitPence * f);

  const extraCostsPence = returnPostagePence + unrecoveredCostsPence;
  const perUnitCostShare = Math.round(saleCostPence * f);
  const inventoryWriteOffPence = outcome === "buyer_refunded_no_return" ? perUnitCostShare : 0;
  const stockValueRestoredPence = outcome === "returned_safely" ? perUnitCostShare : 0;

  const netProfitImpactPence = -(profitReversedPence) - extraCostsPence - inventoryWriteOffPence;

  return {
    revenueReversedPence,
    profitReversedPence,
    extraCostsPence,
    inventoryWriteOffPence,
    stockValueRestoredPence,
    netProfitImpactPence,
  };
}

/**
 * Loss / write-off financial impact. Every amount pence.
 *
 *   lost_inventory / unsellable_purchase:
 *     stockValueRemovedPence = unitCostPence * quantity
 *     netProfitImpactPence   = -(stockValueRemovedPence)         (+ -otherCosts)
 *     — the units leave current stock value AND the month's net profit drops
 *       by their original purchase cost, exactly once.
 *
 *   refund_without_return (a sale existed; item NOT coming back):
 *     customerRefundPence  — money paid back to the buyer
 *     stockCostWriteOffPence = unitCostPence * quantity  (the inventory cost
 *       you can never recover)
 *     otherCostsPence      — unrecovered fees / other directly-related costs
 *     netProfitImpactPence = -(customerRefundPence + stockCostWriteOffPence + otherCostsPence)
 *     but the ORIGINAL sale profit is reversed via the linked return record,
 *     NOT here — a refund_without_return loss is only ever recorded through
 *     the return-completion path (outcome = buyer_refunded_no_return), whose
 *     computeReturnReversal already produced -Pr - Ec - Wo. This function's
 *     refund_without_return branch is for the stand-alone "Record loss" entry
 *     point and returns the components SEPARATELY so the UI can show refund /
 *     stock cost / fees on their own lines and the caller can decide what is
 *     already reversed elsewhere (see net-profit.ts).
 *
 *   other_write_off:
 *     stockValueRemovedPence = unitCostPence * quantity when stockRemoved,
 *       else 0; netProfitImpactPence = -(that + otherCosts).
 */
export type LossType = "lost_inventory" | "unsellable_purchase" | "refund_without_return" | "other_write_off";

export type LossImpactInput = {
  lossType: LossType;
  quantity: number;
  unitCostPence: number;
  customerRefundPence?: number;
  otherCostsPence?: number;
  stockRemoved: boolean;
};

export type LossImpact = {
  stockValueRemovedPence: number;
  customerRefundPence: number;
  stockCostWriteOffPence: number;
  otherCostsPence: number;
  netProfitImpactPence: number;
};

export function computeLossImpact(input: LossImpactInput): LossImpact {
  const quantity = Math.trunc(input.quantity);
  if (quantity <= 0) throw new Error("quantity must be a positive integer");
  const unitCostPence = Math.max(0, Math.round(input.unitCostPence));
  const customerRefundPence = Math.max(0, Math.round(input.customerRefundPence ?? 0));
  const otherCostsPence = Math.max(0, Math.round(input.otherCostsPence ?? 0));
  const grossCostPence = unitCostPence * quantity;

  if (input.lossType === "refund_without_return") {
    const stockCostWriteOffPence = input.stockRemoved ? grossCostPence : 0;
    return {
      stockValueRemovedPence: stockCostWriteOffPence,
      customerRefundPence,
      stockCostWriteOffPence,
      otherCostsPence,
      netProfitImpactPence: -(customerRefundPence + stockCostWriteOffPence + otherCostsPence),
    };
  }

  const stockValueRemovedPence = input.stockRemoved ? grossCostPence : 0;
  return {
    stockValueRemovedPence,
    customerRefundPence: 0,
    stockCostWriteOffPence: stockValueRemovedPence,
    otherCostsPence,
    netProfitImpactPence: -(stockValueRemovedPence + otherCostsPence),
  };
}

/**
 * The ONE definition of a return's net-profit impact from `return_started`
 * onward — active (in-progress) AND completed use it, so the row, the KPI
 * strip, and the Home dashboard can never disagree.
 *
 *   net-profit impact = -(profitReversed)         // reversal of the unit's
 *                                                 // historical sale profit
 *                       - returnPostage
 *                       - unrecoveredCosts
 *                       - otherCosts
 *                       - inventoryWriteOff       // only for
 *                                                 // buyer_refunded_no_return
 *
 * `profitReversedPence` is the SIGNED historical profit attributed to the
 * returned units (positive for a profitable sale — reversing it is negative;
 * negative for a loss-making sale — reversing it is a positive contribution).
 * Restored stock value is deliberately absent: it is a balance-sheet move,
 * never a profit credit.
 *
 * While a return is merely active, profitReversed = the units' full original
 * sale profit and postage/other costs are whatever has been entered so far
 * (usually 0). On completion the same formula is re-evaluated with the final
 * refund mode / costs (see computeReturnReversal, which returns the identical
 * netProfitImpactPence for a full refund).
 */
export function returnNetProfitImpactPence(input: {
  profitReversedPence: number;
  returnPostagePence?: number;
  unrecoveredCostsPence?: number;
  otherCostsPence?: number;
  inventoryWriteOffPence?: number;
}): number {
  const postage = Math.max(0, Math.round(input.returnPostagePence ?? 0));
  const unrecovered = Math.max(0, Math.round(input.unrecoveredCostsPence ?? 0));
  const other = Math.max(0, Math.round(input.otherCostsPence ?? 0));
  const writeOff = Math.max(0, Math.round(input.inventoryWriteOffPence ?? 0));
  return -(Math.round(input.profitReversedPence)) - postage - unrecovered - other - writeOff;
}

/** Convenience: pounds -> pence at the API boundary. */
export const toPence = poundsToPence;
