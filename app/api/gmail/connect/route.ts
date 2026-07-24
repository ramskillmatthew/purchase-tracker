import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { googleAuthorizationUrl } from "@/lib/gmail/oauth";
export async function GET(request:Request){try{const user=await requireOwner();return NextResponse.redirect(await googleAuthorizationUrl(user.id,new URL(request.url).origin));}catch(error){return safeApiError(error,"Gmail connection could not be started.");}}
