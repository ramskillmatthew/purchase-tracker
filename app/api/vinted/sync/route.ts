import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server"; import { safeApiError } from "@/lib/auth/api";
import { scanYahooMetadata, yahooMetadataId } from "@/lib/yahoo/client"; import { parseVintedEmail } from "@/lib/vinted/parser";
import { scanGmailMetadata } from "@/lib/gmail/client"; import { getMails } from "@/lib/email/client"; import { gmailAccounts } from "@/lib/gmail/oauth";
import { parseGeneralPurchaseEmail } from "@/lib/purchase-import/parser"; import { planEmailQuery } from "@/lib/yahoo/query-plan";
import { extractOrderWithAi } from "@/lib/purchase-import/ai-extract";
import { expandOrderToRows } from "@/lib/purchase-import/allocate";
import { sourceItemKey } from "@/lib/purchase-import/identity";
import { resolveSourceProvider, resolveSourceAccount } from "@/lib/purchase-import/provider";
import type { ParsedOrder } from "@/lib/purchase-import/types";
import { shouldInspectPurchaseHeader } from "@/lib/email/classify";
import { supabaseRequest } from "@/lib/supabase"; import { audit, enforceRateLimit } from "@/lib/security/activity"; import { z } from "zod";
export const runtime = "nodejs"; export const maxDuration = 60;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requestSchema = z.object({ instruction: z.string().trim().max(500).optional(), startDate: date.optional(), endDate: date.optional(), cursor: z.string().max(1000).optional() }).strict().refine(value => Boolean(value.instruction || (value.startDate && value.endDate)), "Enter an instruction or date range.");
function normalized(value: string) { return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\bcentre\b/g, "center").replace(/[^a-z0-9]+/g, " ").trim(); }
function metadataMatchesEntity(entity: string, row: { sender_name: string|null; sender_address: string|null; subject: string }) {
  const haystack = normalized([row.sender_name,row.sender_address,row.subject].filter(Boolean).join(" "));
  return normalized(entity).split(" ").filter(Boolean).every(token => haystack.includes(token));
}
// A shortlisted email whose deterministic parse is missing or genuinely
// ambiguous (no total, or more than one item without confirmed individual
// prices) is worth the AI fallback; a merely-missing size/condition is not
// worth the extra latency/cost for every sync. Bounded per sync run — this
// never sends more than a small, already-shortlisted slice to Claude, and
// never re-scans the mailbox to find more candidates for it.
const AI_EXTRACTION_LIMIT = 20;
function needsAiFallback(order: ParsedOrder | null): boolean {
  if (!order) return true;
  if (order.totalPaidPence === null) return true;
  return order.items.length > 1 && order.items.some(item => item.linePricePence === null);
}
export async function POST(request: Request) { let syncId: string | null = null; try {
  const user = await requireOwner(); await enforceRateLimit(user.id, "purchase_email_sync", 5, 300); const value = requestSchema.parse(await request.json());
  const plan = value.instruction ? planEmailQuery(value.instruction) : null; const startDate = value.startDate || plan?.startDate; const endDate = value.endDate || plan?.endDate;
  if (!startDate || !endDate) return NextResponse.json({ error: "Please include a date or date range, such as today, last week, or 10 July to 15 July." }, { status: 400 });
  const entity = plan?.entity || null; const vintedOnly = Boolean(entity && /vinted/i.test(entity));
  // Unfinished/rejected/manually-corrected candidates from a previous sync
  // are deliberately never deleted here — new results are upserted below on
  // a stable per-item/unit key, so re-scanning only ever updates or adds,
  // never wipes out review-in-progress work.
  const created = await supabaseRequest("yahoo_sync_history", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: user.id, sync_type: value.cursor ? "incremental" : "date_range", range_start: startDate, range_end: endDate, status: "running" }) }); syncId = ((await created.json()) as { id: string }[])[0]?.id || null;
  const gmailAccountEmail = (await gmailAccounts(user.id).catch(() => []))[0]?.email_address || null;
  // For a named retailer, let IMAP select every sender match first. This avoids
  // exhausting the scan budget on unrelated mailbox traffic and avoids making
  // subject wording a prerequisite for discovery.
  const yahooMetadata = await scanYahooMetadata(startDate, endDate, 5000, entity || undefined);
  let gmailMetadata:{rows:Awaited<ReturnType<typeof scanGmailMetadata>>["rows"];truncated:boolean}={rows:[],truncated:false};try{gmailMetadata=await scanGmailMetadata(user.id,startDate,endDate,5000,entity||undefined);}catch{}
  const metadataRows = [...yahooMetadata.rows.map(row=>({...row,provider:"yahoo" as const})),...gmailMetadata.rows.map(row=>({...row,provider:"gmail" as const}))];
  const candidates = metadataRows
    .filter(row => (!entity || metadataMatchesEntity(entity,row)) && (vintedOnly ? /vinted/i.test(`${row.sender_name||""} ${row.sender_address||""}`) : true) && shouldInspectPurchaseHeader(row.subject, Boolean(entity)))
    .sort((a,b)=>b.email_date.localeCompare(a.email_date));
  const found = { results: await Promise.all(candidates.map(async row => ({ id: row.provider==="gmail"?row.id:await yahooMetadataId(row.folder,row.yahoo_uid,row.uid_validity), sender: [row.sender_name,row.sender_address].filter(Boolean).join(" <"), recipient:"", subject:row.subject, date:row.email_date, folder:row.provider==="gmail"?"Gmail":row.folder, provider: row.provider, excerpt:"", whyMatched:"Purchase-confirmation header matched.", hasAttachments:row.has_attachments, attachmentFilenames:[], unread:row.unread }))), nextCursor: null };
  const providerById = new Map(found.results.map(result => [result.id, result.provider]));
  let parsed = 0, uncertain = 0, aiAssisted = 0;
  const emails = await getMails(user.id,found.results.map(result => result.id));
  const records: Record<string, unknown>[] = [];
  for (const email of emails) {
    // REGRESSION: must be resolved from the email's own signed id (the same
    // value found.results/getMails used), never from order.messageId — that
    // is a different identifier per provider (Yahoo's raw Message-ID header
    // vs Gmail's "gmail:<id>") and never matches this map's keys. A miss
    // never silently defaults to "yahoo" — the email is skipped instead.
    const provider = resolveSourceProvider(email.id, providerById);
    if (!provider) continue;
    const vinted = parseVintedEmail(email);
    const generic = vinted ? null : parseGeneralPurchaseEmail(email);
    let order: ParsedOrder | null = vinted || generic;
    if (needsAiFallback(order) && aiAssisted < AI_EXTRACTION_LIMIT && email.messageId) {
      const vintedSender = /@(?:email\.)?vinted\.(?:com|co\.uk|fr|de|nl|es|it)/i.test(email.sender) || /\bvinted\b/i.test(email.sender);
      const aiOrder = await extractOrderWithAi(
        { messageId: email.messageId || "", sender: email.sender, subject: email.subject, date: email.date || new Date().toISOString(), text: email.text },
        { candidateType: vintedSender ? "vinted" : "general", fallbackPurchasedFrom: vintedSender ? "Vinted" : "Unknown retailer" },
      );
      aiAssisted++;
      // Only ever replaces a missing/uncertain deterministic result — never
      // overrides a deterministic parse that was already confident and
      // complete, and never inserted if the model's own output failed
      // strict schema validation (extractOrderWithAi returns null then).
      if (aiOrder) order = aiOrder;
    }
    if (!order) continue;
    const sourceAccount = resolveSourceAccount(provider, { gmailAccountEmail, yahooEmail: process.env.YAHOO_EMAIL || null });
    const expansion = expandOrderToRows(order.items.map(item => ({ description: item.description, size: item.size, condition: item.condition, quantity: item.quantity, linePricePence: item.linePricePence })), order.totalPaidPence);
    const rowUncertainty = [...order.uncertaintyReasons, ...(expansion.reason ? [expansion.reason] : [])];
    for (const row of expansion.rows) {
      records.push({
        // owner_id/sync_id/yahoo_message_id/... are the parser-owned fields
        // this route always refreshes on re-scan. `draft` is deliberately
        // never referenced here — a re-sync can never overwrite a
        // reviewer's saved edits, since those live only in that column
        // (see app/api/vinted/candidates/route.ts's save_draft action) and
        // this upsert payload never includes it.
        owner_id: user.id, sync_id: syncId, yahoo_message_id: order.messageId, email_date: order.emailDate, sender: order.sender, subject: order.subject,
        order_reference: order.orderReference, item_title: row.description, seller_name: order.sellerName, item_size: row.size,
        price_paid: row.pricePence === null ? null : row.pricePence / 100, purchase_date: order.purchaseDate,
        dispatch_status: order.dispatchStatus, delivery_status: order.deliveryStatus, cancellation_refund_status: order.cancellationRefundStatus,
        parser_confidence: order.parserConfidence, fingerprint: order.fingerprint, sanitized_excerpt: order.sanitizedExcerpt,
        purchased_from: order.purchasedFrom, candidate_type: order.candidateType, uncertainty_reasons: [...rowUncertainty],
        item_index: row.itemIndex, unit_index: row.unitIndex, order_total_paid: order.totalPaidPence === null ? null : order.totalPaidPence / 100,
        source_provider: provider, source_account: sourceAccount, item_condition_hint: row.condition,
        source_item_key: sourceItemKey(order.messageId, row.itemIndex, row.unitIndex),
      });
    }
    parsed++; if (rowUncertainty.length) uncertain++;
  }
  // Cross-email duplicate-order signal: the same content fingerprint
  // appearing under more than one distinct source email within this same
  // batch (e.g. a duplicate or forwarded copy of the same receipt) is
  // flagged for manual review rather than silently treated as two separate
  // orders — source_item_key alone can't catch this, since two different
  // emails always produce two different keys even for the same real order.
  // The import RPC applies the equivalent check against already-imported
  // purchases too (see supabase-purchase-import-v2.sql).
  const messageIdsByFingerprint = new Map<string, Set<string>>();
  for (const record of records) {
    const fp = record.fingerprint as string; const messageId = record.yahoo_message_id as string;
    if (!messageIdsByFingerprint.has(fp)) messageIdsByFingerprint.set(fp, new Set());
    messageIdsByFingerprint.get(fp)!.add(messageId);
  }
  for (const record of records) {
    const fp = record.fingerprint as string;
    if ((messageIdsByFingerprint.get(fp)?.size ?? 0) > 1) {
      (record.uncertainty_reasons as string[]).push("This order's details match another candidate from a different email — possible duplicate order; please check before importing.");
    }
  }
  if (records.length) await supabaseRequest("vinted_import_candidates?on_conflict=source_item_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(records) });
  if (syncId) await supabaseRequest(`yahoo_sync_history?id=eq.${syncId}`, { method: "PATCH", body: JSON.stringify({ status: "completed", messages_scanned: found.results.length, candidates_parsed: parsed, completed_at: new Date().toISOString() }) });
  await audit(user.id, "purchase_email_sync_completed", { scanned: metadataRows.length, shortlisted: found.results.length, parsed, rejected: found.results.length-parsed, uncertain, aiAssisted, startDate, endDate, entity, providers:["yahoo",...(gmailMetadata.rows.length?["gmail"]:[])], truncated: yahooMetadata.truncated||gmailMetadata.truncated }); return NextResponse.json({ scanned: metadataRows.length, shortlisted: found.results.length, parsed, rejected: found.results.length-parsed, uncertain, aiAssisted, truncated: yahooMetadata.truncated||gmailMetadata.truncated, nextCursor: found.nextCursor, startDate, endDate });
} catch (error) { if (syncId) try { await supabaseRequest(`yahoo_sync_history?id=eq.${syncId}`, { method: "PATCH", body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), safe_error: "Sync failed safely." }) }); } catch {} return safeApiError(error, "Purchase email sync could not be completed safely."); } }
