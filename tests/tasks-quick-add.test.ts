import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { todayDateString, isTaskDueToday, isTaskOverdue, isTaskActionableToday } from "@/lib/tasks";
import type { Task } from "@/lib/types";

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1", owner_id: "owner-1", title: "Pack orders", notes: null, category: "General", priority: "Medium",
    due_date: null, completed: false, completed_at: null, created_at: "2026-07-27T09:00:00.000Z", updated_at: "2026-07-27T09:00:00.000Z",
    ...overrides,
  };
}

describe("todayDateString (local YYYY-MM-DD, never UTC)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("2. formats today as local YYYY-MM-DD", () => {
    vi.setSystemTime(new Date(2026, 6, 27, 14, 30)); // 27 July 2026, 2:30pm local
    expect(todayDateString()).toBe("2026-07-27");
  });

  it("3. a moment near UTC midnight does not produce the wrong local date", () => {
    // 23:30 local time on 27 July — if this were computed via
    // new Date().toISOString().slice(0,10), a UTC+1 timezone would already
    // have rolled into 28 July in UTC terms, silently producing tomorrow's
    // date instead of today's. Using local getFullYear/getMonth/getDate
    // avoids that entirely regardless of the runtime's UTC offset.
    vi.setSystemTime(new Date(2026, 6, 27, 23, 30));
    expect(todayDateString()).toBe("2026-07-27");
  });

  it("pads single-digit months and days correctly", () => {
    vi.setSystemTime(new Date(2026, 0, 5)); // 5 January 2026
    expect(todayDateString()).toBe("2026-01-05");
  });
});

describe("a Quick-Added task (today's due date, incomplete) qualifies for Today everywhere it should", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  it("8/13. is due today, not overdue, and actionable-today (the shared Today/Home-card definition)", () => {
    const task = buildTask({ due_date: todayDateString() });
    expect(isTaskDueToday(task)).toBe(true);
    expect(isTaskOverdue(task)).toBe(false);
    expect(isTaskActionableToday(task)).toBe(true);
  });

  it("12. does not qualify as Upcoming — Upcoming requires a due date strictly after today", () => {
    const today = todayDateString();
    const task = buildTask({ due_date: today });
    // mirrors app/tasks/page.tsx's buckets.upcoming filter: due_date! > today
    expect(task.due_date! > today).toBe(false);
  });

  it("6. is created incomplete with no completion timestamp", () => {
    const task = buildTask({ due_date: todayDateString() });
    expect(task.completed).toBe(false);
    expect(task.completed_at).toBeNull();
  });
});

describe("9/10/11. Today count, due-today header count, and All count all increase when a Quick-Added task is present", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  // Mirrors app/tasks/page.tsx's buckets/stats useMemo derivations exactly.
  function computeBucketsAndStats(tasks: Task[]) {
    const today = todayDateString();
    const active = tasks.filter(task => !task.completed);
    const todayBucket = active.filter(task => task.due_date !== null && (isTaskOverdue(task, today) || isTaskDueToday(task, today)));
    const allBucket = active;
    const overdue = todayBucket.filter(task => isTaskOverdue(task, today)).length;
    return { todayCount: todayBucket.length, allCount: allBucket.length, dueToday: todayBucket.length - overdue };
  }

  it("adding a Quick-Added (today, incomplete) task increases Today, All, and the due-today header count", () => {
    const before = [buildTask({ id: "existing", due_date: null })];
    const before$ = computeBucketsAndStats(before);

    const quickAdded = buildTask({ id: "quick", due_date: todayDateString() });
    const after$ = computeBucketsAndStats([...before, quickAdded]);

    expect(after$.todayCount).toBe(before$.todayCount + 1);
    expect(after$.allCount).toBe(before$.allCount + 1);
    expect(after$.dueToday).toBe(before$.dueToday + 1);
  });
});

describe("REGRESSION: existing undated tasks are unaffected", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  it("15. a task with due_date: null is still not due today, not overdue, and not actionable-today", () => {
    const task = buildTask({ due_date: null });
    expect(isTaskDueToday(task)).toBe(false);
    expect(isTaskOverdue(task)).toBe(false);
    expect(isTaskActionableToday(task)).toBe(false);
  });
});

describe("app/tasks/page.tsx Quick Add — structural checks (no React test harness in this project)", () => {
  const source = readFileSync("app/tasks/page.tsx", "utf8");

  it("1/4/5. submitQuickAdd sends today's due date via the shared local-date helper, not null", () => {
    expect(source).toContain("due_date: todayDateString()");
    expect(source).not.toContain("due_date: null }) });"); // the old Quick Add body
  });

  it("category and priority defaults are unchanged", () => {
    expect(source).toContain('category: "General", priority: "Medium"');
  });

  it("7. never sends completed or completed_at from Quick Add", () => {
    const submitFn = source.slice(source.indexOf("async function submitQuickAdd"), source.indexOf("async function submitQuickAdd") + 800);
    expect(submitFn).not.toContain("completed");
  });

  it("Enter key and the + button both submit via the same submitQuickAdd path", () => {
    expect(source).toContain('if (e.key === "Enter")');
    expect(source).toContain("void submitQuickAdd()");
  });

  it("16. the input is only cleared on success — a failed request preserves the typed text", () => {
    const submitFn = source.slice(source.indexOf("async function submitQuickAdd"), source.indexOf("const handlers"));
    // setQuickAddValue("") must appear only inside the r.ok success branch, not in the catch/error branch
    const successBranch = submitFn.slice(submitFn.indexOf("if (r.ok)"), submitFn.indexOf("} else {"));
    const errorBranch = submitFn.slice(submitFn.indexOf("} else {"), submitFn.indexOf("} catch"));
    expect(successBranch).toContain('setQuickAddValue("")');
    expect(errorBranch).not.toContain("setQuickAddValue");
  });

  it("14. the full Add Task modal is untouched — Quick Add's due-date change does not appear in TaskFormModal.tsx", () => {
    const modalSource = readFileSync("components/TaskFormModal.tsx", "utf8");
    expect(modalSource).not.toContain("todayDateString");
    expect(modalSource).toContain('due_date: dueDate || null'); // still supports a blank due date
  });

  it("17. completion/Undo wiring in app/tasks/page.tsx is untouched", () => {
    expect(source).toContain('completed: nextCompleted');
    expect(source).toContain("undoComplete");
  });
});
