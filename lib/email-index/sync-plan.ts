// Pure orchestration logic for indexed-email sync runs. Deliberately has no
// "server-only" import and no direct network/IMAP calls, so the mutex,
// stale-lock recovery, and completion-honesty rules can be unit tested with
// fake deps. lib/email-index/sync.ts wires the real Supabase/IMAP calls.
//
// Every request is split at the today/yesterday boundary:
//  - The historical portion (strictly before today, if any) is proven
//    complete against a FROZEN per-run high-water UID snapshot — see
//    scanYahooMetadataWithCursor. It is only ever marked "completed" once
//    every folder's snapshot has been fully drained.
//  - Today (if requested) is never marked "completed" — it is perpetually
//    refreshable: every pass recaptures a fresh high-water UID, so mail
//    arriving later the same day is picked up incrementally rather than
//    being permanently missed once an earlier pass looked "done".
// There is no message-count cap that stands in for proof of completeness
// in either mode.

export const STANDARD_SCAN_LIMIT = 1500;
// Comfortably past the sync routes' 60s maxDuration, so a run that
// legitimately finishes is never mistaken for stale, but a crashed run is
// reclaimed promptly rather than blocking every future sync indefinitely.
export const STALE_RUNNING_MS = 5 * 60 * 1000;

export function isStaleRunning(createdAt: string, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(createdAt) > STALE_RUNNING_MS;
}

function addDays(date: string, days: number) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }

export type FolderProgress = { lastUid: number; highWaterUid: number; uidValidity: string };
export type FolderCursor = Record<string, FolderProgress>;
export type ScanResult = { rows: unknown[]; cursor: FolderCursor; done: boolean; foldersSearched: number };

export type PassOutcome =
  | { status: "skipped"; reason: "already_running" }
  | { status: "completed"; rangeStart: string; rangeEnd: string; indexed: number }
  | { status: "partial"; rangeStart: string; rangeEnd: string; indexed: number; note: string }
  | { status: "failed"; rangeStart: string; rangeEnd: string; reason: string };

/** `historical`/`today` are null when that portion wasn't part of the requested range at all. */
export type SyncOutcome = {
  historical: PassOutcome | { status: "already_covered" } | null;
  today: PassOutcome | null;
};

export type SyncDeps = {
  firstUncoveredDate(start: string, end: string): Promise<string | null>;
  reapStaleRunning(): Promise<void>;
  /**
   * Claims the coverage row for exactly [start, end]: transitions an
   * existing partial/failed row to running, or creates a new row if none
   * exists. Returns null if another run already holds the per-owner mutex
   * (or, in the rare case of a race, if the range was claimed first by a
   * concurrent request).
   */
  beginOrResumeRun(start: string, end: string): Promise<string | null>;
  /** The cursor saved for exactly [start, end], if any prior pass exists. */
  findCursor(start: string, end: string): Promise<FolderCursor | null>;
  scan(start: string, end: string, cursor: FolderCursor, limit: number, openEnded: boolean): Promise<ScanResult>;
  /** Classifies, maps, and upserts rows; returns how many were indexed. */
  indexRows(rows: unknown[]): Promise<number>;
  markCompleted(coverageId: string, start: string, end: string, messagesIndexed: number): Promise<void>;
  markPartial(coverageId: string, start: string, end: string, cursor: FolderCursor, messagesIndexed: number): Promise<void>;
  markFailed(coverageId: string, reason: string): Promise<void>;
};

async function runOnePass(start: string, end: string, openEnded: boolean, deps: SyncDeps): Promise<PassOutcome> {
  await deps.reapStaleRunning();
  const coverageId = await deps.beginOrResumeRun(start, end);
  if (!coverageId) return { status: "skipped", reason: "already_running" };

  try {
    const priorCursor = (await deps.findCursor(start, end)) || {};
    const scanned = await deps.scan(start, end, priorCursor, STANDARD_SCAN_LIMIT, openEnded);
    const indexed = await deps.indexRows(scanned.rows);
    if (!openEnded && scanned.done) {
      await deps.markCompleted(coverageId, start, end, indexed);
      return { status: "completed", rangeStart: start, rangeEnd: end, indexed };
    }
    const note = openEnded
      ? `Indexed ${indexed} new message${indexed === 1 ? "" : "s"} for ${start}. This keeps refreshing automatically as more arrive today.`
      : `Indexed ${indexed} message${indexed === 1 ? "" : "s"} this pass for ${start} to ${end}; more remain. This continues automatically on the next sync.`;
    await deps.markPartial(coverageId, start, end, scanned.cursor, indexed);
    return { status: "partial", rangeStart: start, rangeEnd: end, indexed, note };
  } catch (error) {
    await deps.markFailed(coverageId, "Email metadata sync failed safely.");
    throw error;
  }
}

export async function planAndRunSync(requestedStart: string, requestedEnd: string, today: string, deps: SyncDeps): Promise<SyncOutcome> {
  const yesterday = addDays(today, -1);
  const historicalEnd = requestedEnd < today ? requestedEnd : yesterday;
  const includesToday = requestedEnd >= today;

  let historical: SyncOutcome["historical"] = null;
  if (requestedStart <= historicalEnd) {
    const effectiveStart = await deps.firstUncoveredDate(requestedStart, historicalEnd);
    historical = effectiveStart ? await runOnePass(effectiveStart, historicalEnd, false, deps) : { status: "already_covered" };
  }

  let today_: PassOutcome | null = null;
  if (includesToday) {
    today_ = await runOnePass(today, today, true, deps);
  }

  return { historical, today: today_ };
}
