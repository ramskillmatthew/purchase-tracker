import { NextResponse } from "next/server"; import { requireOwner } from "@/lib/auth/server"; import { safeApiError } from "@/lib/auth/api"; import { supabaseRequest } from "@/lib/supabase"; import { audit } from "@/lib/security/activity"; import { z } from "zod";
const isSellerNotification = (subject: string) => /(?:you(?:'|’)?ve sold an item|your item (?:has )?sold|item sold on vinted)/i.test(subject);
// Default view shows only rows still awaiting a decision. `?status=rejected`
// shows the rejected list (for restoring); `?status=all` shows every
// not-yet-imported row regardless of status (pending or rejected) — the
// same `neq.imported` scope the sync/import routes already rely on for
// duplicate-prevention semantics.
function statusFilter(status: string) {
  if (status === "all") return "import_status=neq.imported";
  if (status === "rejected") return "import_status=eq.rejected";
  return "import_status=eq.pending";
}
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const requested = new URL(request.url).searchParams.get("status") || "pending";
    const status = ["pending", "rejected", "all"].includes(requested) ? requested : "pending";
    const response = await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&${statusFilter(status)}&select=*&order=email_date.desc&limit=200`);
    const rows = await response.json() as { subject: string }[];
    return NextResponse.json(rows.filter(row => !isSellerNotification(row.subject)));
  } catch (error) { return safeApiError(error, "Could not load Vinted candidates."); }
}

// The persisted shape of a reviewer's in-progress edit — mirrors the
// review UI's own `Edit` type (minus the ephemeral `selected` checkbox
// state, which is never worth persisting). Kept as loosely-typed strings
// (matching raw form input) since this is only ever restored back into the
// form; app/api/vinted/import/route.ts's own editSchema/purchaseInputSchema
// remain the actual validation gate at import time.
const draftSchema = z.object({
  purchased_from: z.string().max(100), sku: z.string().max(100), item_description: z.string().max(500),
  seller_name: z.string().max(200), item_size: z.string().max(100), item_condition: z.string().max(100),
  price_purchased: z.string().max(20), order_date: z.string().max(20), arrived: z.enum(["", "true", "false"]),
}).strict();

const patchSchema = z.discriminatedUnion("action", [
  z.object({ id: z.string().uuid(), action: z.literal("reject") }).strict(),
  z.object({ id: z.string().uuid(), action: z.literal("restore") }).strict(),
  // Persists the reviewer's edit server-side (see the `draft` column added
  // in supabase-purchase-import-v2.sql) so it survives a page reload or
  // another sync — the sync route never writes to this column, so nothing
  // it does can overwrite a saved draft.
  z.object({ id: z.string().uuid(), action: z.literal("save_draft"), draft: draftSchema }).strict(),
]);

/**
 * Reject/restore (soft — `import_status` moves to `'rejected'`/`'pending'`,
 * both already valid values in the existing DB check constraint, rather
 * than deleting the row) and save_draft (persists the reviewer's edit)
 * share one owner-scoped, existence-checked PATCH endpoint. The hard
 * DELETE endpoint below is kept as a separate, secondary "permanently
 * remove" action — nothing existing is taken away.
 */
export async function PATCH(request: Request) {
  try {
    const user = await requireOwner();
    const parsed = patchSchema.parse(await request.json());
    const existing = await (await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&id=eq.${parsed.id}&import_status=neq.imported&select=id`)).json() as { id: string }[];
    if (!existing.length) return NextResponse.json({ error: "Candidate was not found or has already been imported." }, { status: 404 });

    if (parsed.action === "save_draft") {
      await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&id=eq.${parsed.id}`, { method: "PATCH", body: JSON.stringify({ draft: parsed.draft, updated_at: new Date().toISOString() }) });
      return NextResponse.json({ id: parsed.id, saved: true });
    }

    const nextStatus = parsed.action === "reject" ? "rejected" : "pending";
    await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&id=eq.${parsed.id}`, { method: "PATCH", body: JSON.stringify({ import_status: nextStatus, updated_at: new Date().toISOString() }) });
    await audit(user.id, parsed.action === "reject" ? "import_rejected" : "import_restored", { scope: "single", candidateId: parsed.id, method: "status" });
    return NextResponse.json({ id: parsed.id, status: nextStatus });
  } catch (error) { return safeApiError(error, "Could not update the Vinted candidate."); }
}

export async function DELETE(request: Request) { try { const user = await requireOwner(); const params = new URL(request.url).searchParams; if (params.get("clear") === "all") { const existing = await (await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&import_status=neq.imported&select=id`)).json() as { id: string }[]; await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&import_status=neq.imported`, { method: "DELETE" }); await audit(user.id, "import_rejected", { scope: "all_unimported", count: existing.length, method: "delete" }); return NextResponse.json({ deleted: existing.length }); }
    const id = z.string().uuid().parse(params.get("id")); const existing = await (await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&id=eq.${id}&import_status=neq.imported&select=id`)).json() as { id: string }[]; if (!existing.length) return NextResponse.json({ error: "Candidate was not found or has already been imported." }, { status: 404 }); await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&id=eq.${id}&import_status=neq.imported`, { method: "DELETE" }); await audit(user.id, "import_rejected", { scope: "single", candidateId: id, method: "delete" }); return NextResponse.json({ deleted: 1 });
  } catch (error) { return safeApiError(error, "Could not delete Vinted candidate."); } }
