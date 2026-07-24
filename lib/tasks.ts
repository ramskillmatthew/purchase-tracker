import type { Task } from "./types";

// Local calendar date (not UTC) — a task due "today" should mean the
// user's own today, not a UTC day boundary that could be off by one
// depending on time of day/timezone.
export function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Explicit rank, never alphabetical — "High" must sort before "Medium"
// before "Low", which a plain string/localeCompare sort would get wrong.
export const taskPriorityRank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

export function isTaskOverdue(task: Task, today: string = todayDateString()): boolean {
  return Boolean(task.due_date) && task.due_date! < today;
}
export function isTaskDueToday(task: Task, today: string = todayDateString()): boolean {
  return task.due_date === today;
}

/**
 * Today tab / Today's Tasks card ordering: overdue tasks always before
 * due-today tasks (never interleaved), then ranked by priority
 * (High > Medium > Low), then — mainly to order the overdue group itself,
 * since every "due today" task shares the same date — by due date
 * ascending (the most overdue first).
 */
export function compareTodayTasks(a: Task, b: Task): number {
  const today = todayDateString();
  const overdueDiff = (isTaskOverdue(a, today) ? 0 : 1) - (isTaskOverdue(b, today) ? 0 : 1);
  if (overdueDiff !== 0) return overdueDiff;
  const rankDiff = (taskPriorityRank[a.priority] ?? 3) - (taskPriorityRank[b.priority] ?? 3);
  if (rankDiff !== 0) return rankDiff;
  return (a.due_date || "").localeCompare(b.due_date || "");
}

/** Upcoming tab: purely chronological. */
export function compareUpcomingTasks(a: Task, b: Task): number {
  return (a.due_date || "").localeCompare(b.due_date || "");
}

/** All tab: dated tasks before undated ones, then priority, then due date. */
export function compareAllTasks(a: Task, b: Task): number {
  const datedDiff = (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1);
  if (datedDiff !== 0) return datedDiff;
  const rankDiff = (taskPriorityRank[a.priority] ?? 3) - (taskPriorityRank[b.priority] ?? 3);
  if (rankDiff !== 0) return rankDiff;
  return (a.due_date || "").localeCompare(b.due_date || "");
}

/** Completed tab: most recently completed first. */
export function compareCompletedTasks(a: Task, b: Task): number {
  return (b.completed_at || "").localeCompare(a.completed_at || "");
}

// Overdue + due-today, incomplete — the shared definition used by the
// Tasks page header/nav badge/Today tab/Today's Tasks card, so all four
// always agree on the same count.
export function isTaskActionableToday(task: Task, today: string = todayDateString()): boolean {
  return !task.completed && task.due_date !== null && (isTaskOverdue(task, today) || isTaskDueToday(task, today));
}

// Mirrors the existing "purchase-theme-change" window-event pattern
// (components/AppHeader.tsx) so the sidebar/mobile-nav badge can stay live
// across separate component instances (the page that changed a task and
// AppHeader are unrelated React trees) without introducing a global state
// store just for this.
export const TASKS_CHANGED_EVENT = "tasks-changed";
export function broadcastTasksChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}
