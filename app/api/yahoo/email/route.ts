import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server"; import { safeApiError } from "@/lib/auth/api"; import { getEmailSchema } from "@/lib/validation/email"; import { getYahooEmail } from "@/lib/yahoo/client"; import { audit, enforceRateLimit } from "@/lib/security/activity";
export const runtime = "nodejs"; export const maxDuration = 30;
export async function POST(request: Request) { try { const user = await requireOwner(); await enforceRateLimit(user.id, "yahoo_read", 30); const { id } = getEmailSchema.parse(await request.json()); const email = await getYahooEmail(id); await audit(user.id, "email_retrieved", { folder: email.folder, hasAttachments: email.attachments.length > 0 }); return NextResponse.json(email); } catch (error) { return safeApiError(error, "Email could not be retrieved safely."); } }

