import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server"; import { safeApiError } from "@/lib/auth/api";
import { scanYahooMetadata, yahooMetadataId } from "@/lib/yahoo/client"; import { parseVintedEmail } from "@/lib/vinted/parser";
import { scanGmailMetadata } from "@/lib/gmail/client"; import { getMails } from "@/lib/email/client";
import { parseGeneralPurchaseEmail } from "@/lib/purchase-import/parser"; import { planEmailQuery } from "@/lib/yahoo/query-plan";
import { shouldInspectPurchaseHeader } from "@/lib/email/classify";
import { supabaseRequest } from "@/lib/supabase"; import { audit, enforceRateLimit } from "@/lib/security/activity"; import { z } from "zod";
export const runtime = "nodejs"; export const maxDuration = 60;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requestSchema = z.object({ instruction: z.string().trim().max(500).optional(), startDate: date.optional(), endDate: date.optional(), cursor: z.string().max(1000).optional() }).strict().refine(value => Boolean(value.instruction || (value.startDate && value.endDate)), "Enter an instruction or date range.");
function normalized(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\bcentre\b/g, "center").replace(/[^a-z0-9]+/g, " ").trim(); }
function metadataMatchesEntity(entity: string, row: { sender_name: string|null; sender_address: string|null; subject: string }) {
  const haystack = normalized([row.sender_name,row.sender_address,row.subject].filter(Boolean).join(" "));
  return normalized(entity).split(" ").filter(Boolean).every(token => haystack.includes(token));
}
export async function POST(request: Request) { let syncId: string | null = null; try {
  const user = await requireOwner(); await enforceRateLimit(user.id, "purchase_email_sync", 5, 300); const value = requestSchema.parse(await request.json());
  const plan = value.instruction ? planEmailQuery(value.instruction) : null; const startDate = value.startDate || plan?.startDate; const endDate = value.endDate || plan?.endDate;
  if (!startDate || !endDate) return NextResponse.json({ error: "Please include a date or date range, such as today, last week, or 10 July to 15 July." }, { status: 400 });
  const entity = plan?.entity || null; const vintedOnly = Boolean(entity && /vinted/i.test(entity));
  await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&import_status=neq.imported`, { method: "DELETE" });
  const created = await supabaseRequest("yahoo_sync_history", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, sync_type: value.cursor ? "incremental" : "date_range", range_start: startDate, range_end: endDate, status: "running" }) }); syncId = ((await created.json()) as { id: string }[])[0]?.id || null;
  // For a named retailer, let IMAP select every sender match first. This avoids
  // exhausting the scan budget on unrelated mailbox traffic and avoids making
  // subject wording a prerequisite for discovery.
  const yahooMetadata = await scanYahooMetadata(startDate, endDate, 5000, entity || undefined);
  let gmailMetadata:{rows:Awaited<ReturnType<typeof scanGmailMetadata>>["rows"];truncated:boolean}={rows:[],truncated:false};try{gmailMetadata=await scanGmailMetadata(user.id,startDate,endDate,5000,entity||undefined);}catch{}
  const metadataRows = [...yahooMetadata.rows.map(row=>({...row,provider:"yahoo" as const})),...gmailMetadata.rows.map(row=>({...row,provider:"gmail" as const}))];
  const candidates = metadataRows
    .filter(row => (!entity || metadataMatchesEntity(entity,row)) && (vintedOnly ? /vinted/i.test(`${row.sender_name||""} ${row.sender_address||""}`) : true) && shouldInspectPurchaseHeader(row.subject, Boolean(entity)))
    .sort((a,b)=>b.email_date.localeCompare(a.email_date));
  const found = { results: await Promise.all(candidates.map(async row => ({ id: row.provider==="gmail"?row.id:await yahooMetadataId(row.folder,row.yahoo_uid,row.uid_validity), sender: [row.sender_name,row.sender_address].filter(Boolean).join(" <"), recipient:"", subject:row.subject, date:row.email_date, folder:row.provider==="gmail"?"Gmail":row.folder, excerpt:"", whyMatched:"Purchase-confirmation header matched.", hasAttachments:row.has_attachments, attachmentFilenames:[], unread:row.unread }))), nextCursor: null };
  let parsed = 0, uncertain = 0;
  const emails = await getMails(user.id,found.results.map(result => result.id));
  const records = [];
  for (const email of emails) { const vinted = parseVintedEmail(email); const generic = vinted ? null : parseGeneralPurchaseEmail(email); const candidate = vinted || generic; if (!candidate) continue;
    const uncertainty = vinted ? [!vinted.item_title && "Item name could not be extracted.", vinted.price_paid === null && "Price could not be extracted.", !vinted.item_size && "Size could not be extracted."].filter((item): item is string => Boolean(item)) : generic!.uncertainty_reasons;
    records.push({ ...candidate, owner_id: user.id, sync_id: syncId, purchased_from: vinted ? "Vinted" : generic!.purchased_from, candidate_type: vinted ? "vinted" : "general", uncertainty_reasons: uncertainty }); parsed++; if (uncertainty.length) uncertain++;
  }
  if (records.length) await supabaseRequest("vinted_import_candidates?on_conflict=yahoo_message_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(records) });
  if (syncId) await supabaseRequest(`yahoo_sync_history?id=eq.${syncId}`, { method: "PATCH", body: JSON.stringify({ status: "completed", messages_scanned: found.results.length, candidates_parsed: parsed, completed_at: new Date().toISOString() }) });
  await audit(user.id, "purchase_email_sync_completed", { scanned: metadataRows.length, shortlisted: found.results.length, parsed, rejected: found.results.length-parsed, uncertain, startDate, endDate, entity, providers:["yahoo",...(gmailMetadata.rows.length?["gmail"]:[])], truncated: yahooMetadata.truncated||gmailMetadata.truncated }); return NextResponse.json({ scanned: metadataRows.length, shortlisted: found.results.length, parsed, rejected: found.results.length-parsed, uncertain, truncated: yahooMetadata.truncated||gmailMetadata.truncated, nextCursor: found.nextCursor, startDate, endDate });
} catch (error) { if (syncId) try { await supabaseRequest(`yahoo_sync_history?id=eq.${syncId}`, { method: "PATCH", body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), safe_error: "Sync failed safely." }) }); } catch {} return safeApiError(error, "Purchase email sync could not be completed safely."); } }
