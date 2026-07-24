"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Task } from "@/lib/types";
import { broadcastTasksChanged, compareTodayTasks, isTaskDueToday, isTaskOverdue } from "@/lib/tasks";
import TaskRow from "./TaskRow";
import TaskFormModal from "./TaskFormModal";
import TaskToast from "./TaskToast";

// Fully self-contained — its own fetch, state and modal — so it can be
// dropped onto the Home dashboard as a single component without wiring
// into app/page.tsx's existing data flow.
export default function TodaysTasksCard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [toastTask, setToastTask] = useState<Task | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/tasks");
      if (!r.ok) { const body = await r.json().catch(() => ({})); setError(body.error || "Could not load tasks."); return; }
      setTasks(await r.json());
      setError("");
    } catch { setError("Could not load tasks."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Only overdue or due-today, incomplete, never undated tasks.
  const today = tasks
    .filter(task => !task.completed && task.due_date !== null && (isTaskOverdue(task) || isTaskDueToday(task)))
    .sort(compareTodayTasks)
    .slice(0, 5);

  async function toggle(task: Task, nextCompleted: boolean) {
    try {
      const r = await fetch(`/api/tasks?id=${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed: nextCompleted }) });
      return r.ok;
    } catch { return false; }
  }
  function settle(task: Task, nextCompleted: boolean) {
    setTasks(current => current.map(item => item.id === task.id ? { ...item, completed: nextCompleted, completed_at: nextCompleted ? new Date().toISOString() : null } : item));
    broadcastTasksChanged();
    if (nextCompleted) setToastTask(task);
  }
  async function undoComplete() {
    if (!toastTask) return;
    const target = toastTask;
    setToastTask(null);
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
          <strong>✓ You&rsquo;re all caught up.</strong>
          <span>No outstanding tasks today.</span>
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
      {toastTask && <TaskToast message="✓ Task completed" actionLabel="Undo" onAction={() => void undoComplete()} onDismiss={() => setToastTask(null)} />}
    </section>
  );
}
