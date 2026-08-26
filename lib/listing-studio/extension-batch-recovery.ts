// Follow-up correction (orphaned extension batch recovery) — pure,
// DB-free classification helpers shared between the API routes that
// surface "is this batch stuck/hidden/recoverable" decisions to the UI.
// The actual ENFORCEMENT of "never revive a genuinely active batch" lives
// in the database (rpc/listing_studio_recover_stuck_extension_batch, see
// supabase-listing-studio.sql) — these helpers exist so the API layer and
// the UI can make the SAME judgement call for display purposes (which
// button to offer, what the recovery dialog shows) without duplicating or
// drifting from that RPC's own logic. Mirrors this codebase's own
// established convention of a pure `lib/` helper backing a DB-enforced
// invariant (see extension-workflow-status.ts's isBatchStatusTerminal).

// How long a batch may go without a genuine extension report before it's
// eligible for ordinary (non-forced) recovery — matches the RPC's own
// hardcoded `interval '10 minutes'`. Kept as an explicit, named constant
// here (rather than a bare literal) so the UI's own "last activity X
// minutes ago" framing and the create-conflict response's `isStale` flag
// can never silently drift from what the database actually enforces.
export const EXTENSION_ACTIVITY_STALE_SECONDS = 10 * 60;

export const NONTERMINAL_BATCH_STATUSES = ["pending_claim", "claimed", "in_progress"] as const;
export function isBatchStatusNonterminal(status: string): boolean {
  return (NONTERMINAL_BATCH_STATUSES as readonly string[]).includes(status);
}

export type BatchActivitySnapshot = {
  status: string;
  expiresAt: string;
  lastExtensionActivityAt: string | null;
};

/**
 * Mirrors the RPC's own `v_genuinely_active` computation exactly: a batch
 * is genuinely still active only while it's nonterminal, hasn't yet hit
 * its own expires_at, AND has reported genuine extension activity within
 * the stale window. Never true for a terminal batch, regardless of any
 * other field — a completed/cancelled/expired batch is never "genuinely
 * active" no matter how recent its last_extension_activity_at happens to
 * be (that would just be a late/duplicate report arriving after the fact).
 */
export function isBatchGenuinelyActive(batch: BatchActivitySnapshot, nowMs: number, staleSeconds = EXTENSION_ACTIVITY_STALE_SECONDS): boolean {
  if (!isBatchStatusNonterminal(batch.status)) return false;
  if (new Date(batch.expiresAt).getTime() <= nowMs) return false;
  if (!batch.lastExtensionActivityAt) return false;
  return new Date(batch.lastExtensionActivityAt).getTime() > nowMs - staleSeconds * 1000;
}

export type RecoverableBatchClassification = {
  /** Nonterminal (pending_claim/claimed/in_progress) — still capable of locking a draft. */
  isNonterminal: boolean;
  /** box_dismissed_at is set on a still-nonterminal batch — invisible in the ordinary grid despite still locking drafts. */
  isHidden: boolean;
  /** Nonterminal, not hidden, but no fresh genuine extension activity — recoverable without a hidden-batch caveat. */
  isStale: boolean;
  /** True whenever recovery (ordinary, unforced) should be OFFERED at all — hidden OR stale, while still nonterminal. */
  isRecoverable: boolean;
};

export function classifyBatchForRecovery(
  batch: BatchActivitySnapshot & { boxDismissedAt: string | null },
  nowMs: number,
): RecoverableBatchClassification {
  const isNonterminal = isBatchStatusNonterminal(batch.status);
  if (!isNonterminal) return { isNonterminal: false, isHidden: false, isStale: false, isRecoverable: false };
  const isHidden = batch.boxDismissedAt !== null;
  const isStale = !isBatchGenuinelyActive(batch, nowMs);
  return { isNonterminal, isHidden, isStale, isRecoverable: isHidden || isStale };
}
