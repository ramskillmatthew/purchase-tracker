import "server-only";
import { supabaseRequest } from "@/lib/supabase";

export async function enforceRateLimit(ownerId: string, action: string, limit: number, windowSeconds = 60) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const query = `assistant_rate_limits?owner_id=eq.${encodeURIComponent(ownerId)}&action=eq.${encodeURIComponent(action)}&created_at=gte.${encodeURIComponent(since)}&select=id`;
  const response = await supabaseRequest(query, { headers: { Prefer: "count=exact" } });
  const rows = await response.json() as unknown[];
  if (rows.length >= limit) { const error = new Error("Too many requests. Please wait and try again."); Object.assign(error, { status: 429 }); throw error; }
  await supabaseRequest("assistant_rate_limits", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ owner_id: ownerId, action }) });
}
export async function audit(ownerId: string, action: string, metadata: Record<string, unknown> = {}) {
  try { await supabaseRequest("assistant_action_audit", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ owner_id: ownerId, action, metadata }) }); }
  catch (error) { console.error("Audit write failed", error instanceof Error ? error.name : "UnknownError"); }
}

