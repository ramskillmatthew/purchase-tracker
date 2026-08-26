"use client";

import { useEffect, useState } from "react";
import type { Task } from "@/lib/types";
import { taskCategories, taskPriorities } from "@/lib/validation/task";
import { broadcastTasksChanged } from "@/lib/tasks";

const LAST_CATEGORY_KEY = "purchase-tracker-task-last-category";
const LAST_PRIORITY_KEY = "purchase-tracker-task-last-priority";

// Only used when creating a new task (never overrides an existing task's
// own saved values in edit mode) — makes repeated quick task creation via
// this modal faster by starting from whatever was picked last time.
function rememberedDefault<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  return (valid as readonly string[]).includes(stored || "") ? (stored as T) : fallback;
}

export default function TaskFormModal({ task, onClose, onSaved }: {
  task?: Task | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(task);
  const [title, setTitle] = useState(task?.title || "");
  const [notes, setNotes] = useState(task?.notes || "");
  const [category, setCategory] = useState(() => task?.category || rememberedDefault(LAST_CATEGORY_KEY, taskCategories, "General"));
  const [priority, setPriority] = useState(() => task?.priority || rememberedDefault(LAST_PRIORITY_KEY, taskPriorities, "Medium"));
  const [dueDate, setDueDate] = useState(task?.due_date || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setError("Task title is required."); return; }
    setSaving(true); setError("");
    const body = { title: trimmedTitle, notes: notes.trim() || null, category, priority, due_date: dueDate || null };
    try {
      const url = editing ? `/api/tasks?id=${encodeURIComponent(task!.id)}` : "/api/tasks";
      const r = await fetch(url, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) {
        try { window.localStorage.setItem(LAST_CATEGORY_KEY, category); window.localStorage.setItem(LAST_PRIORITY_KEY, priority); } catch { /* localStorage may be unavailable (private browsing) — remembering is a convenience, never required */ }
        broadcastTasksChanged();
        onSaved(); onClose(); return;
      }
      const data = await r.json().catch(() => ({}));
      setError(data.error || "Could not save this task.");
    } catch { setError("Could not save this task. Please try again."); }
    setSaving(false);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
        <div className="task-modal-heading">
          <h2 id="task-modal-title">{editing ? "Edit Task" : "Add Task"}</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="task-modal-body">
          <label className="field"><span className="label">Task title *</span><input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Pack today&rsquo;s orders" autoFocus /></label>
          <label className="field"><span className="label">Notes</span><textarea className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional details" /></label>
          <div className="task-modal-grid">
            <label className="field"><span className="label">Category</span><select className="input" value={category} onChange={e => setCategory(e.target.value)}>{taskCategories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="field"><span className="label">Due date</span><input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
          </div>
          <div className="field">
            <span className="label">Priority</span>
            <div className="task-priority-select">
              {taskPriorities.map(value => <button key={value} type="button" className={`task-priority-option task-priority-option-${value.toLowerCase()}${priority === value ? " task-priority-option-active" : ""}`} onClick={() => setPriority(value)}>{value}</button>)}
            </div>
          </div>
          {error && <p className="task-modal-error">{error}</p>}
        </div>
        <div className="task-modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="button" disabled={saving || !title.trim()} onClick={submit}>{saving ? "Saving…" : editing ? "Save Changes" : "Create Task"}</button>
        </div>
      </div>
    </div>
  );
}
