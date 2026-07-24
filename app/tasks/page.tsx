"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@/lib/types";
import { broadcastTasksChanged, compareAllTasks, compareCompletedTasks, compareTodayTasks, compareUpcomingTasks, isTaskDueToday, isTaskOverdue, todayDateString } from "@/lib/tasks";
import TaskRow from "@/components/TaskRow";
import TaskFormModal from "@/components/TaskFormModal";
import TaskToast from "@/components/TaskToast";
import ConfirmDialog from "@/components/ConfirmDialog";

type Tab = "today" | "upcoming" | "all" | "completed";
const tabs: { value: Tab; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
];

function completedGroupLabel(completedAt: string | null): string {
  if (!completedAt) return "";
  const completed = new Date(completedAt);
  const day = new Date(completed.getFullYear(), completed.getMonth(), completed.getDate());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="empty-check"><path d="M5 12.5 10 17l9-10" /></svg>;
}

function EmptyState({ tab, onAdd }: { tab: Tab; onAdd: () => void }) {
  if (tab === "completed") return <div className="empty-state empty-left"><span className="empty-icon"><CheckIcon /></span><div><h2>No completed tasks yet.</h2></div></div>;
  const copy: Record<Exclude<Tab, "completed">, { title: string; body: string }> = {
    today: { title: "You’re all caught up.", body: "No outstanding tasks today." },
    upcoming: { title: "Nothing scheduled.", body: "You have no upcoming tasks." },
    all: { title: "No active tasks.", body: "Create a task to get started." },
  };
  const { title, body } = copy[tab as Exclude<Tab, "completed">];
  return <div className="empty-state empty-left">
    <span className="empty-icon"><CheckIcon /></span>
    <div><h2>{title}</h2><p>{body}</p><button type="button" className="empty-action" onClick={onAdd}>Add Task</button></div>
  </div>;
}

type RowHandlers = {
  onToggle: (task: Task, nextCompleted: boolean) => Promise<boolean>;
  onSettled: (task: Task, nextCompleted: boolean) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
};

function CompletedGroups({ tasks, handlers }: { tasks: Task[]; handlers: RowHandlers }) {
  const groups: { label: string; items: Task[] }[] = [];
  for (const task of tasks) {
    const label = completedGroupLabel(task.completed_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(task);
    else groups.push({ label, items: [task] });
  }
  return <div className="task-completed-groups">
    {groups.map(group => <div key={group.label} className="task-completed-group">
      <h3 className="task-completed-heading">{group.label}</h3>
      <div className="task-list">
        {group.items.map(task => <TaskRow key={task.id} task={task} variant="full" onToggle={handlers.onToggle} onSettled={handlers.onSettled} onEdit={handlers.onEdit} onDelete={handlers.onDelete} />)}
      </div>
    </div>)}
  </div>;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("today");
  const [modalTask, setModalTask] = useState<Task | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [toastTask, setToastTask] = useState<Task | null>(null);
  const [quickAddValue, setQuickAddValue] = useState("");
  const [quickAddSaving, setQuickAddSaving] = useState(false);
  const quickAddRef = useRef<HTMLInputElement>(null);

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

  const buckets = useMemo(() => {
    const today = todayDateString();
    const active = tasks.filter(task => !task.completed);
    return {
      today: active.filter(task => task.due_date !== null && (isTaskOverdue(task, today) || isTaskDueToday(task, today))).sort(compareTodayTasks),
      upcoming: active.filter(task => task.due_date !== null && task.due_date! > today).sort(compareUpcomingTasks),
      all: [...active].sort(compareAllTasks),
      completed: tasks.filter(task => task.completed).sort(compareCompletedTasks),
    };
  }, [tasks]);

  const stats = useMemo(() => {
    const today = todayDateString();
    const overdue = buckets.today.filter(task => isTaskOverdue(task, today)).length;
    return { active: buckets.all.length, dueToday: buckets.today.length - overdue, overdue };
  }, [buckets]);

  async function toggle(task: Task, nextCompleted: boolean) {
    try {
      const r = await fetch(`/api/tasks?id=${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed: nextCompleted }) });
      return r.ok;
    } catch { return false; }
  }
  function settle(task: Task, nextCompleted: boolean) {
    setTasks(current => current.map(item => item.id === task.id ? { ...item, completed: nextCompleted, completed_at: nextCompleted ? new Date().toISOString() : null } : item));
    broadcastTasksChanged();
    // Only a fresh completion offers Undo — reversing via the row menu's
    // own "Mark as not done" is already an intentional action, not
    // something that needs a second confirmation path.
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
  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    const r = await fetch(`/api/tasks?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
    if (r.ok) { setTasks(current => current.filter(item => item.id !== target.id)); broadcastTasksChanged(); }
    else { const body = await r.json().catch(() => ({})); setError(body.error || "Could not delete this task."); }
  }
  async function submitQuickAdd() {
    const title = quickAddValue.trim();
    if (!title || quickAddSaving) return;
    setQuickAddSaving(true);
    try {
      const r = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, category: "General", priority: "Medium", due_date: null }) });
      if (r.ok) {
        setQuickAddValue("");
        await load();
        broadcastTasksChanged();
      } else {
        const body = await r.json().catch(() => ({}));
        setError(body.error || "Could not create this task.");
      }
    } catch { setError("Could not create this task. Please try again."); }
    setQuickAddSaving(false);
    quickAddRef.current?.focus();
  }

  const handlers: RowHandlers = { onToggle: toggle, onSettled: settle, onEdit: setModalTask, onDelete: setDeleteTarget };
  const list = buckets[tab];

  return (
    <section className="page-shell tasks-page">
      <header className="page-header">
        <div>
          <h1>Tasks</h1>
          {!loading && <span className="tasks-header-stats">{stats.active} active · {stats.dueToday} due today · <span className={stats.overdue > 0 ? "tasks-stat-overdue" : ""}>{stats.overdue} overdue</span></span>}
        </div>
        <button type="button" className="button page-action" onClick={() => setModalTask(null)}><span className="button-plus">+</span>Add Task</button>
      </header>

      {error && <div className="home-error">{error}</div>}

      <div className="task-tabs" role="tablist">
        {tabs.map(item => (
          <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} className={tab === item.value ? "task-tab task-tab-active" : "task-tab"} onClick={() => setTab(item.value)}>
            {item.label}{!loading && <i>{buckets[item.value].length}</i>}
          </button>
        ))}
      </div>

      <div className="data-panel">
        {!loading && list.length === 0 ? (
          <EmptyState tab={tab} onAdd={() => setModalTask(null)} />
        ) : tab === "completed" ? (
          <CompletedGroups tasks={list} handlers={handlers} />
        ) : (
          <div className="task-list">
            {list.map(task => <TaskRow key={task.id} task={task} variant="full" onToggle={handlers.onToggle} onSettled={handlers.onSettled} onEdit={handlers.onEdit} onDelete={handlers.onDelete} />)}
          </div>
        )}
      </div>

      <div className="quick-add">
        <input ref={quickAddRef} className="input" value={quickAddValue} onChange={e => setQuickAddValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitQuickAdd(); } }} placeholder="What needs doing?" disabled={quickAddSaving} />
        <button type="button" className="quick-add-submit" aria-label="Add task" onClick={() => void submitQuickAdd()} disabled={!quickAddValue.trim() || quickAddSaving}>+</button>
      </div>

      {modalTask !== undefined && <TaskFormModal task={modalTask} onClose={() => setModalTask(undefined)} onSaved={load} />}
      {deleteTarget && <ConfirmDialog title="Delete this task?" message={`"${deleteTarget.title}" will be permanently deleted. This cannot be undone.`} confirmLabel="Delete task" onConfirm={confirmDelete} onCancel={() => setDeleteTarget(null)} />}
      {toastTask && <TaskToast message="✓ Task completed" actionLabel="Undo" onAction={() => void undoComplete()} onDismiss={() => setToastTask(null)} />}
    </section>
  );
}
