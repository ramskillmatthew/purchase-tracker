"use client";
import { useEffect, useMemo, useState } from "react";
import { draftFor, type Draft, type Edit } from "@/lib/purchase-import/draft";
import { poundsToPence } from "@/lib/purchase-import/allocate";

const conditions = ["Brand new", "Brand new without tags", "Labelled as very good condition", "Good condition from photos", "Decent condition from photos"];

type Candidate = {
  id: string; yahoo_message_id: string; email_date: string; subject: string; order_reference: string | null;
  item_title: string | null; seller_name: string | null; item_size: string | null; price_paid: number | null;
  purchase_date: string | null; cancellation_refund_status: string | null; parser_confidence: number;
  import_status: string; imported_purchase_id: string | null; purchased_from: string | null;
  candidate_type: "vinted" | "general"; uncertainty_reasons: string[];
  item_index: number; unit_index: number; order_total_paid: number | null;
  source_provider: string | null; source_account: string | null; item_condition_hint: string | null;
  draft: Draft | null;
};
type SaveState = "idle" | "saving" | "saved" | "error";

function fieldIsUncertain(reasons: string[], keyword: RegExp) { return reasons.some(reason => keyword.test(reason)); }

export default function PurchaseImportPage() {
  const today = new Date().toISOString().slice(0, 10), monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [startDate, setStart] = useState(monthAgo), [endDate, setEnd] = useState(today), [instruction, setInstruction] = useState("");
  const [rows, setRows] = useState<Candidate[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [viewRejected, setViewRejected] = useState(false);
  const [lastBatchIds, setLastBatchIds] = useState<string[]>([]);

  async function load() {
    const status = viewRejected ? "rejected" : "pending";
    const r = await fetch(`/api/vinted/candidates?status=${status}`);
    if (!r.ok) { const body = await r.json().catch(() => ({})); setError(body.error || "Could not load purchase candidates."); return; }
    const data = await r.json() as Candidate[];
    setRows(data);
    setEdits(old => Object.fromEntries(data.map(x => [x.id, draftFor(x, old[x.id])])));
  }
  useEffect(() => { load(); }, [viewRejected]); // eslint-disable-line react-hooks/exhaustive-deps

  async function sync() {
    setBusy(true); setError(""); setMessage("Connecting to Yahoo and Gmail and scanning…"); setLastBatchIds([]);
    try {
      const payload = instruction.trim() ? { instruction: instruction.trim() } : { startDate, endDate };
      const r = await fetch("/api/vinted/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await r.json();
      if (r.ok) {
        // Surfaces why some candidates need review — e.g. AI-assisted
        // extraction not configured, failed, or hit an unsupported
        // currency — from the safe, count-only diagnostics the sync route
        // returns (see AiExtractionOutcome in lib/purchase-import/ai-schema.ts).
        const diagnosticLabels: Record<string, string> = { not_configured: "AI extraction unavailable", request_failed: "AI request failed", no_tool_call: "AI returned no structured result", invalid_output: "AI result failed validation", unsupported_currency: "unsupported currency", limit_reached: "AI extraction limit reached" };
        const diagnostics = body.aiDiagnostics as Record<string, number> | undefined;
        const failureNotes = diagnostics ? Object.entries(diagnostics).filter(([key, count]) => key !== "success" && count > 0).map(([key, count]) => `${count} ${diagnosticLabels[key] || key}`) : [];
        setMessage(`Searched ${body.startDate} to ${body.endDate}. Scanned ${body.scanned} email headers; shortlisted ${body.shortlisted}; accepted ${body.parsed}; rejected ${body.rejected} non-purchases; ${body.uncertain || 0} accepted emails need review${body.aiAssisted ? ` (${body.aiAssisted} used AI-assisted extraction)` : ""}.${failureNotes.length ? ` Needs manual review: ${failureNotes.join(", ")}.` : ""}${body.truncated ? " The mailbox scan reached its 5,000-email safety limit." : ""}`);
        await load();
      } else setError(body.error || "Sync failed.");
    } catch { setError("The email search was interrupted. Please try again."); }
    finally { setBusy(false); }
  }

  async function reject(id: string) {
    if (!confirm("Reject this candidate? It can be restored later from the rejected view.")) return;
    setBusy(true);
    const r = await fetch("/api/vinted/candidates", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "reject" }) });
    const body = await r.json();
    if (r.ok) { setMessage("Candidate rejected. It can be restored from the rejected view."); await load(); } else setError(body.error || "Could not reject candidate.");
    setBusy(false);
  }
  async function restore(id: string) {
    setBusy(true);
    const r = await fetch("/api/vinted/candidates", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "restore" }) });
    const body = await r.json();
    if (r.ok) { setMessage("Candidate restored to pending review."); await load(); } else setError(body.error || "Could not restore candidate.");
    setBusy(false);
  }
  async function removeCandidate(id: string) {
    if (!confirm("Permanently delete this candidate? This cannot be undone (use Reject instead if you might want it back). The source email and any purchase will remain.")) return;
    setBusy(true);
    const r = await fetch(`/api/vinted/candidates?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = await r.json();
    if (r.ok) { setMessage("Candidate permanently deleted."); await load(); } else setError(body.error || "Could not delete candidate.");
    setBusy(false);
  }
  async function clearAll() {
    if (!confirm("Permanently delete every pending and rejected candidate? Source emails and purchases will remain. This cannot be undone.")) return;
    setBusy(true);
    const r = await fetch("/api/vinted/candidates?clear=all", { method: "DELETE" });
    const body = await r.json();
    if (r.ok) { setMessage(`Cleared ${body.deleted} candidates.`); await load(); } else setError(body.error || "Could not clear candidates.");
    setBusy(false);
  }
  function update(id: string, key: keyof Edit, value: string | boolean) { setEdits(old => ({ ...old, [id]: { ...old[id], [key]: value } })); }

  // REGRESSION: importing must be all-or-nothing for a multi-row order —
  // ticking any one row's checkbox selects/deselects every pending,
  // importable (not cancelled/refunded) row in that same order group
  // together, so a partial selection is never possible from this UI. The
  // server and database independently enforce the same rule (see
  // app/api/vinted/import/route.ts and the RPC's Pass 1.5) — this is a UX
  // convenience, never the only guard.
  function selectGroup(ids: string[], checked: boolean) {
    setEdits(old => {
      const next = { ...old };
      for (const id of ids) if (next[id]) next[id] = { ...next[id], selected: checked };
      return next;
    });
  }

  // Persists the reviewer's edit so it survives a page reload or another
  // sync (see app/api/vinted/candidates/route.ts's save_draft action). The
  // sync route never writes to the `draft` column, so nothing here can be
  // silently overwritten by a re-scan.
  async function saveDraft(id: string, edit: Edit) {
    setSaveState(s => ({ ...s, [id]: "saving" }));
    const draft: Draft = { purchased_from: edit.purchased_from, sku: edit.sku, item_description: edit.item_description, seller_name: edit.seller_name, item_size: edit.item_size, item_condition: edit.item_condition, price_purchased: edit.price_purchased, order_date: edit.order_date, arrived: edit.arrived };
    try {
      const r = await fetch("/api/vinted/candidates", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "save_draft", draft }) });
      setSaveState(s => ({ ...s, [id]: r.ok ? "saved" : "error" }));
    } catch { setSaveState(s => ({ ...s, [id]: "error" })); }
  }
  // For selects/dates, the onChange event itself is the whole edit — commit
  // immediately, merging the new value in directly rather than waiting on
  // the next render (setEdits hasn't applied yet at this point).
  function commit(id: string, key: keyof Edit, value: string | boolean) {
    update(id, key, value);
    void saveDraft(id, { ...edits[id], [key]: value } as Edit);
  }
  // For free-typed text/number fields, save once the field loses focus
  // rather than on every keystroke.
  function blurSave(id: string) { void saveDraft(id, edits[id]); }

  const visible = useMemo(() => rows.filter(x => !filter || `${x.subject} ${x.item_title} ${x.seller_name} ${x.order_reference} ${x.purchased_from}`.toLowerCase().includes(filter.toLowerCase())), [rows, filter]);
  const selectable = visible.filter(x => x.import_status === "pending" && !x.cancellation_refund_status);
  const allSelected = selectable.length > 0 && selectable.every(x => edits[x.id]?.selected);
  function toggleAll() { const ids = new Set(selectable.map(x => x.id)); setEdits(old => Object.fromEntries(Object.entries(old).map(([id, e]) => [id, ids.has(id) ? { ...e, selected: !allSelected } : e]))); }

  // Rows from the same source email/order are grouped together for review,
  // in the order the API already returns them (newest email first).
  const groups = useMemo(() => {
    const byMessage = new Map<string, Candidate[]>();
    for (const row of visible) { if (!byMessage.has(row.yahoo_message_id)) byMessage.set(row.yahoo_message_id, []); byMessage.get(row.yahoo_message_id)!.push(row); }
    return [...byMessage.values()];
  }, [visible]);

  const chosen = visible.filter(x => edits[x.id]?.selected && x.import_status === "pending" && !x.cancellation_refund_status);
  const invalid = chosen.filter(x => { const e = edits[x.id]; return !e.purchased_from || !e.item_description || !e.item_size || !e.item_condition || !e.price_purchased || !e.order_date; });
  // REGRESSION: compares the exact rows being imported (the selected
  // subset — always the whole group or nothing, per selectGroup above) to
  // the stored order total, in exact integer pence rather than floating
  // point, so it can never pass on a fractional-penny rounding artefact.
  const mismatchedGroups = groups.filter(group => {
    const orderTotal = group[0].order_total_paid;
    if (orderTotal === null) return false;
    const chosenInGroup = group.filter(row => edits[row.id]?.selected);
    if (!chosenInGroup.length) return false;
    const allocatedPence = chosenInGroup.reduce((sum, row) => sum + poundsToPence(Number(edits[row.id]?.price_purchased) || 0), 0);
    return allocatedPence !== poundsToPence(orderTotal);
  });
  const total = chosen.reduce((n, x) => n + (Number(edits[x.id]?.price_purchased) || 0), 0);
  const duplicateCount = visible.filter(x => x.import_status === "imported" || x.imported_purchase_id).length;
  const canImport = chosen.length > 0 && invalid.length === 0 && mismatchedGroups.length === 0;

  async function importSelected() {
    if (!canImport) return;
    if (!confirm(`Import ${chosen.length} purchases totalling £${total.toFixed(2)}?`)) return;
    setBusy(true);
    const records = chosen.map(x => { const e = edits[x.id]; return { candidateId: x.id, purchased_from: e.purchased_from, sku: e.sku, item_description: e.item_description, seller_name: e.seller_name, item_size: e.item_size, item_condition: e.item_condition, price_purchased: Number(e.price_purchased), order_date: e.order_date, arrived: e.arrived === "" ? null : e.arrived === "true" }; });
    const r = await fetch("/api/vinted/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, records }) });
    const body = await r.json();
    if (r.ok) {
      const blockedNote = body.blocked ? ` ${body.blocked} blocked (${(body.blockedReasons || []).join(", ") || "conflict"}) — see the order(s) above for details.` : "";
      setMessage(`Imported ${body.inserted}; duplicates excluded ${body.duplicates}; total £${body.total}.${blockedNote}`);
      setLastBatchIds(body.insertedIds || []); await load();
    } else setError(body.error || "Import failed.");
    setBusy(false);
  }

  return <section className="page-shell vinted-page"><header className="page-header"><div><span className="purchase-form-kicker">Yahoo &amp; Gmail workflow</span><h1>Purchase Email Import</h1><p>Ask for purchases by retailer or date, review every result, then confirm.</p></div></header>
    <div className="card purchase-import-question"><label className="field"><span className="label">What purchases should I find?</span><textarea className="input" value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Import all my purchases from today, or import my Vinted purchases from last week." /></label><p>Leave this blank to use the exact dates below.</p></div>
    <div className="card sync-toolbar"><label className="field"><span className="label">From (optional)</span><input className="input" type="date" value={startDate} onChange={e => setStart(e.target.value)} /></label><label className="field"><span className="label">To (optional)</span><input className="input" type="date" value={endDate} onChange={e => setEnd(e.target.value)} /></label><button className="button" onClick={sync} disabled={busy}>{busy ? "Syncing…" : "Sync Yahoo & Gmail"}</button></div>
    {message && <p className="sync-message">{message}</p>}{error && <p className="bulk-save-error">{error}</p>}
    {lastBatchIds.length > 0 && <p className="sync-message"><a className="button-secondary" href={`/api/export/purchases?ids=${lastBatchIds.join(",")}`}>Download batch CSV for Excel ({lastBatchIds.length})</a></p>}
    <div className="data-panel">
      <div className="grid-toolbar">
        <input className="input" placeholder="Filter candidates" value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="candidate-toolbar-actions">
          <span>{visible.length} candidates · {duplicateCount} duplicates</span>
          <button className="button-secondary" onClick={() => setViewRejected(v => !v)}>{viewRejected ? "View pending" : "View rejected"}</button>
          {!viewRejected && selectable.length > 0 && <button className="button-secondary" onClick={toggleAll}>{allSelected ? "Deselect all" : "Select all"}</button>}
          {rows.length > 0 && <button className="button-danger" onClick={clearAll}>Delete all permanently</button>}
        </div>
      </div>
      <div className="vinted-list">
        {groups.map(group => <OrderGroup key={group[0].yahoo_message_id} group={group} edits={edits} saveState={saveState} busy={busy} invalidIds={new Set(invalid.map(x => x.id))} mismatched={mismatchedGroups.includes(group)} viewRejected={viewRejected} update={update} commit={commit} blurSave={blurSave} selectGroup={selectGroup} reject={reject} restore={restore} remove={removeCandidate} />)}
        {!groups.length && <div className="email-empty">No {viewRejected ? "rejected" : "parsed"} candidates in this view.</div>}
      </div>
    </div>
    {!viewRejected && <div className="bulk-save-bar"><div><strong>{chosen.length} selected · £{total.toFixed(2)}</strong><span>{invalid.length} with missing fields · {mismatchedGroups.length} order total mismatch(es) · {duplicateCount} duplicates excluded</span></div><button className="button" disabled={busy || !canImport} onClick={importSelected}>Review and confirm import</button></div>}
  </section>;
}

function OrderGroup({ group, edits, saveState, busy, invalidIds, mismatched, viewRejected, update, commit, blurSave, selectGroup, reject, restore, remove }: {
  group: Candidate[]; edits: Record<string, Edit>; saveState: Record<string, SaveState>; busy: boolean; invalidIds: Set<string>; mismatched: boolean; viewRejected: boolean;
  update: (id: string, key: keyof Edit, value: string | boolean) => void; commit: (id: string, key: keyof Edit, value: string | boolean) => void; blurSave: (id: string) => void;
  selectGroup: (ids: string[], checked: boolean) => void;
  reject: (id: string) => void; restore: (id: string) => void; remove: (id: string) => void;
}) {
  const first = group[0];
  const orderTotal = first.order_total_paid;
  const allocatedTotal = group.reduce((sum, row) => sum + (Number(edits[row.id]?.price_purchased) || 0), 0);
  const sourceAccount = first.source_account ? `${first.source_provider === "gmail" ? "Gmail" : "Yahoo"} · ${first.source_account}` : (first.source_provider === "gmail" ? "Gmail" : "Yahoo");
  // The set of rows a checkbox toggle in this group actually applies to —
  // every still-pending, importable (not cancelled/refunded) sibling, so
  // ticking any one of them selects/deselects the whole group together.
  const selectableIds = group.filter(row => row.import_status === "pending" && !row.cancellation_refund_status).map(row => row.id);
  const toggleGroup = (checked: boolean) => selectGroup(selectableIds, checked);
  return (
    <div className="order-group">
      <div className="order-group-header">
        <div>
          <strong>{first.purchased_from || "Unknown retailer"}</strong>
          <span className="order-group-meta">{first.order_reference || "No order reference"} · {sourceAccount} · {new Date(first.email_date).toLocaleString()}</span>
        </div>
        {group.length > 1 && <span className="order-group-count">{group.length} items</span>}
      </div>
      {orderTotal !== null && (
        <div className={`order-group-totals${mismatched ? " order-total-mismatch" : ""}`}>
          <span>Order total: £{orderTotal.toFixed(2)}</span>
          <span>Allocated: £{allocatedTotal.toFixed(2)}</span>
          {mismatched && <span className="order-total-warning">These don&rsquo;t match — check the row prices before importing.</span>}
        </div>
      )}
      {group.length > 1 && !viewRejected && selectableIds.length > 0 && <p className="order-group-hint">This order has {group.length} items — selecting one selects all of them together; they can only be imported as a complete order.</p>}
      {group.map(row => <CandidateRow key={row.id} row={row} edit={edits[row.id]} saved={saveState[row.id]} busy={busy} invalid={invalidIds.has(row.id)} showUnit={group.length > 1} viewRejected={viewRejected} update={update} commit={commit} blurSave={blurSave} toggleGroup={toggleGroup} reject={reject} restore={restore} remove={remove} />)}
    </div>
  );
}

function DraftSaveIndicator({ state }: { state: SaveState | undefined }) {
  if (!state || state === "idle") return null;
  if (state === "saving") return <span className="draft-save-state">Saving…</span>;
  if (state === "error") return <span className="draft-save-state draft-save-error">Error saving — try again</span>;
  return <span className="draft-save-state draft-save-ok">Saved</span>;
}

function CandidateRow({ row, edit, saved, busy, invalid, showUnit, viewRejected, update, commit, blurSave, toggleGroup, reject, restore, remove }: {
  row: Candidate; edit: Edit | undefined; saved: SaveState | undefined; busy: boolean; invalid: boolean; showUnit: boolean; viewRejected: boolean;
  update: (id: string, key: keyof Edit, value: string | boolean) => void; commit: (id: string, key: keyof Edit, value: string | boolean) => void; blurSave: (id: string) => void;
  toggleGroup: (checked: boolean) => void;
  reject: (id: string) => void; restore: (id: string) => void; remove: (id: string) => void;
}) {
  if (!edit) return null;
  const disabled = row.import_status === "imported" || Boolean(row.cancellation_refund_status) || viewRejected;
  const uncertain = row.uncertainty_reasons || [];
  const priceUncertain = fieldIsUncertain(uncertain, /price/i);
  const sizeUncertain = fieldIsUncertain(uncertain, /size/i);
  const conditionUncertain = fieldIsUncertain(uncertain, /condition/i);
  const onBlurSave = disabled ? undefined : () => blurSave(row.id);
  return <div className={`vinted-candidate ${disabled ? "candidate-disabled" : ""}`}>
    <div className="candidate-head">
      {/* REGRESSION: toggles the whole order group together, never just this row — an order must be imported all-or-nothing. */}
      {!viewRejected && <input type="checkbox" checked={edit.selected} disabled={disabled} onChange={e => toggleGroup(e.target.checked)} />}
      <div>
        <strong>{row.item_title || row.subject}</strong>
        {showUnit && <span className="candidate-unit-label">Item {row.item_index + 1}, unit {row.unit_index + 1}</span>}
        <span>{row.candidate_type === "vinted" ? "Vinted parser" : "General parser"}</span>
      </div>
      <span className="confidence">{Math.round(row.parser_confidence * 100)}% confidence</span>
      {uncertain.length > 0 && <span className="uncertain-badge">Check details</span>}
      {!disabled && <DraftSaveIndicator state={saved} />}
      {row.import_status === "imported" || row.cancellation_refund_status ? <span className="duplicate-badge">{row.cancellation_refund_status || "Already imported"}</span> : null}
      {viewRejected ? <button className="candidate-delete" onClick={() => restore(row.id)} disabled={busy}>Restore</button>
        : row.import_status !== "imported" && <><button className="candidate-reject" onClick={() => reject(row.id)} disabled={busy}>Reject</button><button className="candidate-delete" onClick={() => remove(row.id)} disabled={busy}>Delete permanently</button></>}
    </div>
    {uncertain.length > 0 && <div className="candidate-uncertainty"><strong>I was unsure about this email:</strong><ul>{uncertain.map(x => <li key={x}>{x}</li>)}</ul></div>}
    <div className="candidate-grid">
      <Field label="Purchased from *" value={edit.purchased_from} set={v => update(row.id, "purchased_from", v)} onBlur={onBlurSave} />
      <Field label="SKU" value={edit.sku} set={v => update(row.id, "sku", v)} placeholder="May be blank" onBlur={onBlurSave} />
      <Field label="Item *" value={edit.item_description} set={v => update(row.id, "item_description", v)} onBlur={onBlurSave} />
      <Field label="Seller" value={edit.seller_name} set={v => update(row.id, "seller_name", v)} placeholder="May be blank" onBlur={onBlurSave} />
      <Field label={sizeUncertain ? "Size * (uncertain)" : "Size *"} value={edit.item_size} set={v => update(row.id, "item_size", v)} onBlur={onBlurSave} />
      <label>{conditionUncertain ? "Condition * (uncertain)" : "Condition *"}<select value={edit.item_condition} onChange={e => commit(row.id, "item_condition", e.target.value)}><option value="">Select manually</option>{conditions.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>{priceUncertain ? "Price * (uncertain)" : "Price *"}<input type="number" step=".01" min="0" value={edit.price_purchased} onChange={e => update(row.id, "price_purchased", e.target.value)} onBlur={onBlurSave} /></label>
      <label>Date *<input type="date" value={edit.order_date} onChange={e => commit(row.id, "order_date", e.target.value)} /></label>
      <label>Arrived<select value={edit.arrived} onChange={e => commit(row.id, "arrived", e.target.value)}><option value="false">No</option><option value="true">Yes</option><option value="">Blank</option></select></label>
    </div>
    {edit.selected && invalid && <p className="candidate-warning">Complete required fields. SKU and seller may remain blank.</p>}
  </div>;
}
function Field({ label, value, set, placeholder, onBlur }: { label: string; value: string; set: (value: string) => void; placeholder?: string; onBlur?: () => void }) { return <label>{label}<input value={value} placeholder={placeholder} onChange={e => set(e.target.value)} onBlur={onBlur} /></label>; }
