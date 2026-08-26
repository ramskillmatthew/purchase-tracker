import { generationTargets, marketplaceLabels, type GenerationTarget } from "@/lib/listing-studio/marketplace-types";

// Exactly mirrors app/listing-studio/page.tsx's own "Create / Saved drafts"
// .period-switch pill toggle (role="group", plain <button>s, one
// "period-active" class swapping colour to var(--primary) on
// var(--primary-soft)) — see app/globals.css's .period-switch rules. Uses
// its own class name (.marketplace-switch) rather than reusing
// .period-switch directly because that class's own mobile media query
// hardcodes a 2-column grid, which would misrender this 3-option control.
const TARGET_LABELS: Record<GenerationTarget, string> = {
  EBAY_UK: marketplaceLabels.EBAY_UK,
  VINTED: marketplaceLabels.VINTED,
  BOTH: "Both",
};

export function MarketplaceSelector({ value, onChange, disabled }: { value: GenerationTarget; onChange: (target: GenerationTarget) => void; disabled?: boolean }) {
  return (
    <div className="marketplace-target-row">
      <span className="marketplace-target-label">Create listings for</span>
      <div className="marketplace-switch period-switch" role="group" aria-label="Create listings for">
        {generationTargets.map(target => (
          <button
            key={target}
            type="button"
            className={value === target ? "period-active" : ""}
            aria-pressed={value === target}
            disabled={disabled}
            onClick={() => onChange(target)}
          >
            {TARGET_LABELS[target]}
          </button>
        ))}
      </div>
    </div>
  );
}
