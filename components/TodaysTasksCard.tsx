"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Task } from "@/lib/types";
import { broadcastTasksChanged, compareTodayTasks, isTaskActionableToday, isTaskDueToday, isTaskOverdue, todayDateString } from "@/lib/tasks";
import { allTasksCompletedMessage, taskCompletedMessage, taskRestoredMessage } from "@/lib/success-messages";
import TaskRow from "./TaskRow";
import TaskFormModal from "./TaskFormModal";
import TaskToast from "./TaskToast";

// Fully self-contained — its own fetch, state and modal — so it can be
// dropped onto the Home dashboard as a single component without wiring
// into app/page.tsx's existing data flow.
export default function TodaysTasksCard({ maxTasks = 5 }: { maxTasks?: number }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast] = useState<{ kind: "completed"; task: Task } | { kind: "restored" } | null>(null);
  // Session-local only — true once a completion has just emptied the
  // actionable-today bucket. Reset on the next full load() so a refresh
  // always returns to the neutral empty state.
  const [justClearedToday, setJustClearedToday] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/tasks");
      if (!r.ok) { const body = await r.json().catch(() => ({})); setError(body.error || "Could not load tasks."); return; }
      setTasks(await r.json());
      setJustClearedToday(false);
      setError("");
    } catch { setError("Could not load tasks."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Only overdue or due-today, incomplete, never undated tasks.
  const today = tasks
    .filter(task => !task.completed && task.due_date !== null && (isTaskOverdue(task) || isTaskDueToday(task)))
    .sort(compareTodayTasks)
    .slice(0, maxTasks);

  async function toggle(task: Task, nextCompleted: boolean) {
    try {
      const r = await fetch(`/api/tasks?id=${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed: nextCompleted }) });
      return r.ok;
    } catch { return false; }
  }
  function settle(task: Task, nextCompleted: boolean) {
    setTasks(current => {
      const next = current.map(item => item.id === task.id ? { ...item, completed: nextCompleted, completed_at: nextCompleted ? new Date().toISOString() : null } : item);
      if (nextCompleted) {
        // Checked against the full (unsliced) task list — this card only
        // ever displays up to 5 of today's tasks, but "was this the last
        // one" must reflect the true actionable-today count, not the slice.
        const todayDate = todayDateString();
        const wasActionable = isTaskActionableToday(task, todayDate);
        const stillActionable = next.some(item => isTaskActionableToday(item, todayDate));
        if (wasActionable && !stillActionable) setJustClearedToday(true);
      } else {
        setJustClearedToday(false);
      }
      return next;
    });
    broadcastTasksChanged();
    setToast(nextCompleted ? { kind: "completed", task } : { kind: "restored" });
  }
  const emptyCopy = justClearedToday ? allTasksCompletedMessage() : { title: "You’re all caught up.", body: "No outstanding tasks today." };
  async function undoComplete() {
    if (toast?.kind !== "completed") return;
    const target = toast.task;
    setToast(null);
    const ok = await toggle(target, false);
    if (ok) settle(target, false);
    else setError("Could not undo — please try again.");
  }

  return (
    <section className="home-panel tasks-panel">
      <div className="home-panel-heading"><h2>Today&rsquo;s Tasks</h2><span>{!loading && !error ? `${today.length} to do` : ""}</span></div>
      {error && <div className="home-error">{error}</div>}
      {!loading && !error && today.length === 0 ? (
        <div className="tasks-empty-inline">
          <strong>✓ {emptyCopy.title}</strong>
          <span>{emptyCopy.body}</span>
        </div>
      ) : (
        <div className="task-list task-list-compact">
          {today.map(task => <TaskRow key={task.id} task={task} variant="compact" onToggle={toggle} onSettled={settle} />)}
        </div>
      )}
      <div className="tasks-panel-footer">
        <Link href="/tasks">View all tasks →</Link>
        <button type="button" className="button-secondary" onClick={() => setShowModal(true)}>Add Task</button>
      </div>
      {showModal && <TaskFormModal onClose={() => setShowModal(false)} onSaved={load} />}
      {toast?.kind === "completed" && <TaskToast message={taskCompletedMessage()} actionLabel="Undo" onAction={() => void undoComplete()} onDismiss={() => setToast(null)} />}
      {toast?.kind === "restored" && <TaskToast message={taskRestoredMessage()} onDismiss={() => setToast(null)} />}
    </section>
  );
}
