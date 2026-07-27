"use client";
import { useCallback, useEffect, useState } from "react";
import ExpenseForm from "@/components/ExpenseForm";
import ConfirmDialog from "@/components/ConfirmDialog";
import ExpenseImportDialog from "@/components/ExpenseImportDialog";
import type { Expense } from "@/lib/types";

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | undefined>();
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ type: "one" | "all"; id?: string } | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/expenses");
    if (response.ok) { setExpenses(await response.json()); setError(""); } else setError("Could not load expenses.");
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(id: string) {
    const response = await fetch(`/api/expenses?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setConfirmation(null);
    if (response.ok) load(); else setError("Could not delete expense.");
  }
  async function clearAll() {
    const response = await fetch("/api/expenses?clear=all", { method: "DELETE" });
    setConfirmation(null);
    if (response.ok) { setEditing(undefined); setOpen(false); load(); } else setError("Could not clear expenses.");
  }

  return <section className="page-shell">
    <header className="purchase-topbar">
      <div className="title-row"><h1>Expenses</h1><span className="record-count">{expenses.length}</span></div>
      <div className="purchase-topbar-actions">
        <button type="button" className="button-secondary" onClick={() => setImportOpen(true)}>Import spreadsheet</button>
        <button className={`button page-action purchase-toggle ${open && !editing ? "purchase-toggle-close" : ""}`} onClick={() => { if (open && !editing) setOpen(false); else { setEditing(undefined); setOpen(true); } }}>
          <span className="purchase-toggle-icon" aria-hidden="true">{open && !editing ? "×" : "+"}</span>
          <span className="purchase-toggle-label">{open && !editing ? "Close form" : "Add expense"}</span>
        </button>
      </div>
    </header>

    {open && <div className="form-region"><ExpenseForm key={editing?.id ?? "new"} expense={editing} onCancel={() => { setEditing(undefined); setOpen(false); }} onSaved={() => { setEditing(undefined); setOpen(false); load(); }} /></div>}

    <div className="data-panel">
      <div className="table-toolbar"><div><p className="table-title">Expense history</p><p className="table-meta">{expenses.length ? `${expenses.length} saved ${expenses.length === 1 ? "record" : "records"}` : "Your saved expenses will appear here"}</p></div>{expenses.length > 0 && <button className="button-danger" onClick={() => setConfirmation({ type: "all" })}>Clear all</button>}</div>
      <div className="table-scroll"><table className="expense-grid w-full min-w-[800px] text-left text-sm"><thead><tr>{["Purchase Date", "Purchased From", "Arrived?", "Item Description", "Cost", "Actions"].map(heading => <th key={heading} className="px-5 py-4">{heading}</th>)}</tr></thead><tbody>{expenses.length ? expenses.map(expense => <tr key={expense.id}><td className="px-5 py-4">{expense.purchase_date}</td><td className="px-5 py-4">{expense.purchased_from}</td><td className="px-5 py-4">{expense.arrived === null ? "—" : expense.arrived ? "Yes" : "No"}</td><td className="px-5 py-4 font-semibold">{expense.item_description}</td><td className="px-5 py-4 font-semibold">£{Number(expense.cost).toFixed(2)}</td><td className="px-5 py-4"><div className="row-actions"><button className="action-edit" onClick={() => { setEditing(expense); setOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button><button className="action-delete" onClick={() => setConfirmation({ type: "one", id: expense.id })}>Delete</button></div></td></tr>) : <tr className="grid-empty-row"><td colSpan={6}><div><strong>No expenses yet.</strong><span>{error || "Click Add expense to add your first expense."}</span><button onClick={() => setOpen(true)}>Add expense</button></div></td></tr>}</tbody></table></div>
    </div>
    {confirmation && <ConfirmDialog title={confirmation.type === "all" ? "Clear all expenses?" : "Delete this expense?"} message={confirmation.type === "all" ? `This will permanently remove all ${expenses.length} saved expense records. This cannot be undone.` : "This expense will be permanently removed from your history. This cannot be undone."} confirmLabel={confirmation.type === "all" ? "Clear all expenses" : "Delete expense"} onCancel={() => setConfirmation(null)} onConfirm={() => confirmation.type === "all" ? clearAll() : remove(confirmation.id!)} />}
    {importOpen && <ExpenseImportDialog onClose={() => setImportOpen(false)} onImported={load} />}
  </section>;
}
