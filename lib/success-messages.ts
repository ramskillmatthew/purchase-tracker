// Small, understated success-copy helpers for the app's toasts and empty
// states. Kept deliberately tiny — plain functions returning strings (or a
// title/body pair for empty states), not a generic i18n framework. Server
// responses stay neutral; this wording only ever appears in the client
// presentation layer, after a server call has already confirmed success.

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function taskCompletedMessage(): string {
  return "Lovely jubbly — task completed";
}

export function taskRestoredMessage(): string {
  return "Task restored";
}

// Shown in place of the neutral "You're all caught up." empty state only
// when a completion just emptied the actionable-today bucket in this
// session — never when the day simply started with nothing due.
export function allTasksCompletedMessage(): { title: string; body: string } {
  return { title: "He who dares — all tasks completed.", body: "No outstanding tasks today." };
}

// Manual single-purchase create (Add Purchase form) — no count, since it's
// always exactly one record.
export function purchaseAddedMessage(): string {
  return "Cushty — purchase added";
}

// Email Assistant / Purchase Import review-flow accepted candidates — count
// must be the number of records actually saved, never shortlisted/displayed/
// rejected/fallback candidates.
export function purchasesAddedMessage(count: number): string {
  return `Cushty — ${count} ${pluralize(count, "purchase", "purchases")} added`;
}

export function purchasesImportedMessage(count: number): string {
  return `Lovely jubbly — ${count} ${pluralize(count, "purchase", "purchases")} imported`;
}

export function expenseAddedMessage(): string {
  return "Sorted — expense added";
}

export function expensesImportedMessage(count: number): string {
  return `Sorted — ${count} ${pluralize(count, "expense", "expenses")} imported`;
}

// Purchases page row-level stock-status toggle — confirmation only, shown
// after the PATCH has already succeeded, never before. Deliberately
// matches the exact requested wording ("X is now in stock" / "X is now no
// longer in stock"), not this file's usual "Cushty —"/"Sorted —" prefix
// style, and handles a purchase with no item description gracefully
// rather than showing a blank/broken sentence.
export function stockStatusChangedMessage(itemDescription: string | null | undefined, stockStatus: "in_stock" | "no_longer_in_stock"): string {
  const label = (itemDescription ?? "").trim() || "This item";
  return `${label} is now ${stockStatus === "in_stock" ? "in stock" : "no longer in stock"}`;
}

// Sales bulk-cancellation success toast — deliberately literal/factual
// wording (not this file's usual "Cushty —"/"Sorted —" prefix style),
// matching the exact phrasing requested for this feature. `orderCount` is
// how many sales orders were cancelled; `unitCount` is the RPC's own
// units_affected count (see supabase-sales-v3.sql), never re-derived
// client-side, so the number shown always matches what the database
// actually changed.
export function salesCancelledMessage(orderCount: number, unitCount: number, returnedToStock: boolean): string {
  const sales = `${orderCount} ${pluralize(orderCount, "sale", "sales")} cancelled`;
  const items = `${unitCount} ${pluralize(unitCount, "item", "items")}`;
  const remains = pluralize(unitCount, "remains", "remain");
  return returnedToStock ? `${sales} and ${items} returned to stock.` : `${sales}. ${items} ${remains} out of stock.`;
}

// Purchase deletion (single, bulk, Clear All) success toast — deliberately
// literal/factual wording, matching salesCancelledMessage's own precedent
// for a safety-relevant result rather than this file's usual catchphrase
// style. `deletedCount` and `protectedCount` must both come from the
// server's own safe_delete_purchases result, never re-derived client-side.
export function purchasesDeletedMessage(deletedCount: number, protectedCount: number): string {
  const deleted = `${deletedCount} ${pluralize(deletedCount, "purchase", "purchases")} deleted.`;
  if (protectedCount === 0) return deleted;
  return `${deleted} ${protectedCount} ${pluralize(protectedCount, "purchase was", "purchases were")} protected by completed sales.`;
}
