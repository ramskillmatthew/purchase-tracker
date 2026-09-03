import "server-only";
import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import type { ApiErrorKind } from "@/lib/returns/api-contract";
import { API_ERROR_STATUS } from "@/lib/returns/api-contract";

/** Typed error envelope, identical across every returns/losses endpoint.
 * Public errors never carry DB detail — only a safe message. */
export function apiError(kind: ApiErrorKind, message: string, extra?: { conflictingPurchaseIds?: string[]; issues?: { path: string; message: string }[] }) {
  return NextResponse.json({ error: message, kind, ...extra }, { status: API_ERROR_STATUS[kind] });
}

/**
 * Calls one of the migration's transactional appliers via PostgREST rpc/.
 * The whole multi-table transition happens inside that ONE function, so a
 * partial failure is impossible. A PostgREST 409 here is an
 * idempotency-key/unique conflict inside the function (already-applied);
 * callers decide whether that is success or a surfaced conflict. A raised
 * PL/pgSQL exception whose message we recognise ('not_found',
 * 'stock_conflict', 'return_cancelled') is re-classified; anything else
 * propagates to safeApiError as an opaque 500.
 */
export type RpcOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "not_found" | "conflict"; message: string; conflictingPurchaseIds?: string[] };

export async function callTransition<T>(fn: string, body: Record<string, unknown>): Promise<RpcOutcome<T>> {
  try {
    const response = await supabaseRequest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(body) });
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not_found/i.test(message)) return { ok: false, kind: "not_found", message: "Record not found." };
    if (/return_cancelled/i.test(message)) return { ok: false, kind: "conflict", message: "This return was cancelled and cannot be modified. Log a new return instead." };
    if (/stock_conflict/i.test(message)) {
      const detail = /DETAIL:\s*([0-9a-f -]+)/i.exec(message)?.[1]?.trim();
      const ids = detail ? detail.split(/\s+/).filter(Boolean) : [];
      return { ok: false, kind: "conflict", message: "One or more affected units have changed stock state since this record was applied (e.g. sold again). Resolve the stock conflict before continuing.", conflictingPurchaseIds: ids };
    }
    throw error; // opaque -> safeApiError -> 500, no DB detail leaked
  }
}

/** A scalar-returning Postgres function (returns text) comes back from
 * PostgREST as a bare JSON string. */
export async function nextReference(ownerId: string, kind: "return" | "loss"): Promise<string> {
  const response = await supabaseRequest("rpc/next_return_loss_reference", { method: "POST", body: JSON.stringify({ p_owner_id: ownerId, p_kind: kind }) });
  return (await response.json()) as string;
}

export function auditEvent(eventType: string, actor: string | null, detail: Record<string, unknown>) {
  return { event_type: eventType, actor, detail };
}
