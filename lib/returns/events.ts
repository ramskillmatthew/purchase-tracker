/**
 * A returns/losses mutation (log / advance / complete / cancel / delete / edit,
 * or a permanent sale deletion that removed inactive return history) changes
 * figures the Home dashboard and the Sales page also show — active-return
 * net-profit impact, Sales Overview status, pending counts. Those pages fetch
 * on their own with plain `fetch`, so this lightweight window event tells them
 * to re-fetch, mirroring lib/tasks.ts's `TASKS_CHANGED_EVENT` pattern (no
 * shared store). Fire it AFTER a mutation's response is OK.
 */
export const RETURNS_CHANGED_EVENT = "returns-losses-changed";

export function broadcastReturnsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(RETURNS_CHANGED_EVENT));
}
