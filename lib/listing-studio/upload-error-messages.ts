/**
 * Translates a POST /api/listing-studio/uploads chunk-registration failure
 * into a user-facing message and a classification GroupingWorkspace.tsx
 * uses to decide whether to keep registering later chunks.
 *
 * Before this fix, EVERY registration failure (including the confirmed
 * root cause — a >60-file request rejected by Zod) surfaced as the single
 * generic string "Invalid request.", with the client's raw `issues` array
 * never shown or interpreted. This module is the one place that turns a
 * structured `{error, reason}` response (see app/api/listing-studio/uploads/route.ts's
 * own `failure()` helper) — or, defensively, a raw Zod `issues` array from
 * an unexpected validation failure — into something a user can actually act
 * on, without ever exposing raw Zod/database error text.
 *
 * Classification:
 *  - "hard_stop": the failure is systemic — every remaining chunk in this
 *    run would fail identically (the workspace is full, the whole request
 *    was malformed, Storage isn't configured, or the user's session is no
 *    longer valid). Registration of further chunks stops; one clear global
 *    banner explains why, and already-registered/uploaded chunks are left
 *    untouched.
 *  - "chunk_only": the failure is scoped to this one chunk (an unexpected
 *    per-file/per-batch validation issue, a 5xx, or a network blip that may
 *    well not repeat). Only this chunk's files are marked failed; the run
 *    continues with the next chunk, and the user can retry the failed files
 *    individually or via "Retry all failed" afterward.
 */

export type UploadFailureReason =
  | "too_many_files"
  | "file_too_large"
  | "batch_too_large"
  | "workspace_capacity_exceeded"
  | "group_limit_exceeded"
  | "storage_unavailable"
  | "unauthorized"
  | "network_error"
  | "unknown";

export type UploadFailureClassification = "hard_stop" | "chunk_only";

export type ParsedUploadFailure = {
  reason: UploadFailureReason;
  message: string;
  classification: UploadFailureClassification;
};

const HARD_STOP_REASONS: ReadonlySet<UploadFailureReason> = new Set([
  "too_many_files", "workspace_capacity_exceeded", "group_limit_exceeded", "storage_unavailable", "unauthorized",
]);

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "too_many_files", "file_too_large", "batch_too_large", "workspace_capacity_exceeded", "group_limit_exceeded", "storage_unavailable",
]);

function isKnownReason(value: unknown): value is UploadFailureReason {
  return typeof value === "string" && KNOWN_REASONS.has(value);
}

type ZodIssue = { path?: unknown; message?: unknown };

/**
 * Best-effort, deliberately narrow translation of a Zod `issues` array
 * (see lib/auth/api.ts's safeApiError) into one readable sentence — never
 * the raw path/message pairs. Only reached when the server returned a
 * generic "Invalid request." with no structured `reason` (i.e. an
 * unexpected shape failure this module's own known-reason list doesn't
 * cover) — a defensive fallback, not the primary path.
 */
function describeIssues(issues: ZodIssue[]): string | null {
  if (!issues.length) return null;
  const filesIssue = issues.find(issue => Array.isArray(issue.path) && issue.path[0] === "files");
  if (filesIssue) return "This upload group contains too many files or one of them is invalid. It will be divided into smaller batches automatically — please try again.";
  return "Some of the selected files could not be registered. Please try again.";
}

/**
 * `status === 0` (or no response at all) signals a network-level failure —
 * `fetch` itself threw rather than the server returning any HTTP response.
 */
export function parseRegistrationFailure(status: number, body: unknown): ParsedUploadFailure {
  if (status === 0) {
    return { reason: "network_error", message: "Network error — please retry.", classification: "chunk_only" };
  }
  if (status === 401 || status === 403) {
    return { reason: "unauthorized", message: "Your session has expired. Please sign in again and retry.", classification: "hard_stop" };
  }

  const record = (body && typeof body === "object" ? body : {}) as { error?: unknown; reason?: unknown; issues?: ZodIssue[] };
  if (isKnownReason(record.reason)) {
    const message = typeof record.error === "string" && record.error.trim() ? record.error : "This batch could not be registered.";
    return { reason: record.reason, message, classification: HARD_STOP_REASONS.has(record.reason) ? "hard_stop" : "chunk_only" };
  }

  if (Array.isArray(record.issues)) {
    const message = describeIssues(record.issues) ?? "Some of the selected files could not be registered. Please try again.";
    return { reason: "unknown", message, classification: "chunk_only" };
  }

  const message = typeof record.error === "string" && record.error.trim() && record.error !== "Invalid request." ? record.error : "Could not register these photos. Please try again.";
  return { reason: "unknown", message, classification: "chunk_only" };
}
