import { NextResponse } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";

type Card={id:string;name:string;current_balance_pence:number|string;credit_limit_pence:number|string;statement_balance_pence:number|string;payment_due_date:string|null};
type Account={current_balance_pence:number|string};
type Outgoing={id:string;description:string;total_pence:number|string;paid_pence:number|string;due_date:string|null;range_start:string|null;allocation_id:string|null};
type Incoming={id:string;description:string;amount_pence:number|string;received_pence:number|string;refunded_pence:number|string;expected_date:string|null;range_start:string|null};
type Allocation={id:string;name:string;balance_pence:number|string;deadline:string|null};
type Audit={id:string;event_type:string;summary:string;metadata:Record<string,unknown>};
type Notice={id:string;title:string;body:string;dueDate:string|null;kind:string;importance:"important"|"standard"};
const taskRequest=z.object({title:z.string().trim().min(1).max(200),notes:z.string().trim().max(2000).nullish(),dueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish()}).strict();
const isoDate=/^\d{4}-\d{2}-\d{2}$/;
const daysBetween=(from:string,to:string)=>Math.ceil((new Date(`${to}T12:00:00`).getTime()-new Date(`${from}T12:00:00`).getTime())/86400000);

export async function GET(request:Request){try{
  const user=await requireOwner(),today=new Date().toISOString().slice(0,10),url=new URL(request.url),days=Math.min(90,Math.max(1,Number(url.searchParams.get("days")||3))),customEnd=url.searchParams.get("end"),end=customEnd&&isoDate.test(customEnd)?customEnd:new Date(Date.now()+days*86400000).toISOString().slice(0,10);
  const[cards,accounts,outgoings,incoming,allocations,audits]=await Promise.all([
    supabaseRequestAll<Card>(`finance_cards?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,current_balance_pence,credit_limit_pence,statement_balance_pence,payment_due_date`),
    supabaseRequestAll<Account>(`finance_accounts?owner_id=eq.${user.id}&archived_at=is.null&select=current_balance_pence`),
    supabaseRequestAll<Outgoing>(`finance_planned_outgoings?owner_id=eq.${user.id}&deleted_at=is.null&status=in.(planned,partially_paid)&select=id,description,total_pence,paid_pence,due_date,range_start,allocation_id`),
    supabaseRequestAll<Incoming>(`finance_incoming?owner_id=eq.${user.id}&deleted_at=is.null&status=in.(pending,partially_received)&select=id,description,amount_pence,received_pence,refunded_pence,expected_date,range_start`),
    supabaseRequestAll<Allocation>(`finance_allocations?owner_id=eq.${user.id}&archived_at=is.null&select=id,name,balance_pence,deadline`),
    supabaseRequest(`finance_audit_events?owner_id=eq.${user.id}&event_type=in.(card_reconciled,planned_outgoing_payment,marketplace_payout_confirmed)&select=id,event_type,summary,metadata&order=created_at.desc&limit=20`).then(response=>response.json() as Promise<Audit[]>),
  ]);
  const cash=accounts.reduce((sum,row)=>sum+Number(row.current_balance_pence),0),allocationById=new Map(allocations.map(row=>[row.id,row])),notifications:Notice[]=[];
  const inWindow=(date:string|null)=>Boolean(date&&date<=end);
  for(const card of cards){const balance=Number(card.current_balance_pence),available=Number(card.credit_limit_pence)-balance;if(inWindow(card.payment_due_date))notifications.push({id:`card-due-${card.id}`,title:`${card.name} payment due`,body:card.payment_due_date!<today?`Payment was due ${card.payment_due_date}.`:`Statement balance £${(Number(card.statement_balance_pence)/100).toFixed(2)} is due ${card.payment_due_date}.`,dueDate:card.payment_due_date,kind:"card_due",importance:"important"});if(available<50000)notifications.push({id:`card-limit-${card.id}`,title:`${card.name} has under £500 available`,body:`Available credit is £${(available/100).toFixed(2)}.`,dueDate:null,kind:"card_limit",importance:"important"});if(balance>cash)notifications.push({id:`card-cash-${card.id}`,title:`${card.name} exceeds available cash`,body:"The card balance is larger than total tracked business cash.",dueDate:card.payment_due_date,kind:"card_cash",importance:"important"})}
  for(const row of outgoings){const date=row.due_date??row.range_start,remaining=Number(row.total_pence)-Number(row.paid_pence);if(inWindow(date))notifications.push({id:`outgoing-${row.id}`,title:date!<today?`${row.description} is overdue`:`${row.description} is due soon`,body:`£${(remaining/100).toFixed(2)} remains due.`,dueDate:date,kind:date!<today?"outgoing_overdue":"outgoing_due",importance:date!<today?"important":"standard"});const pot=row.allocation_id?allocationById.get(row.allocation_id):null;if(pot&&Number(pot.balance_pence)<remaining)notifications.push({id:`allocation-short-${row.id}`,title:`${pot.name} allocation is short`,body:`It is £${((remaining-Number(pot.balance_pence))/100).toFixed(2)} below this commitment.`,dueDate:date,kind:"allocation_short",importance:"important"})}
  for(const row of incoming){const date=row.expected_date??row.range_start,remaining=Number(row.amount_pence)-Number(row.received_pence)-Number(row.refunded_pence);if(inWindow(date))notifications.push({id:`incoming-${row.id}`,title:date!<today?`${row.description} is overdue`:`${row.description} is expected soon`,body:`£${(remaining/100).toFixed(2)} is still expected.`,dueDate:date,kind:"incoming_due",importance:"standard"})}
  for(const pot of allocations)if(inWindow(pot.deadline))notifications.push({id:`allocation-${pot.id}`,title:`${pot.name} deadline`,body:`£${(Number(pot.balance_pence)/100).toFixed(2)} is currently reserved.`,dueDate:pot.deadline,kind:"allocation_deadline",importance:pot.deadline!<today?"important":"standard"});
  for(const event of audits){const variance=Number(event.metadata?.variance_pence??0),recurring=event.event_type==="planned_outgoing_payment"&&event.metadata?.recurring_created===true;if(variance!==0)notifications.push({id:`audit-variance-${event.id}`,title:"Marketplace payout variance",body:`The received payout differed by £${(variance/100).toFixed(2)}.`,dueDate:null,kind:"payout_variance",importance:"important"});else if(recurring)notifications.push({id:`audit-recurring-${event.id}`,title:"Next recurring payment created",body:event.summary,dueDate:null,kind:"recurring",importance:"standard"});else if(event.event_type==="card_reconciled")notifications.push({id:`audit-card-${event.id}`,title:"Credit card balance changed",body:event.summary,dueDate:null,kind:"card_changed",importance:"standard"})}
  return NextResponse.json({range:{today,end,days:daysBetween(today,end)},notifications:notifications.sort((a,b)=>(a.dueDate??"9999").localeCompare(b.dueDate??"9999")||a.title.localeCompare(b.title))});
}catch(error){return safeApiError(error,"Could not load Finance notifications.")}}

export async function POST(request:Request){try{const user=await requireOwner(),input=taskRequest.parse(await request.json());await supabaseRequest("tasks",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({owner_id:user.id,title:input.title,notes:input.notes??null,category:"Finance",priority:"High",due_date:input.dueDate??null})});return NextResponse.json({ok:true},{status:201})}catch(error){return safeApiError(error,"Could not create the Finance task.")}}
