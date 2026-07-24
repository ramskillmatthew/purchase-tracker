"use client";

import { useEffect, useRef, useState } from "react";
import type { Task } from "@/lib/types";

// Kept in one place so both the Tasks page and TodaysTasksCard format due
// dates identically.
export function formatTaskDueDate(value: string | null): { text: string; overdue: boolean } | null {
  if (!value) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${value}T00:00:00`);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return { text: "Today", overdue: false };
  if (diffDays === 1) return { text: "Tomorrow", overdue: false };
  if (diffDays === -1) return { text: "Overdue — yesterday", overdue: true };
  const formatted = due.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return diffDays < -1 ? { text: `Overdue — ${formatted}`, overdue: true } : { text: formatted, overdue: false };
}

export default function TaskRow({ task, variant, onToggle, onSettled, onEdit, onDelete }: {
  task: Task;
  variant: "full" | "compact";
  // Performs the optimistic PATCH only — never mutates the caller's task
  // list itself, so this component fully controls how long the row stays
  // visible while its own fill/collapse animation plays out.
  onToggle: (task: Task, nextCompleted: boolean) => Promise<boolean>;
  // Called once the animation has fully finished — this is the caller's
  // cue to actually remove/re-file the task in its own state.
  onSettled: (task: Task, nextCompleted: boolean) => void;
  onEdit?: (task: Task) => void;
  onDelete?: (task: Task) => void;
}) {
  const [pending, setPending] = useState(false);
  const [optimisticDone, setOptimisticDone] = useState<boolean | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(event: MouseEvent) { if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false); }
    function onEscape(event: KeyboardEvent) { if (event.key === "Escape") setMenuOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onEscape); };
  }, [menuOpen]);

  const done = optimisticDone ?? task.completed;

  async function handleToggle() {
    if (pending) return;
    setPending(true); setError("");
    const nextCompleted = !task.completed;
    setOptimisticDone(nextCompleted);
    const ok = await onToggle(task, nextCompleted);
    if (!ok) {
      // REGRESSION guard: never silently lose the task — restore exactly
      // how it looked before the press and surface a visible error.
      setOptimisticDone(null); setPending(false);
      setError("Could not update this task. Please try again.");
      return;
    }
    // Let the checkmark/empty-circle transition land before the row starts
    // collapsing, then hand off to the caller once fully collapsed so
    // remaining rows slide up as part of normal document flow.
    window.setTimeout(() => {
      setCollapsing(true);
      window.setTimeout(() => onSettled(task, nextCompleted), 300);
    }, 220);
  }

  const due = formatTaskDueDate(task.due_date);
  // Completed rows show when the task was finished instead of its due
  // date — the due date stops being the interesting fact once it's done.
  const completedTimeLabel = task.completed && task.completed_at
    ? `Completed ${new Date(task.completed_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : null;

  return (
    <div className={`task-row${collapsing ? " task-row-collapsing" : ""}${task.completed ? " task-row-completed" : ""}`}>
      <button type="button" className={`task-circle${done ? " task-circle-done" : ""}`} onClick={handleToggle} disabled={pending} aria-label={done ? "Mark as not done" : "Mark as done"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17l9-10" /></svg>
      </button>
      <div className="task-row-body">
        <span className={onEdit ? "task-title task-title-editable" : "task-title"} onDoubleClick={onEdit ? () => onEdit(task) : undefined} title={onEdit ? "Double-click to edit" : undefined}>{task.title}</span>
        <div className="task-row-meta">
          <span className="task-category-badge">{task.category}</span>
          {variant === "full" && <span className={`task-priority-badge task-priority-${task.priority.toLowerCase()}`}>{task.priority}</span>}
          {completedTimeLabel ? <span className="task-completed-time">{completedTimeLabel}</span> : (due && <span className={`task-due${due.overdue ? " task-due-overdue" : ""}`}>{due.text}</span>)}
        </div>
        {error && <span className="task-row-error">{error}</span>}
      </div>
      {variant === "full" && (onEdit || onDelete) && (
        <div className="task-menu-wrap" ref={menuRef}>
          <button type="button" className="task-menu-trigger" aria-label="Task actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>⋯</button>
          {menuOpen && <div className="task-menu" role="menu">
            {onEdit && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEdit(task); }}>Edit</button>}
            {task.completed && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void handleToggle(); }}>Mark as not done</button>}
            {onDelete && <button type="button" role="menuitem" className="task-menu-danger" onClick={() => { setMenuOpen(false); onDelete(task); }}>Delete</button>}
          </div>}
        </div>
      )}
    </div>
  );
}
