"use client";

import AllocationDonut, { type AllocationSlice } from "./AllocationDonut";
import type { AllocationResponse } from "@/lib/investments/view-model-types";

const CATEGORY_LABELS: Record<string, string> = { stock: "Stocks", pokemon: "Pokémon", lego: "LEGO", cash: "Cash" };
const CATEGORY_COLORS: Record<string, string> = { stock: "var(--inv-green)", pokemon: "var(--inv-purple)", lego: "var(--inv-amber)", cash: "var(--inv-blue)" };
const CATEGORY_ORDER = ["stock", "pokemon", "lego", "cash"];

export default function AllocationCard({ allocation }: { allocation: AllocationResponse[] }) {
  const slices: AllocationSlice[] = [...allocation]
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
    .map(a => ({ category: a.category, label: CATEGORY_LABELS[a.category] ?? a.category, gbpValue: a.gbpValue, percent: a.percent, color: CATEGORY_COLORS[a.category] ?? "var(--inv-muted)" }));

  return <section className="inv-card inv-allocation" aria-label="Portfolio allocation">
    <div className="inv-card-header">
      <h2 className="inv-card-title">Portfolio allocation</h2>
      <button type="button" className="inv-info-btn" aria-label="How allocation is calculated" title="Allocation is each category's current GBP market value divided by total portfolio value, excluding archived investments. Percentages may not sum to exactly 100% due to rounding.">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7v4M8 5.2v.1" /></svg>
      </button>
    </div>
    <AllocationDonut slices={slices} />
  </section>;
}
