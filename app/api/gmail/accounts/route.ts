import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { gmailAccessToken,gmailAccounts,gmailProfile } from "@/lib/gmail/oauth";
import { supabaseRequest } from "@/lib/supabase";
import { z } from "zod";
export async function GET(){try{const user=await requireOwner();const accounts=await gmailAccounts(user.id);return NextResponse.json({configured:Boolean(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_TOKEN_ENCRYPTION_KEY),accounts:accounts.map(({id,email_address,status,created_at})=>({id,emailAddress:email_address,status,connectedAt:created_at}))});}catch(error){return safeApiError(error);}}
export async function POST(){try{const user=await requireOwner();const token=await gmailAccessToken(user.id);const profile=await gmailProfile(token.accessToken);return NextResponse.json({connected:true,emailAddress:profile.emailAddress});}catch(error){return safeApiError(error,"Gmail connection test failed.");}}
export async function DELETE(request:Request){try{const user=await requireOwner();const {id}=z.object({id:z.string().uuid()}).parse(await request.json());await supabaseRequest(`email_accounts?id=eq.${id}&owner_id=eq.${user.id}&provider=eq.gmail`,{method:"DELETE"});return NextResponse.json({disconnected:true});}catch(error){return safeApiError(error,"Gmail account could not be disconnected.");}}
