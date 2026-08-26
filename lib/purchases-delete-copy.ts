/**
 * Pure copy-building for the purchase-deletion confirmation dialogs (single
 * delete, bulk delete, Clear All — all three share this exact wording, never
 * three slightly different messages). Deliberately NOT server-only (unlike
 * lib/purchases-delete.ts) — imported directly by app/purchases/page.tsx.
 */

export type DeletionEligibility = { deletableCount: number; protectedCount: number };

/** The dialog's headline. Matches the three required examples verbatim. */
export function deletionDialogTitle(eligibility: DeletionEligibility): string {
  const { deletableCount, protectedCount } = eligibility;
  if (protectedCount === 0) return deletableCount === 1 ? "Delete 1 purchase?" : `Delete ${deletableCount} purchases?`;
  if (deletableCount === 0) return "These purchases cannot be deleted because they belong to completed sales. Cancel the related sales first.";
  return `${deletableCount} ${deletableCount === 1 ? "purchase" : "purchases"} can be deleted. ${protectedCount} ${protectedCount === 1 ? "purchase belongs" : "purchases belong"} to a completed sale and ${protectedCount === 1 ? "is" : "are"} protected.`;
}

/** The dialog's supporting explanatory line. */
export function deletionDialogMessage(eligibility: DeletionEligibility): string {
  const { deletableCount, protectedCount } = eligibility;
  if (protectedCount === 0) return "The selected purchase records will be permanently removed. This cannot be undone.";
  if (deletableCount === 0) return "Cancel the related sales first, then try deleting these purchases again.";
  return "Only the purchases without a completed sale will be removed. Protected purchases are kept exactly as they are. This cannot be undone.";
}

/** The confirm button's label — "Delete N available purchases" whenever some are protected, so it's always explicit about the smaller number actually being confirmed. */
export function deletionConfirmLabel(eligibility: DeletionEligibility): string {
  const { deletableCount, protectedCount } = eligibility;
  if (protectedCount === 0) return deletableCount === 1 ? "Delete 1 purchase" : `Delete ${deletableCount} purchases`;
  return deletableCount === 1 ? "Delete 1 available purchase" : `Delete ${deletableCount} available purchases`;
}
