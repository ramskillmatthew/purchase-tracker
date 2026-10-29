import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import { isMissingSchemaError,supabaseRequest,supabaseRequestAll } from "@/lib/supabase";
import { plannedOutgoingInputSchema } from "@/lib/validation/finance";

export async function GET(){try{const user=await requireOwner();const [outgoings,parts,accounts,cards,allocations]=await Promise.all([
  supabaseRequestAll(`finance_planned_outgoings?owner_id=eq.${user.id}&deleted_at=is.null&select=*&order=due_date.asc,created_at.asc`),
  supabaseRequestAll(`finance_payment_parts?owner_id=eq.${user.id}&status=neq.cancelled&select=*&order=created_at.asc`),
  supabaseRequestAll(`finance_accounts?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,provider,current_balance_pence&order=created_at.asc`),
  supabaseRequestAll(`finance_cards?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,provider,current_balance_pence,statement_balance_pence,payment_due_date&order=payment_due_date.asc.nullslast,created_at.asc`),
  supabaseRequestAll(`finance_allocations?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,balance_pence&order=created_at.asc`),
]);const cardPayments=(cards as Array<{id:string;name:string;provider:string;current_balance_pence:number|string;statement_balance_pence:number|string;payment_due_date:string|null}>).filter(card=>card.payment_due_date).map(card=>{const statement=Number(card.statement_balance_pence)||Number(card.current_balance_pence)||0;return{id:`card-${card.id}`,kind:"card_payment",description:`${card.name} credit card payment`,category:"Credit card",payee:card.name,total_pence:Math.max(0,statement),paid_pence:0,due_date:card.payment_due_date,date_kind:"exact",range_start:null,range_end:null,status:"planned",recurring_monthly:false,planned_payload:{purchase:null,expense:null},card_id:card.id,is_live_card_payment:true}});return NextResponse.json({outgoings:[...cardPayments,...outgoings],parts,accounts,cards,allocations});}catch(error){if(isMissingSchemaError(error))return NextResponse.json({error:"The Finance Hub database migration has not been installed."},{status:503});return safeApiError(error,"Could not load planned outgoings.")}}

export async function POST(request:Request){try{const user=await requireOwner();const input=plannedOutgoingInputSchema.parse(await request.json());const response=await supabaseRequest("rpc/fh_create_planned_outgoing",{method:"POST",body:JSON.stringify({p_owner_id:user.id,p_payload:input,p_actor:user.email??null})});return NextResponse.json({outgoing:await response.json()},{status:201})}catch(error){return safeApiError(error,"Could not save the planned outgoing.")}}
