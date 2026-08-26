import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { runRefresh } from "@/lib/investments/refresh";

export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Daily scheduled refresh — mirrors app/api/cron/yahoo-index/route.ts's own
 * "single-tenant app, find the one owner" pattern and CRON_SECRET auth
 * convention exactly. A bounded (limit=1) lookup via supabaseRequest()
 * directly, never supabaseRequestAll() (which forbids an explicit limit=
 * — see lib/supabase.ts's own REGRESSION GUARD).
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const response = await supabaseRequest("investment_accounts?select=owner_id&limit=1");
    const rows = await response.json() as { owner_id: string }[];
    if (!rows[0]) return NextResponse.json({ skipped: "no_accounts_yet" });
    const result = await runRefresh(rows[0].owner_id, "cron");
    return NextResponse.json(result);
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Refresh failed." }, { status: 500 }); }
}
