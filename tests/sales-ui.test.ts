import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// app/sales/**/*.tsx and components/sales/*.tsx are "use client" components
// with no React test harness in this project — asserted structurally,
// matching the established convention (see tests/purchases-selection-ui.test.ts's
// own comment on this).
const listPage = readFileSync("app/sales/page.tsx", "utf8");
const builderPage = readFileSync("app/sales/new/page.tsx", "utf8");
const detailPage = readFileSync("app/sales/[id]/page.tsx", "utf8");
const searchPanel = readFileSync("components/sales/PurchaseSearchPanel.tsx", "utf8");
const basketPanel = readFileSync("components/sales/SaleBasketPanel.tsx", "utf8");
const cancelDialog = readFileSync("components/sales/CancelSalesDialog.tsx", "utf8");

describe("app/sales/page.tsx — Sales list", () => {
  it("has a clear Sales heading and both a Quick Sale and an Order Sale entry point", () => {
    expect(listPage).toContain("<h1>Sales</h1>");
    expect(listPage).toContain(">Quick Sale<");
    expect(listPage).toContain(">Order Sale<");
    expect(listPage).toContain('router.push("/sales/new?mode=quick")');
    expect(listPage).toContain('router.push("/sales/new?mode=order")');
  });

  it("has loading, error, and empty states, distinct from the 'no matching search' state", () => {
    expect(listPage).toContain("styles.loadingState");
    expect(listPage).toContain("styles.errorState");
    expect(listPage).toContain("No sales recorded yet");
    expect(listPage).toContain("No matching sales");
  });

  it("provides a search input over the loaded sales", () => {
    expect(listPage).toContain('aria-label="Search sales"');
  });

  it("REQUIREMENT: the summary is derived only from completed sales (never counting refunded/cancelled as revenue)", () => {
    const summaryFn = builderPageSlice(listPage, "const summary = useMemo(", "}, [orders]);");
    expect(summaryFn).toContain('order.status === "completed"');
  });

  it("clicking a row opens that sale's detail page, and Enter does too (keyboard-accessible)", () => {
    expect(listPage).toContain("router.push(`/sales/${order.id}`)");
    expect(listPage).toContain('if (event.key === "Enter") router.push(`/sales/${order.id}`)');
  });

  it("does not build a full reporting dashboard here (no chart/export code)", () => {
    expect(listPage.toLowerCase()).not.toContain("chart.js");
    expect(listPage).not.toContain("recharts");
    expect(listPage).not.toContain("xlsx");
  });

  it("REQUIREMENT: table columns are in the required order — a leading selection checkbox, then Date, Item Description, Platform, Units, Revenue, Profit, Status", () => {
    const theadBlock = listPage.slice(listPage.indexOf("<thead><tr>"), listPage.indexOf("</tr></thead>"));
    expect(theadBlock).toContain("styles.checkboxCell");
    expect(theadBlock).toContain("<th>Date</th><th>Item Description</th><th>Platform</th><th>Units</th><th className={styles.numeric}>Revenue</th><th className={styles.numeric}>Profit</th><th>Status</th>");
    // the checkbox column comes before Date, not after
    expect(theadBlock.indexOf("checkboxCell")).toBeLessThan(theadBlock.indexOf("<th>Date</th>"));
  });

  it("REQUIREMENT: item description uses the grouped, snapshot-based summary (stacked lines, or first line + overflow count for many products)", () => {
    expect(listPage).toContain("summariseItemGroups(order.itemGroups)");
    expect(listPage).toContain("descriptionSummary.lines.map(");
    expect(listPage).toContain("descriptionSummary.overflowCount > 0");
    expect(listPage).toContain("more product{descriptionSummary.overflowCount === 1 ? \"\" : \"s\"}");
  });

  it("REQUIREMENT: profit is shown as a coloured pill using the shared exact-pence threshold helper, with an accessible text label — colour is only applied to the pill, never the row", () => {
    expect(listPage).toContain('import { profitBadgeTone } from "@/lib/sales/profit";');
    expect(listPage).toContain("const profitTone = profitBadgeTone(order.profitPence);");
    expect(listPage).toContain("aria-label={`Profit ${formatPenceAsGBP(order.profitPence)}`}");
    expect(listPage).not.toContain("styles.salesRow} ${styles[PROFIT_TONE_CLASS");
  });

  it("REQUIREMENT: search also matches item descriptions, not just platform/status/date", () => {
    expect(listPage).toContain("itemGroupsSearchText(order.itemGroups)");
  });
});

describe("app/sales/page.tsx — bulk selection and cancellation", () => {
  it("REQUIREMENT: reuses the Purchases page's own selection helpers rather than a second inconsistent implementation", () => {
    expect(listPage).toContain('import { pruneMissingIds, resolveRowClick, selectionSummary, toggleId, toggleVisiblePage } from "@/lib/purchases-selection";');
  });

  it("REQUIREMENT: selection is a Set of sale-order UUIDs, independent of row index — mirrors the Purchases page exactly", () => {
    expect(listPage).toContain('const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());');
  });

  it("REQUIREMENT: shift-click ranges and select-all are resolved only against currently visible AND selectable (completed) rows", () => {
    expect(listPage).toContain("const selectableIds = useMemo(() => filtered.filter(isSelectableForCancellation).map(order => order.id), [filtered]);");
    expect(listPage).toContain("toggleVisiblePage(current, selectableIds)");
    expect(listPage).toContain("pageIds: selectableIds");
  });

  it("REGRESSION: a cancelled row is never a valid shift-click range endpoint or select target — checked explicitly before falling through to resolveRowClick", () => {
    const handleRowClickFn = listPage.slice(listPage.indexOf("function handleRowClick("), listPage.indexOf("const selectedOrders = useMemo"));
    expect(handleRowClickFn).toContain("if (!isSelectableForCancellation(order)) {");
    expect(handleRowClickFn).toContain("if (event.shiftKey) return;");
  });

  it("REQUIREMENT: a cancelled row stays clickable to open its detail page (when nothing is selected), and clears selection first when something is selected — same rule as a normal row", () => {
    const handleRowClickFn = listPage.slice(listPage.indexOf("function handleRowClick("), listPage.indexOf("const selectedOrders = useMemo"));
    expect(handleRowClickFn).toContain("if (selectedIds.size > 0) { clearSelection(); return; }");
    expect(handleRowClickFn).toContain("router.push(`/sales/${order.id}`);");
  });

  it("REQUIREMENT: selection is pruned whenever what's visible+selectable changes (status filter, search, or data refresh) — Delete selected can never act on a hidden row", () => {
    expect(listPage).toContain("setSelectedIds(current => pruneMissingIds(current, new Set(selectableIds)));");
    expect(listPage).toContain("}, [selectableIds]);");
  });

  it("REQUIREMENT: only a selectable (completed) row renders a checkbox — a cancelled row's checkbox cell is empty", () => {
    expect(listPage).toContain("{selectable && <input");
  });

  it("checkbox clicks stop propagation so they never also trigger the row's own navigate/select click handler", () => {
    expect(listPage).toContain('<td className={styles.checkboxCell} onClick={event => event.stopPropagation()}>');
  });

  it("REQUIREMENT: header checkbox selects/deselects every currently visible selectable row", () => {
    expect(listPage).toContain("onChange={toggleSelectAllVisible}");
    expect(listPage).toContain("checked={selection.allSelected}");
  });

  it("the header checkbox shows an indeterminate state when some, but not all, visible rows are selected — same imperative-DOM-property pattern as Purchases", () => {
    expect(listPage).toContain("selectAllRef.current.indeterminate = selection.someSelected;");
  });

  it("REQUIREMENT: the bulk-delete button shows the exact selected count and is only rendered (hidden, not just disabled) when something is selected", () => {
    expect(listPage).toContain('{selectedIds.size > 0 && <button type="button" className="button-danger" onClick={() => setCancelDialogOpen(true)}>Delete {selectedIds.size} selected</button>}');
  });

  it("REQUIREMENT: Completed / Cancelled / All filter switch is present and defaults to Completed", () => {
    expect(listPage).toContain('const [statusFilter, setStatusFilter] = useState<SalesStatusFilter>("completed");');
    expect(listPage).toContain("salesStatusFilters.map(option =>");
  });

  it("REQUIREMENT: search operates within the currently selected status filter, not the full unfiltered list", () => {
    const filteredFn = listPage.slice(listPage.indexOf("const filtered = useMemo("), listPage.indexOf("const selectableIds"));
    expect(filteredFn).toContain("statusFilteredOrders.filter(order =>");
    expect(filteredFn).not.toContain("(orders ?? []).filter(order =>");
  });

  it("REQUIREMENT: cancelling calls the atomic cancel endpoint exactly once per action, never separate requests for orders/items/purchases", () => {
    expect(listPage).toContain('fetch("/api/sales/cancel"');
    expect(listPage.match(/fetch\("\/api\/sales\/cancel"/g)?.length).toBe(1);
  });

  it("REQUIREMENT: double-submit is prevented — a second cancellation cannot start while one is already in flight", () => {
    const cancelFn = listPage.slice(listPage.indexOf("async function cancelSelected("), listPage.indexOf("const statusFilterLabel"));
    expect(cancelFn).toContain("if (submittingAction) return;");
  });

  it("REQUIREMENT: on failure, the selection and open dialog are preserved so the user can retry without re-selecting", () => {
    const cancelFn = listPage.slice(listPage.indexOf("async function cancelSelected("), listPage.indexOf("const statusFilterLabel"));
    expect(cancelFn).toContain("setCancelError(body?.error || \"Could not cancel the selected sales.\");");
    expect(cancelFn).not.toMatch(/setCancelError\(body\?\.error[^)]*\);\s*setCancelDialogOpen\(false\)/);
  });

  it("REQUIREMENT: on success, the dialog closes, selection clears, a toast shows the exact server-reported counts, and the list refreshes", () => {
    const cancelFn = listPage.slice(listPage.indexOf("async function cancelSelected("), listPage.indexOf("const statusFilterLabel"));
    expect(cancelFn).toContain("setCancelDialogOpen(false);");
    expect(cancelFn).toContain("clearSelection();");
    expect(cancelFn).toContain("salesCancelledMessage(ordersCancelled, unitsAffected, returnToStock)");
    expect(cancelFn).toContain("load();");
  });

  it("clicking Cancel in the dialog makes no request and preserves the current selection", () => {
    expect(listPage).toContain('onCancel={() => { if (!submittingAction) { setCancelDialogOpen(false); setCancelError(""); } }}');
  });
});

function builderPageSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? undefined : end + endMarker.length);
}

describe("app/sales/new/page.tsx — shared Quick Sale / Order Sale builder", () => {
  it("REQUIREMENT: reads the mode from the ?mode= query param, defaulting to quick", () => {
    expect(builderPage).toContain('searchParams.get("mode") === "order" ? "order" : "quick"');
  });

  it("REQUIREMENT: itemised revenue mode is only offered in Order Sale mode — Quick Sale isn't burdened by it", () => {
    expect(builderPage).toContain('{mode === "order" && <button type="button" className={revenueMode === "itemised"');
  });

  it("REQUIREMENT: the same purchase UUID can never be added to the basket twice", () => {
    const addUnitFn = builderPageSlice(builderPage, "function addUnit(purchase: Purchase) {", "}\n  }\n");
    expect(builderPage).toContain("if (current.has(purchase.id)) return current;");
    expect(builderPage).toContain("if (!next.has(purchase.id)) next.set(purchase.id, purchase);");
    void addUnitFn;
  });

  it("REQUIREMENT: basket state is keyed by exact purchase UUID (a Map<string, Purchase>), never by row index or displayed SKU", () => {
    expect(builderPage).toContain("const [basket, setBasket] = useState<Map<string, Purchase>>(new Map());");
  });

  it("REQUIREMENT: Clear basket only clears local state — no fetch/API call is made by it", () => {
    const clearFn = builderPageSlice(builderPage, "function clearBasket() {", "}\n\n  function changePlatform");
    expect(clearFn).not.toContain("fetch(");
    expect(clearFn).toContain("setBasket(new Map());");
  });

  it("REQUIREMENT: switching platform away from Other clears the custom platform name", () => {
    expect(builderPage).toContain('if (next !== "other") setCustomPlatformName("");');
  });

  it("REQUIREMENT: the custom platform field is required and only rendered when platform is Other", () => {
    expect(builderPage).toContain('{platform === "other" && <label className="field detailsGridWide">');
    expect(builderPage).toContain("<span className=\"label\">Where did you sell it?</span>");
  });

  it("REQUIREMENT: average mode explains total = average × selected units", () => {
    expect(builderPage).toContain('Total revenue = average × {items.length} selected unit');
  });

  it("clarifies fees/postage are order totals, not per-unit amounts", () => {
    expect(builderPage).toContain("Fees and postage are order totals, not per-unit amounts");
  });

  it("REQUIREMENT: no order-reference field is rendered or submitted anywhere in the builder", () => {
    expect(builderPage.toLowerCase()).not.toContain("orderreference");
    expect(builderPage.toLowerCase()).not.toContain("order_reference");
    expect(builderPage.toLowerCase()).not.toContain("order reference");
  });

  it("REQUIREMENT: profit = revenue - stock cost - fees - postage, computed in integer pence via the shared pure helpers", () => {
    expect(builderPage).toContain("const profitPence = revenuePence - stockCostPence - feesPence - postagePence;");
    expect(builderPage).toContain("calculateMarginPercent(profitPence, revenuePence)");
  });

  it("REQUIREMENT: itemised revenue is entirely derived from the basket's own per-group prices — no separate order-total field that could disagree with it", () => {
    expect(builderPage).toContain("buildItemisedLineRevenuesPence(groups, unitPricesPence)");
    expect(builderPage).not.toContain('revenueMode === "itemised" && <label className="field detailsGridWide">\n              <span className="label">Total revenue');
  });

  it("REQUIREMENT: disables repeat submission — the Record button is disabled while a request is in flight", () => {
    expect(builderPage).toContain("disabled={!canSubmit}");
    expect(builderPage).toContain("!submitting");
    expect(builderPage).toContain('if (!canSubmit || submitting) return;');
  });

  it("REQUIREMENT: only ONE POST to /api/sales — never a sequence of separate requests", () => {
    expect(builderPage.match(/fetch\("\/api\/sales"/g)?.length).toBe(1);
  });

  it("REQUIREMENT: on failure, the basket and entered fields are preserved (no reset happens before the success branch)", () => {
    const submitFn = builderPageSlice(builderPage, "async function recordSale() {", "  if (successResult) {");
    expect(submitFn).toContain("setSubmitError(responseBody?.error || \"Could not record the sale.\");\n        return;");
    // the basket/field resets only happen AFTER this early return, i.e. only on success.
    const returnIdx = submitFn.indexOf("setSubmitError(responseBody?.error");
    const resetIdx = submitFn.indexOf("setBasket(new Map());");
    expect(resetIdx).toBeGreaterThan(returnIdx);
  });

  it("REQUIREMENT: on success, the basket is cleared and a link to the newly created sale is offered", () => {
    expect(builderPage).toContain("setSuccessResult(responseBody as CreateSaleResult);");
    expect(builderPage).toContain("setBasket(new Map());");
    expect(builderPage).toContain("router.push(`/sales/${successResult.order.id}`)");
  });

  it("REQUIREMENT: does not accept purchase cost/description/category/SKU/supplier as client-authoritative — only purchaseIds, sale facts, and revenue/fee/postage inputs are sent", () => {
    const bodyBlock = builderPageSlice(builderPage, "const body = {", "};");
    for (const forbidden of ["cost", "description:", "category:", "sku:", "supplier"]) {
      expect(bodyBlock.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("REQUIREMENT: computes exact per-unit allocations via computeBasketAllocation (mirroring the RPC), keyed by purchase UUID, and passes them to the basket panel", () => {
    expect(builderPage).toContain('import { computeBasketAllocation, normalizeRevenueInputPence, type UnitAllocation } from "@/lib/sales/allocation";');
    expect(builderPage).toContain("computeBasketAllocation(units, revenueMode, revenuePence, feesPence, postagePence, itemisedRevenueByPurchaseId)");
    expect(builderPage).toContain("unitAllocations={unitAllocations}");
  });

  it("REQUIREMENT: shows Average profit per unit in the financial summary, computed from total profit over the unit count (not a per-unit reallocation)", () => {
    expect(builderPage).toContain("const averageProfitPerUnitPence = items.length > 0 ? profitPence / items.length : null;");
    expect(builderPage).toContain("<span>Average profit per unit</span>");
    expect(builderPage).toContain("{formatPenceAsGBP(averageProfitPerUnitPence)}");
  });
});

describe("components/sales/PurchaseSearchPanel.tsx — shared product search", () => {
  it("searches only the dedicated available-purchases endpoint (server-scoped to sellable units), never the whole purchases list", () => {
    expect(searchPanel).toContain('fetch(`/api/sales/available-purchases?q=');
  });

  it("REQUIREMENT: debounces the search request", () => {
    expect(searchPanel).toContain("window.setTimeout(");
    expect(searchPanel).toContain("250)");
  });

  it("REQUIREMENT: never shows the hidden purchase UUID in the results UI", () => {
    const resultRowBlock = searchPanel.slice(searchPanel.indexOf("<div className={styles.resultInfo}>"), searchPanel.indexOf("</div>\n          <span className={styles.resultCost}>"));
    expect(resultRowBlock).not.toContain("purchase.id");
  });

  it("REQUIREMENT: an already-added purchase can't be added again — its row/button is disabled", () => {
    expect(searchPanel).toContain("const alreadyAdded = selectedIds.has(purchase.id);");
    expect(searchPanel).toContain("disabled={alreadyAdded}");
    expect(searchPanel).toContain("onClick={() => { if (!alreadyAdded) onAdd(purchase); }}");
  });

  it("REQUIREMENT: clicking the Add button does not also trigger the row's own click handler (no double-add)", () => {
    expect(searchPanel).toContain("event.stopPropagation();");
  });

  it("REQUIREMENT: keyboard support — Escape clears the query, Up/Down move the highlight, Enter adds the highlighted result", () => {
    expect(searchPanel).toContain('if (event.key === "Escape")');
    expect(searchPanel).toContain('if (event.key === "ArrowDown")');
    expect(searchPanel).toContain('if (event.key === "ArrowUp")');
    expect(searchPanel).toContain('if (event.key === "Enter")');
  });

  it("auto-focuses the search field when the panel opens", () => {
    expect(searchPanel).toContain("if (autoFocus) inputRef.current?.focus();");
  });

  it("shows enough per-result detail to distinguish identical products from different suppliers (description, SKU, supplier, date, condition, category, cost)", () => {
    for (const field of ["purchase.item_description", "purchase.sku", "purchase.purchased_from", "purchase.order_date", "purchase.item_condition", "purchase.category", "purchase.price_purchased"]) {
      expect(searchPanel).toContain(field);
    }
  });

  it("offers an 'Add all available' action for the current search's still-addable results", () => {
    expect(searchPanel).toContain(">Add all available<");
    expect(searchPanel).toContain("onClick={() => onAddAll(addableResults)}");
  });

  it("has an accessible label on the search input", () => {
    expect(searchPanel).toContain('aria-label="Search available purchases"');
  });
});

describe("components/sales/SaleBasketPanel.tsx — shared basket display", () => {
  it("REQUIREMENT: groups visually-identical units but removal always operates on exact purchase UUIDs", () => {
    expect(basketPanel).toContain("groupBasketItems(items)");
    expect(basketPanel).toContain("onClick={() => onRemoveUnit(item.id)}");
    expect(basketPanel).toContain("onClick={() => onRemoveGroup(group.key)}");
  });

  it("shows total units and total stock cost", () => {
    expect(basketPanel).toContain("<span>Total units</span><span>{items.length}</span>");
    expect(basketPanel).toContain("totalStockCostPence(items)");
  });

  it("REQUIREMENT: itemised mode's per-group unit-price input is only rendered when revenueMode is itemised", () => {
    expect(basketPanel).toContain('{revenueMode === "itemised" && <div className={styles.unitPriceRow}>');
  });

  it("has a sensible empty-basket state", () => {
    expect(basketPanel).toContain("No units selected yet");
  });

  it("group and unit removal controls have identifying accessible labels", () => {
    expect(basketPanel).toContain("aria-label={`Remove all ${group.description} from basket`}");
    expect(basketPanel).toContain("aria-label={`Remove this ${item.item_description} unit");
  });

  it("REQUIREMENT: receives exact per-unit revenue/fee/postage/profit allocations from the parent, keyed by purchase UUID, rather than re-deriving money math itself", () => {
    expect(basketPanel).toContain("unitAllocations: Map<string, UnitAllocation>;");
    expect(basketPanel).toContain('import type { UnitAllocation } from "@/lib/sales/allocation";');
  });

  it("REQUIREMENT: a collapsed/every group shows its average profit per unit, never the total profit divided naively without going through the allocation", () => {
    expect(basketPanel).toContain("const groupAllocations = group.items.map(item => unitAllocations.get(item.id))");
    expect(basketPanel).toContain("groupAllocations.reduce((sum, a) => sum + a.profitPence, 0) / groupAllocations.length");
    expect(basketPanel).toContain("Profit/unit {formatPenceAsGBP(averageUnitProfitPence)}");
  });

  it("REQUIREMENT: an expanded group shows each exact unit's cost, allocated revenue, allocated fees/postage (when non-zero), and exact profit", () => {
    expect(basketPanel).toContain("Cost {formatPenceAsGBP(allocation.costPence)} · Revenue {formatPenceAsGBP(allocation.revenuePence)}");
    expect(basketPanel).toContain("(allocation.feePence > 0 || allocation.postagePence > 0)");
    expect(basketPanel).toContain("{allocation ? formatPenceAsGBP(allocation.profitPence) : \"—\"}");
  });

  it("REQUIREMENT: never renders the raw purchase UUID as visible text in the unit detail view — item.id is only ever used as a React key or an internal lookup/handler argument, never displayed", () => {
    const unitDetailBlock = basketPanel.slice(basketPanel.indexOf("{isExpanded && <div className={styles.basketUnitList}>"), basketPanel.indexOf("</div>}\n          </div>;"));
    // A visible JSX text child would look like `>{item.id}<` or `>{allocation.purchaseId}<` — never present.
    expect(unitDetailBlock).not.toMatch(/>\s*\{item\.id\}\s*</);
    expect(unitDetailBlock).not.toMatch(/>\s*\{allocation\.purchaseId\}\s*</);
    // Confirms the block does legitimately reference item.id — just never as displayed text (key prop, map lookup, click handler).
    expect(unitDetailBlock).toContain("key={item.id}");
  });
});

describe("components/sales/CancelSalesDialog.tsx — bulk-cancellation confirmation", () => {
  it("REQUIREMENT: presents all three required actions as distinct, explicit controls, not a checkbox behind one generic confirm", () => {
    expect(cancelDialog).toContain("Yes, return items to stock");
    expect(cancelDialog).toContain("No, keep items out of stock");
    expect(cancelDialog).toContain('<button type="button" className={styles.cancelDialogDismiss} onClick={onCancel}');
  });

  it("REQUIREMENT: 'Yes, return items to stock' confirms with returnToStock true; 'No, keep items out of stock' confirms with false", () => {
    expect(cancelDialog).toContain("onClick={() => onConfirm(true)}");
    expect(cancelDialog).toContain("onClick={() => onConfirm(false)}");
  });

  it("REQUIREMENT: shows how many sales are selected and how many exact physical units they cover", () => {
    expect(cancelDialog).toContain("orders.reduce((sum, order) => sum + order.itemCount, 0)");
    expect(cancelDialog).toContain("<span>Sales</span><strong>{orders.length}</strong>");
    expect(cancelDialog).toContain("<span>Units</span><strong>{unitCount}</strong>");
  });

  it("REQUIREMENT: shows the combined revenue and profit being removed from active reporting", () => {
    expect(cancelDialog).toContain("Revenue removed from reporting");
    expect(cancelDialog).toContain("Profit removed from reporting");
  });

  it("REQUIREMENT: explicitly states the sales are retained for audit history, not deleted", () => {
    expect(cancelDialog).toContain("stays on file for audit history");
    expect(cancelDialog).toContain("Nothing is permanently deleted");
  });

  it("REQUIREMENT: asks the required stock question verbatim", () => {
    expect(cancelDialog).toContain("Are these items back in stock?");
  });

  it("REQUIREMENT: both action buttons and the close controls are disabled while a submission is in flight — prevents double submission", () => {
    expect(cancelDialog).toContain("const submitting = submittingAction !== null;");
    expect(cancelDialog.match(/disabled={submitting}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("shows a processing label on whichever action is currently submitting", () => {
    expect(cancelDialog).toContain('submittingAction === "return" ? "Returning to stock…"');
    expect(cancelDialog).toContain('submittingAction === "keep" ? "Cancelling…"');
  });

  it("REQUIREMENT: Escape and backdrop click are disabled while submitting, so the dialog can't be dismissed mid-request", () => {
    expect(cancelDialog).toContain("event.key === \"Escape\" && !submitting");
    expect(cancelDialog).toContain("event.target === event.currentTarget && !submitting");
  });

  it("displays a passed-in error without closing the dialog", () => {
    expect(cancelDialog).toContain('{error && <p className="import-select-error" role="alert">{error}</p>}');
  });
});

describe("app/sales/[id]/page.tsx — sale detail (read-only)", () => {
  it("requires owner authentication and scopes the order lookup by owner_id", () => {
    expect(detailPage).toContain("await requireOwner();");
    expect(detailPage).toContain("sales_orders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}");
  });

  it("REQUIREMENT: 404s when the sale doesn't exist (or belongs to another owner)", () => {
    expect(detailPage).toContain("if (!order) notFound();");
  });

  it("shows every required order-level and per-item fact, and no order-reference field", () => {
    for (const fact of ["Platform", "Units", "Revenue", "Stock cost", "Fees", "Postage", "Profit", "Margin"]) {
      expect(detailPage).toContain(`<span>${fact}</span>`);
    }
    expect(detailPage.toLowerCase()).not.toContain("order reference");
    expect(detailPage.toLowerCase()).not.toContain("orderreference");
  });

  it("REQUIREMENT: uses the immutable snapshot fields, never re-joining back to the live purchase for historical values", () => {
    for (const snapshot of ["item_description_snapshot", "sku_snapshot", "category_snapshot", "item_condition_snapshot", "purchase_cost_snapshot"]) {
      expect(detailPage).toContain(snapshot);
    }
  });

  it("REQUIREMENT: does not implement a destructive delete action, and explicitly explains refunding (unlike cancelling) is still a later stage", () => {
    expect(detailPage).not.toContain('method: "DELETE"');
    expect(detailPage).toContain("Refunding a sale");
    expect(detailPage).toContain("is planned for a later stage");
  });

  it("REQUIREMENT: uses each sale_item's own stable id as the React list key, never purchase_id (which can now be null after the original purchase is deleted)", () => {
    expect(detailPage).toContain("<tr key={item.id}>");
    expect(detailPage).not.toContain("<tr key={item.purchase_id}>");
  });

  it("REQUIREMENT: shows a clear 'Original purchase deleted' audit label for a line item whose purchase_id is null, and never displays a raw 'undefined'", () => {
    expect(detailPage).toContain("item.purchase_id === null && <span className={styles.deletedPurchaseNote}> · Original purchase deleted</span>");
  });

  it("does not offer any 'return this item to stock' action tied to an individual line item — stock decisions are made once, at the order level, during cancellation", () => {
    expect(detailPage.toLowerCase()).not.toContain("return this item to stock");
    expect(detailPage).not.toContain("returnToStock");
  });

  it("REQUIREMENT: shows a clear cancellation note stating whether units were returned to stock or kept out, sourced from the durable audit field — never re-derived from the linked purchases' current stock_status", () => {
    expect(detailPage).toContain('order.status === "cancelled" && order.cancellation_stock_action');
    expect(detailPage).toContain('order.cancellation_stock_action === "returned_to_stock"');
    expect(detailPage).toContain("returned to stock");
    expect(detailPage).toContain("kept out of stock");
  });

  it("the cancellation note is only shown for a cancelled sale, never a completed one", () => {
    expect(detailPage).toContain("{cancellationNote && <p className={styles.cancellationNote}>");
  });
});
