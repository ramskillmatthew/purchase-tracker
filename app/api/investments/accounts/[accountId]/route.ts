import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  institution: z.string().trim().max(120).nullable().optional(),
  cashTrackingEnabled: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict();

/**
 * Archiving is soft-delete only (archived_at timestamp) — an account with
 * real transaction history is never hard-deleted, matching this feature's
 * explicit "never casually cascade-delete financial history" requirement.
 * Un-archiving (archived: false) is also supported, so an accidental
 * archive is trivially reversible.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const user = await requireOwner();
    const { accountId } = await params;
    if (!uuidSchema.safeParse(accountId).success) return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
    const body = updateAccountSchema.parse(await request.json());

    const existing = await supabaseRequestAll<{ id: string }>(`investment_accounts?id=eq.${accountId}&owner_id=eq.${user.id}&select=id`);
    if (!existing[0]) return NextResponse.json({ error: "Account not found." }, { status: 404 });

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.institution !== undefined) patch.institution = body.institution;
    if (body.cashTrackingEnabled !== undefined) patch.cash_tracking_enabled = body.cashTrackingEnabled;
    if (body.archived !== undefined) patch.archived_at = body.archived ? new Date().toISOString() : null;

    await supabaseRequest(`investment_accounts?id=eq.${accountId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    return NextResponse.json({ accountId, archived: body.archived ?? null });
  } catch (error) { return safeApiError(error, "Could not update this account."); }
}
