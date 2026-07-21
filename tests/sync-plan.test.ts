import { describe, expect, it } from "vitest";
import { firstUncoveredDate, hasFullCoverage, type CompletedRange } from "@/lib/email-index/coverage-gaps";
import { isStaleRunning, planAndRunSync, type FolderCursor, type ScanResult, type SyncDeps } from "@/lib/email-index/sync-plan";

/** Deterministically simulates ascending-UID cursor pagination against a
 * mutable "live mailbox" per folder — mirroring scanYahooMetadataWithCursor's
 * real contract: for a closed (non-open-ended) range, the high-water UID is
 * captured once and frozen; for an open-ended range (today), it is
 * recaptured fresh every pass so newly arrived mail raises the ceiling. */
function makeMailbox(initialTotals: Record<string, number>) {
  const totals = { ...initialTotals };
  const uidValidity: Record<string, string> = Object.fromEntries(Object.keys(initialTotals).map(folder => [folder, "v1"]));
  const scan = async (_start: string, _end: string, cursor: FolderCursor, limit: number, openEnded: boolean): Promise<ScanResult> => {
    const nextCursor: FolderCursor = { ...cursor };
    const rows: unknown[] = [];
    let budget = limit;
    let allDone = true;
    for (const folder of Object.keys(totals)) {
      const existing = cursor[folder];
      if (!openEnded && existing && existing.lastUid >= existing.highWaterUid) continue;
      if (budget <= 0) { allDone = false; continue; }
      const validityMatches = Boolean(existing && existing.uidValidity === uidValidity[folder]);
      const liveHighWater = totals[folder]; // "highest uid that exists in the live mailbox right now"
      const highWaterUid = !openEnded && validityMatches ? existing!.highWaterUid : liveHighWater;
      const lastUid = validityMatches ? existing!.lastUid : 0;
      const pending = Array.from({ length: highWaterUid }, (_, index) => index + 1).filter(uid => uid > lastUid);
      const selected = pending.slice(0, budget);
      selected.forEach(uid => rows.push({ folder, uid }));
      budget -= selected.length;
      const newLastUid = selected.length ? selected[selected.length - 1] : lastUid;
      nextCursor[folder] = { lastUid: newLastUid, highWaterUid, uidValidity: uidValidity[folder] };
      if (openEnded || newLastUid < highWaterUid) allDone = false;
    }
    return { rows, cursor: nextCursor, done: allDone, foldersSearched: Object.keys(totals).length };
  };
  return {
    scan,
    arriveMail(folder: string, count: number) { totals[folder] = (totals[folder] || 0) + count; },
    changeUidValidity(folder: string) { uidValidity[folder] = `v${Math.random()}`; totals[folder] = totals[folder]; },
  };
}

type FakeState = {
  completed: CompletedRange[];
  rows: Map<string, { status: "running" | "partial" | "failed"; cursor: FolderCursor | null }>; // key = `${start}|${end}`
  running: boolean;
  runningCreatedAt: string;
  scanCalls: unknown[];
  indexRowsCalls: unknown[][];
  markCompletedCalls: { start: string; end: string; count: number }[];
  markPartialCalls: { start: string; end: string; cursor: FolderCursor; count: number }[];
  markFailedCalls: { reason: string }[];
};

function key(start: string, end: string) { return `${start}|${end}`; }

function makeFakeDeps(scan: SyncDeps["scan"], now: () => Date = () => new Date("2026-07-20T12:00:00Z")) {
  const state: FakeState = { completed: [], rows: new Map(), running: false, runningCreatedAt: "", scanCalls: [], indexRowsCalls: [], markCompletedCalls: [], markPartialCalls: [], markFailedCalls: [] };
  const deps: SyncDeps = {
    async firstUncoveredDate(start, end) { return firstUncoveredDate(state.completed, start, end); },
    async reapStaleRunning() { if (state.running && isStaleRunning(state.runningCreatedAt, now())) state.running = false; },
    async beginOrResumeRun(start, end) {
      if (state.running) return null;
      const k = key(start, end);
      const row = state.rows.get(k);
      if (row && (row.status === "partial" || row.status === "failed")) { row.status = "running"; state.running = true; state.runningCreatedAt = now().toISOString(); return k; }
      if (state.rows.has(k)) return null; // a row exists but isn't partial/failed (e.g. completed) — shouldn't normally be requested again
      state.rows.set(k, { status: "running", cursor: null });
      state.running = true; state.runningCreatedAt = now().toISOString();
      return k;
    },
    async findCursor(start, end) { return state.rows.get(key(start, end))?.cursor || null; },
    async scan(start, end, cursor, limit, openEnded) { state.scanCalls.push({ start, end, cursor, limit, openEnded }); return scan(start, end, cursor, limit, openEnded); },
    async indexRows(rows) { state.indexRowsCalls.push(rows); return rows.length; },
    async markCompleted(id, start, end, count) { state.markCompletedCalls.push({ start, end, count }); state.completed.push({ range_start: start, range_end: end }); state.rows.delete(id); state.running = false; },
    async markPartial(id, start, end, cursor, count) { state.markPartialCalls.push({ start, end, cursor, count }); state.rows.set(id, { status: "partial", cursor }); state.running = false; },
    async markFailed(id, reason) { state.markFailedCalls.push({ reason }); const row = state.rows.get(id); if (row) row.status = "failed"; state.running = false; },
  };
  return { deps, state };
}

describe("sync-plan: a new message in a previously-drained folder is not silently skipped", () => {
  it("excludes mail that arrives in an already-drained folder from the frozen snapshot, rather than falsely completing", async () => {
    const mailbox = makeMailbox({ Inbox: 1000, Archive: 1000 }); // 2000 total, over the 1500 cap
    const { deps, state } = makeFakeDeps(mailbox.scan);

    const first = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(first.historical?.status).toBe("partial"); // Inbox (1000) drains fully; Archive gets the remaining 500 of budget

    // New mail arrives in Inbox — already frozen as "done" for this run — while Archive is still being paginated.
    mailbox.arriveMail("Inbox", 50);

    const second = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(second.historical?.status).toBe("completed"); // Archive's remaining 500 finish; Inbox's frozen snapshot (1000) is not reopened
    if (second.historical?.status !== "completed") throw new Error("unreachable");
    expect(second.historical.indexed).toBe(500); // only Archive's remainder, not Inbox's new 50
    expect(state.indexRowsCalls.flat().length).toBe(2000); // 1000 (Inbox) + 500 + 500 (Archive) — the new 50 were correctly excluded
    expect(state.completed).toEqual([{ range_start: "2026-07-01", range_end: "2026-07-05" }]);
  });
});

describe("sync-plan: today is always refreshed for newly arrived mail", () => {
  it("never marks a range including today as completed, and keeps picking up new mail on later passes", async () => {
    const mailbox = makeMailbox({ Inbox: 10 });
    const { deps, state } = makeFakeDeps(mailbox.scan);

    const first = await planAndRunSync("2026-07-20", "2026-07-20", "2026-07-20", deps);
    expect(first.today?.status).toBe("partial"); // today is never "completed", even though everything currently present was indexed
    if (first.today?.status !== "partial") throw new Error("unreachable");
    expect(first.today.indexed).toBe(10);
    expect(state.markCompletedCalls.length).toBe(0);

    mailbox.arriveMail("Inbox", 5); // new mail arrives later the same day
    const second = await planAndRunSync("2026-07-20", "2026-07-20", "2026-07-20", deps);
    expect(second.today?.status).toBe("partial");
    if (second.today?.status !== "partial") throw new Error("unreachable");
    expect(second.today.indexed).toBe(5); // only the incremental new mail, not a re-fetch of the first 10
    expect(state.markCompletedCalls.length).toBe(0); // today is still never marked completed
  });

  it("does not let already-covered clamping block a later cron-style run from rescanning today", async () => {
    // A historical range ending in a completed row must not make today itself look "already covered".
    const mailbox = makeMailbox({ Inbox: 3 });
    const { deps, state } = makeFakeDeps(mailbox.scan);
    state.completed.push({ range_start: "2026-07-01", range_end: "2026-07-19" }); // everything through yesterday already completed
    expect(hasFullCoverage(state.completed, "2026-07-01", "2026-07-19")).toBe(true);

    const outcome = await planAndRunSync("2026-07-20", "2026-07-20", "2026-07-20", deps);
    expect(outcome.historical).toBeNull(); // nothing historical was requested
    expect(outcome.today?.status).toBe("partial"); // today was still attempted, not skipped as "already covered"
    expect(state.scanCalls.length).toBe(1);
  });
});

describe("sync-plan: UIDVALIDITY changes mid-sync are handled safely", () => {
  it("discards a stale frozen snapshot and recaptures fresh when a folder's UIDVALIDITY changes between passes", async () => {
    const mailbox = makeMailbox({ Inbox: 2000 }); // over the 1500 cap, needs 2 passes from a cold start
    const { deps, state } = makeFakeDeps(mailbox.scan);

    const first = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(first.historical?.status).toBe("partial");
    if (first.historical?.status !== "partial") throw new Error("unreachable");
    expect(first.historical.indexed).toBe(1500);

    mailbox.changeUidValidity("Inbox"); // e.g. a server-side mailbox migration renumbers UIDs

    // The stale cursor (uidValidity mismatch) is discarded and the folder is
    // rescanned from scratch under the new epoch, rather than either
    // silently trusting stale UIDs (which could skip real messages) or
    // permanently failing. This costs extra passes — reprocessing what pass
    // 1 already saw — but never drops anything and never completes falsely.
    let outcome = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    let iterations = 2;
    while (outcome.historical?.status !== "completed" && iterations < 10) {
      outcome = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
      iterations += 1;
    }
    expect(outcome.historical?.status).toBe("completed");
    expect(iterations).toBe(3); // pass 1 (old epoch, 1500) + pass 2 (new epoch, 1500) + pass 3 (new epoch, remaining 500)
    expect(state.indexRowsCalls.flat().length).toBe(3500); // redundant reprocessing of the first 1500 under the new epoch is expected and safe (idempotent upsert)
  });
});

describe("sync-plan: repeated resumptions use one authoritative checkpoint", () => {
  it("continues the same checkpoint across multiple passes rather than starting over each time", async () => {
    const mailbox = makeMailbox({ Inbox: 4000 }); // needs 3 passes of 1500/1500/1000
    const { deps, state } = makeFakeDeps(mailbox.scan);
    let outcome = await planAndRunSync("2026-07-01", "2026-07-10", "2026-07-20", deps);
    let iterations = 1;
    while (outcome.historical?.status !== "completed" && iterations < 10) {
      outcome = await planAndRunSync("2026-07-01", "2026-07-10", "2026-07-20", deps);
      iterations += 1;
    }
    expect(iterations).toBe(3);
    expect(state.rows.size).toBe(0); // the row was reused and cleared on completion — never accumulated as multiple rows
    expect(state.indexRowsCalls.flat().length).toBe(4000);
    expect(hasFullCoverage(state.completed, "2026-07-01", "2026-07-10")).toBe(true);
  });

  it("does not retry an already-completed range on a later request for the same span", async () => {
    const mailbox = makeMailbox({ Inbox: 10 });
    const { deps } = makeFakeDeps(mailbox.scan);
    const first = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(first.historical?.status).toBe("completed");
    const second = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(second.historical).toEqual({ status: "already_covered" });
  });
});

describe("sync-plan: no false completion when mailbox contents change during pagination", () => {
  it("keeps a range that never fully drains as partial forever, never completed", async () => {
    const { deps, state } = makeFakeDeps(async () => ({ rows: [{}], cursor: { Inbox: { lastUid: 1, highWaterUid: 999_999, uidValidity: "v1" } }, done: false, foldersSearched: 1 }));
    for (let i = 0; i < 5; i++) {
      const outcome = await planAndRunSync("2026-07-01", "2026-07-01", "2026-07-20", deps);
      expect(outcome.historical?.status).toBe("partial");
    }
    expect(state.markCompletedCalls.length).toBe(0);
    expect(state.completed.length).toBe(0);
  });
});

describe("sync-plan: mutex and stale-lock recovery", () => {
  it("safely rejects a simultaneous sync attempt without touching scan or coverage", async () => {
    const mailbox = makeMailbox({ Inbox: 10 });
    const { deps, state } = makeFakeDeps(mailbox.scan, () => new Date("2026-07-20T12:00:00Z"));
    state.running = true; state.runningCreatedAt = "2026-07-20T11:59:00Z"; // one minute old — not stale
    const outcome = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(outcome.historical).toEqual({ status: "skipped", reason: "already_running" });
    expect(state.scanCalls.length).toBe(0);
    expect(state.indexRowsCalls.length).toBe(0);
  });

  it("recovers a stale running lock left by a crashed run and proceeds normally", async () => {
    const now = () => new Date("2026-07-20T12:00:00Z");
    const mailbox = makeMailbox({ Inbox: 10 });
    const { deps, state } = makeFakeDeps(mailbox.scan, now);
    state.running = true; state.runningCreatedAt = "2026-07-20T06:00:00Z"; // 6 hours old — well past the 5 minute staleness threshold
    const outcome = await planAndRunSync("2026-07-01", "2026-07-05", "2026-07-20", deps);
    expect(outcome.historical?.status).toBe("completed");
    expect(state.markCompletedCalls.length).toBe(1);
  });

  it("isStaleRunning matches the 5-minute threshold exactly at the boundary", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    expect(isStaleRunning("2026-07-20T11:56:00Z", now)).toBe(false); // 4 minutes old
    expect(isStaleRunning("2026-07-20T11:54:00Z", now)).toBe(true); // 6 minutes old
  });
});
