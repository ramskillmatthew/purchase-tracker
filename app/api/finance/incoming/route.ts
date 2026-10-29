import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import { supabaseRequest } from "@/lib/supabase";
import { manualIncomingSchema } from "@/lib/validation/finance";

export async function POST(request:Request){
  try{
    const user=await requireOwner();
    const input=manualIncomingSchema.parse(await request.json());
    const response=await supabaseRequest("rpc/fh_create_manual_incoming",{method:"POST",body:JSON.stringify({p_owner_id:user.id,p_payload:input,p_actor:user.email??null})});
    return NextResponse.json(await response.json(),{status:201});
  }catch(error){return safeApiError(error,"Could not record this incoming money.")}
}
