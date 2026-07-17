"use client";
import { useCallback, useEffect, useState } from "react";
import ExpenseForm from "@/components/ExpenseForm";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { Expense } from "@/lib/types";

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
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
    if (response.ok) { setEditing(undefined); load(); } else setError("Could not clear expenses.");
  }

  return <section className="page-shell">
    <header className="page-header"><div className="title-row"><h1>Expenses</h1><span className="record-count">{expenses.length}</span></div></header>
    <div className="form-region"><ExpenseForm key={editing?.id ?? "new"} expense={editing} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); load(); }} /></div>
    <div className="data-panel">
      <div className="table-toolbar"><div><p className="table-title">Expense history</p><p className="table-meta">{expenses.length ? `${expenses.length} saved ${expenses.length === 1 ? "record" : "records"}` : "Your saved expenses will appear here"}</p></div>{expenses.length > 0 && <button className="button-danger" onClick={() => setConfirmation({ type: "all" })}>Clear all</button>}</div>
      <div className="table-scroll"><table className="expense-grid w-full min-w-[800px] text-left text-sm"><thead><tr>{["Purchase Date", "Purchased From", "Arrived?", "Item Description", "Cost", "Actions"].map(heading => <th key={heading} className="px-5 py-4">{heading}</th>)}</tr></thead><tbody>{expenses.length ? expenses.map(expense => <tr key={expense.id}><td className="px-5 py-4">{expense.purchase_date}</td><td className="px-5 py-4">{expense.purchased_from}</td><td className="px-5 py-4">{expense.arrived === null ? "—" : expense.arrived ? "Yes" : "No"}</td><td className="px-5 py-4 font-semibold">{expense.item_description}</td><td className="px-5 py-4 font-semibold">£{Number(expense.cost).toFixed(2)}</td><td className="px-5 py-4"><div className="row-actions"><button className="action-edit" onClick={() => { setEditing(expense); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button><button className="action-delete" onClick={() => setConfirmation({ type: "one", id: expense.id })}>Delete</button></div></td></tr>) : <tr className="grid-empty-row"><td colSpan={6}><div><strong>No expenses yet.</strong><span>{error || "Complete the expense form above to add your first expense."}</span></div></td></tr>}</tbody></table></div>
    </div>
    {confirmation && <ConfirmDialog title={confirmation.type === "all" ? "Clear all expenses?" : "Delete this expense?"} message={confirmation.type === "all" ? `This will permanently remove all ${expenses.length} saved expense records. This cannot be undone.` : "This expense will be permanently removed from your history. This cannot be undone."} confirmLabel={confirmation.type === "all" ? "Clear all expenses" : "Delete expense"} onCancel={() => setConfirmation(null)} onConfirm={() => confirmation.type === "all" ? clearAll() : remove(confirmation.id!)} />}
  </section>;
}
