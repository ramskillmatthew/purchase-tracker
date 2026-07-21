import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server"; import { safeApiError } from "@/lib/auth/api";
import { emailSearchSchema } from "@/lib/validation/email"; import { searchYahoo } from "@/lib/yahoo/client"; import { audit, enforceRateLimit } from "@/lib/security/activity";
export const runtime = "nodejs"; export const maxDuration = 30;
export async function POST(request: Request) { try { const user = await requireOwner(); await enforceRateLimit(user.id, "yahoo_search", 20); const criteria = emailSearchSchema.parse(await request.json()); const result = await searchYahoo(criteria); await audit(user.id, "search_performed", { resultCount: result.results.length, hasDateRange: Boolean(criteria.startDate || criteria.endDate), folder: criteria.folder || "all" }); return NextResponse.json(result); } catch (error) { return safeApiError(error, "Yahoo search could not be completed safely."); } }

