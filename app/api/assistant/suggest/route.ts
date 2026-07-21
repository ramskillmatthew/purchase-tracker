import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { assistantRequestSchema } from "@/lib/validation/email";
import { suggestSearchCorrection } from "@/lib/anthropic/assistant";
import { audit, enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    await enforceRateLimit(user.id, "assistant_suggestion", 20);
    const { message } = assistantRequestSchema.parse(await request.json());
    const result = await suggestSearchCorrection(message);
    await audit(user.id, "assistant_spelling_checked", { characterCount: message.length, changed: result.changed });
    return NextResponse.json(result);
  } catch (error) {
    return safeApiError(error, "The spelling check could not be completed safely.");
  }
}
