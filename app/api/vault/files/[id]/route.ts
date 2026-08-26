import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { signedVaultObject } from "@/lib/vault-storage-server";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){try{const user=await requireOwner(),{id}=await params;const rows=await(await supabaseRequest(`vault_attachments?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}&select=storage_path`)).json() as {storage_path:string}[];if(!rows.length)return NextResponse.json({error:"File not found."},{status:404});return NextResponse.redirect(await signedVaultObject(rows[0].storage_path))}catch(e){return safeApiError(e,"Could not download Vault file.")}}
