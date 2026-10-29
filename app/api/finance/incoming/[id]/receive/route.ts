import{NextResponse}from"next/server";
import{safeApiError}from"@/lib/auth/api";
import{requireOwner}from"@/lib/auth/server";
import{supabaseRequest}from"@/lib/supabase";
import{receiveManualIncomingSchema}from"@/lib/validation/finance";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const user=await requireOwner(),{id}=await params,input=receiveManualIncomingSchema.parse({...(await request.json()),incomingId:id}),response=await supabaseRequest("rpc/fh_receive_manual_incoming",{method:"POST",body:JSON.stringify({p_owner_id:user.id,p_payload:input,p_actor:user.email??null})});return NextResponse.json(await response.json())}catch(error){return safeApiError(error,"Could not confirm this incoming payment.")}}
