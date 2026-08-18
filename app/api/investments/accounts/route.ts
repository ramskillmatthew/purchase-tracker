import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";

export const runtime = "nodejs";

const ACCOUNT_TYPES = ["isa", "gia", "pokemon_collection", "lego_collection", "cash", "other"] as const;

/**
 * Investment accounts are real, user-created rows — never seeded as fake
 * production data (see this feature's own explicit requirement). The
 * first-use "Add investment" flow offers to create a sensible starting
 * account (e.g. "Stocks & Shares ISA") only when the owner has none yet
 * for that category — see app/api/investments/assets/route.ts's own
 * comment — but this route itself never seeds anything on its own.
 */
const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  accountType: z.enum(ACCOUNT_TYPES),
  institution: z.string().trim().max(120).nullable().optional(),
  cashTrackingEnabled: z.boolean().optional().default(false),
}).strict();

type AccountRow = {
  id: string; name: string; account_type: string; institution: string | null;
  reporting_currency: string; cash_tracking_enabled: boolean;
  created_at: string; updated_at: string; archived_at: string | null;
};

function serializeAccount(row: AccountRow) {
  return {
    id: row.id, name: row.name, accountType: row.account_type, institution: row.institution,
    reportingCurrency: row.reporting_currency, cashTrackingEnabled: row.cash_tracking_enabled,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at,
  };
}

export async function GET() {
  try {
    const user = await requireOwner();
    const rows = await supabaseRequestAll<AccountRow>(
      `investment_accounts?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,account_type,institution,reporting_currency,cash_tracking_enabled,created_at,updated_at,archived_at&order=created_at.asc`,
    );
    return NextResponse.json({ accounts: rows.map(serializeAccount) });
  } catch (error) { return safeApiError(error, "Could not load investment accounts."); }
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const body = createAccountSchema.parse(await request.json());

    const response = await supabaseRequest("investment_accounts", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: user.id, name: body.name, account_type: body.accountType,
        institution: body.institution ?? null, cash_tracking_enabled: body.cashTrackingEnabled,
      }),
    });
    const [row] = await response.json() as AccountRow[];
    return NextResponse.json({ account: serializeAccount(row) });
  } catch (error) { return safeApiError(error, "Could not create this investment account."); }
}
