import "server-only";
import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailSearch } from "@/lib/validation/email";
import { excerpt, sanitizeEmailHtml } from "./sanitize";
import { signEmailId, verifyEmailId } from "./tokens";
import { canonicalSender, countSubjectTerms, isExactEmailAddress, searchVariants, semanticSubjectTerms, senderSearchVariants } from "./search-terms";
import { createHash } from "node:crypto";
import { classifyIndexedEmail } from "@/lib/email-index/classify";
import { classifyEmailIntent } from "./search-terms";

const CONNECT_TIMEOUT = 8_000;
const SOCKET_TIMEOUT = 15_000;
const MAX_FOLDERS = 20;
function credentials() {
  const user = process.env.YAHOO_EMAIL; const pass = process.env.YAHOO_APP_PASSWORD;
  if (!user || !pass) throw new Error("Yahoo Mail is not configured.");
  return { user, pass };
}
function client() {
  const auth = credentials();
  return new ImapFlow({ host: process.env.YAHOO_IMAP_HOST || "export.imap.mail.yahoo.com", port: 993, secure: true, auth, logger: false, connectionTimeout: CONNECT_TIMEOUT, socketTimeout: SOCKET_TIMEOUT, disableAutoIdle: true });
}
async function withClient<T>(operation: (imap: ImapFlow) => Promise<T>) {
  const imap = client();
  try { await imap.connect(); return await operation(imap); }
  finally { try { await imap.logout(); } catch { imap.close(); } }
}
export async function testYahooConnection() { return withClient(async imap => { await imap.list(); return true; }); }

function imapQuery(criteria: EmailSearch): SearchObject {
  const query: SearchObject = {};
  const intentSubjects = semanticSubjectTerms(criteria.terms);
  if (criteria.sender && isExactEmailAddress(criteria.sender)) query.from = criteria.sender.trim();
  else if (criteria.sender && intentSubjects.length) {
    // Match the named company and any generalized lifecycle wording together.
    // This mirrors a mailbox search such as "ASOS order" without requiring a
    // retailer-specific receipt subject.
    const entities = senderSearchVariants(criteria.sender);
    query.or = entities.flatMap(text => intentSubjects.flatMap(intent => [{ text, subject: intent }, { text, body: intent }])).slice(0, 36);
  } else if (criteria.sender) {
    const entities = senderSearchVariants(criteria.sender);
    query.or = entities.flatMap(value => [{ from: canonicalSender(value) }, { text: value }]).slice(0, 24);
  }
  if (criteria.recipient) query.to = criteria.recipient;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.startDate) query.since = new Date(`${criteria.startDate}T00:00:00Z`);
  if (criteria.endDate) { const before = new Date(`${criteria.endDate}T00:00:00Z`); before.setUTCDate(before.getUTCDate() + 1); query.before = before; }
  if (criteria.readStatus === "read") query.seen = true;
  if (criteria.readStatus === "unread") query.seen = false;
  const freeText = searchVariants(criteria.terms);
  if (criteria.exactPhrase) query.text = criteria.exactPhrase;
  else if (intentSubjects.length && !criteria.sender) query.or = intentSubjects.flatMap(intent => [{ subject: intent }, { body: intent }]);
  else if (intentSubjects.length && criteria.sender) { /* entity + intent query is already applied above */ }
  else if (freeText.length === 1) query.text = freeText[0];
  else if (freeText.length > 1) query.or = freeText.map(text => ({ text }));
  return query;
}

function imapQueries(criteria: EmailSearch): SearchObject[] {
  const intents = semanticSubjectTerms(criteria.terms);
  if (!criteria.sender || isExactEmailAddress(criteria.sender) || !intents.length) return [imapQuery(criteria)];

  // Yahoo handles several small searches more reliably than one deeply nested
  // OR expression. Each query requires both the retailer and one intent term.
  const base = imapQuery({ ...criteria, sender: undefined, terms: [] });
  // Cover several likely sender spellings across the strongest intent terms;
  // allowing one intent to consume the entire query budget causes timeouts.
  // The UI confirms uncertain spelling before this point, so use the accepted
  // sender directly instead of multiplying every search by typo probes.
  const senders = senderSearchVariants(criteria.sender).slice(0, 1);
  return intents.slice(0, 6).flatMap(intent => senders.map(sender => (
    { ...base, from: canonicalSender(sender), subject: intent }
  ))).slice(0, 12);
}

function countQueries(criteria: EmailSearch): SearchObject[] {
  const base = imapQuery({ ...criteria, sender: undefined, terms: [] });
  const intents = countSubjectTerms(criteria.terms).slice(0, 12);
  if (criteria.sender) {
    if (isExactEmailAddress(criteria.sender)) base.from = criteria.sender.trim();
    else base.text = canonicalSender(criteria.sender);
  }
  if (intents.length) return intents.map(subject => ({ ...base, subject }));
  if (criteria.terms.length) base.text = criteria.terms.join(" ");
  return [base];
}
function address(list: { name?: string; address?: string }[] | undefined) { return list?.map(x => x.name ? `${x.name} <${x.address || ""}>` : x.address).filter(Boolean).join(", ") || "Unknown sender"; }
function attachments(node: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => { if (!value || typeof value !== "object") return; const item = value as Record<string, unknown>; if (typeof item.filename === "string") found.push(item.filename); if (Array.isArray(item.childNodes)) item.childNodes.forEach(walk); };
  walk(node); return found;
}

export async function searchYahoo(criteria: EmailSearch) {
  return withClient(async imap => {
    const listed = await imap.list();
    const selectable = listed.filter(x => !x.flags?.has("\\Noselect") && !/(?:^|[\\/])(sent|drafts?|spam|junk|trash|deleted(?: items)?)$/i.test(x.path));
    const prioritized = [...selectable].sort((left, right) => Number(right.path.toLowerCase() === "inbox") - Number(left.path.toLowerCase() === "inbox"));
    const folders = criteria.folder ? selectable.filter(x => x.path.toLowerCase() === criteria.folder!.toLowerCase()) : prioritized.slice(0, MAX_FOLDERS);
    if (criteria.folder && !folders.length) throw new Error("Requested folder is unavailable.");
    const offset = criteria.cursor ? Math.max(0, Number(Buffer.from(criteria.cursor, "base64url").toString("utf8")) || 0) : 0;
    const candidateTarget = Math.min(100, offset + criteria.maxResults);
    const candidates: { folder: string; uid: number; uidValidity: string }[] = [];
    const recencyOnly = /\b(most recent|latest|newest|last)\b/i.test(criteria.terms.join(" "));
    for (const folder of folders) {
      const lock = await imap.getMailboxLock(folder.path, { readOnly: true });
      try {
        const matched = new Set<number>();
        for (const query of imapQueries(criteria)) {
          const ids = await imap.search(query, { uid: true });
          if (ids) ids.forEach(uid => matched.add(uid));
          if ((recencyOnly && matched.size) || matched.size >= candidateTarget) break;
        }
        const uidValidity = String(imap.mailbox && imap.mailbox.uidValidity || "0");
        [...matched].sort((a, b) => b - a).slice(0, 100).forEach(uid => candidates.push({ folder: folder.path, uid, uidValidity }));
      } finally { lock.release(); }
      if ((recencyOnly && candidates.length) || candidates.length >= candidateTarget) break;
    }
    candidates.sort((a, b) => b.uid - a.uid);
    const page = candidates.slice(offset, offset + criteria.maxResults);
    const rankedResults: { rank: number; result: { id: string; sender: string; recipient: string; subject: string; date: string | null; folder: string; excerpt: string; whyMatched: string; hasAttachments: boolean; attachmentFilenames: string[]; unread: boolean } }[] = [];
    const folderGroups = new Map<string, typeof page>();
    page.forEach(item => folderGroups.set(item.folder, [...(folderGroups.get(item.folder) || []), item]));
    for (const [folder, items] of folderGroups) {
      const lock = await imap.getMailboxLock(folder, { readOnly: true });
      try {
        const fetched = await imap.fetchAll(items.map(item => item.uid).join(","), { envelope: true, flags: true, bodyStructure: true, source: { maxLength: 80_000 } }, { uid: true });
        const messages = new Map(fetched.map(message => [message.uid, message]));
        for (const item of items) {
          const message = messages.get(item.uid); if (!message) continue;
          const names = attachments(message.bodyStructure);
          if (criteria.hasAttachments !== undefined && (names.length > 0) !== criteria.hasAttachments) continue;
          if (criteria.attachmentFilename && !names.some(x => x.toLowerCase().includes(criteria.attachmentFilename!.toLowerCase()))) continue;
          const parsed = message.source ? await simpleParser(message.source) : undefined;
          rankedResults.push({ rank: page.indexOf(item), result: { id: await signEmailId(item), sender: address(message.envelope?.from), recipient: address(message.envelope?.to), subject: message.envelope?.subject || "(No subject)", date: message.envelope?.date?.toISOString() || null, folder: item.folder, excerpt: excerpt(parsed?.text || parsed?.html || "", 2_000), whyMatched: "Matched the validated sender, subject, date, status, keyword, or attachment criteria.", hasAttachments: names.length > 0, attachmentFilenames: names.slice(0, 10), unread: !message.flags?.has("\\Seen") } });
        }
      } finally { lock.release(); }
    }
    const results = rankedResults.sort((a, b) => a.rank - b.rank).map(item => item.result);
    return { results, nextCursor: offset + criteria.maxResults < candidates.length ? Buffer.from(String(offset + criteria.maxResults)).toString("base64url") : null };
  });
}

export async function countYahoo(criteria: EmailSearch) {
  return withClient(async imap => {
    const listed = await imap.list();
    const selectable = listed.filter(folder => !folder.flags?.has("\\Noselect") && !/(?:^|[\\/])(sent|drafts?|spam|junk|trash|deleted(?: items)?)$/i.test(folder.path));
    const prioritized = [...selectable].sort((left, right) => Number(right.path.toLowerCase() === "inbox") - Number(left.path.toLowerCase() === "inbox"));
    const folders = criteria.folder ? selectable.filter(folder => folder.path.toLowerCase() === criteria.folder!.toLowerCase()) : prioritized.slice(0, MAX_FOLDERS);
    if (criteria.folder && !folders.length) throw new Error("Requested folder is unavailable.");
    let count = 0;
    for (const folder of folders) {
      const lock = await imap.getMailboxLock(folder.path, { readOnly: true });
      try {
        const matched = new Set<number>();
        for (const query of countQueries(criteria)) {
          const ids = await imap.search(query, { uid: true });
          if (ids) ids.forEach(uid => matched.add(uid));
        }
        const expected = classifyEmailIntent(criteria.terms);
        if (expected === "general") count += matched.size;
        else {
          for (const chunk of Array.from(matched).reduce<number[][]>((groups, uid, index) => { if (index % 250 === 0) groups.push([]); groups[groups.length - 1].push(uid); return groups; }, [])) {
            for await (const message of imap.fetch(chunk.join(","), { envelope: true }, { uid: true })) {
              if (classifyIndexedEmail(message.envelope?.subject || "") === expected) count += 1;
            }
          }
        }
      } finally { lock.release(); }
    }
    return { count, foldersSearched: folders.length };
  });
}

export type YahooMetadata = {
  message_fingerprint: string; folder: string; yahoo_uid: number; uid_validity: string;
  sender_name: string | null; sender_address: string | null; subject: string; email_date: string;
  unread: boolean; has_attachments: boolean;
};
export async function yahooMetadataId(folder: string, uid: number, uidValidity: string) { return signEmailId({ folder, uid, uidValidity }); }

/** Fetches envelope metadata only. Message bodies and attachment content never leave Yahoo. */
export async function scanYahooMetadata(startDate: string, endDate: string, limit = 1500, sender?: string) {
  return withClient(async imap => {
    const listed = await imap.list();
    const folders = listed.filter(folder => !folder.flags?.has("\\Noselect") && !/(?:^|[\\/])(sent|drafts?|spam|junk|trash|deleted(?: items)?)$/i.test(folder.path));
    const rows: YahooMetadata[] = [];
    let truncated = false;
    const since = new Date(`${startDate}T00:00:00Z`);
    const before = new Date(`${endDate}T00:00:00Z`); before.setUTCDate(before.getUTCDate() + 1);
    for (const folder of folders) {
      const lock = await imap.getMailboxLock(folder.path, { readOnly: true });
      try {
        const senderQueries = sender ? senderSearchVariants(sender).slice(0, 4) : [];
        const criteria: SearchObject = { since, before };
        if (senderQueries.length === 1) criteria.from = senderQueries[0];
        else if (senderQueries.length > 1) criteria.or = senderQueries.map(from => ({ from }));
        const ids = await imap.search(criteria, { uid: true }) || [];
        const remaining = Math.max(0, limit - rows.length);
        const selected = ids.sort((a, b) => b - a).slice(0, remaining);
        if (ids.length > selected.length) truncated = true;
        const uidValidity = String(imap.mailbox && imap.mailbox.uidValidity || "0");
        for (let offset = 0; offset < selected.length; offset += 200) {
          const chunk = selected.slice(offset, offset + 200);
          if (!chunk.length) continue;
          const fetched = await imap.fetchAll(chunk.join(","), { envelope: true, flags: true, bodyStructure: true }, { uid: true });
          for (const message of fetched) {
            const from = message.envelope?.from?.[0];
            const identity = message.envelope?.messageId || `${folder.path}|${uidValidity}|${message.uid}`;
            rows.push({
              message_fingerprint: createHash("sha256").update(identity).digest("hex"), folder: folder.path, yahoo_uid: message.uid,
              uid_validity: uidValidity, sender_name: from?.name || null, sender_address: from?.address || null,
              subject: message.envelope?.subject || "(No subject)", email_date: message.envelope?.date?.toISOString() || new Date(0).toISOString(),
              unread: !message.flags?.has("\\Seen"), has_attachments: attachments(message.bodyStructure).length > 0,
            });
          }
        }
      } finally { lock.release(); }
      if (rows.length >= limit) { truncated = true; break; }
    }
    return { rows, truncated, foldersSearched: folders.length };
  });
}

export async function getYahooEmail(id: string) {
  const safe = await verifyEmailId(id);
  return withClient(async imap => {
    const folders = await imap.list();
    if (!folders.some(x => x.path === safe.folder && !x.flags?.has("\\Noselect"))) throw new Error("Email is no longer available.");
    const lock = await imap.getMailboxLock(safe.folder, { readOnly: true });
    try {
      if (String(imap.mailbox && imap.mailbox.uidValidity || "0") !== safe.uidValidity) throw new Error("Email identifier expired.");
      const message = await imap.fetchOne(String(safe.uid), { envelope: true, source: { maxLength: 300_000 }, bodyStructure: true }, { uid: true });
      if (!message || !message.source) throw new Error("Email is no longer available.");
      const parsed = await simpleParser(message.source);
      return { id, messageId: parsed.messageId || null, sender: address(message.envelope?.from), recipient: address(message.envelope?.to), subject: message.envelope?.subject || "(No subject)", date: message.envelope?.date?.toISOString() || null, folder: safe.folder, html: sanitizeEmailHtml(typeof parsed.html === "string" ? parsed.html : (parsed.textAsHtml || parsed.text || "")), text: excerpt(parsed.text || parsed.html || "", 20_000), attachments: parsed.attachments.map(x => ({ filename: x.filename || "attachment", contentType: x.contentType, size: x.size })).slice(0, 20) };
    } finally { lock.release(); }
  });
}

export async function getYahooEmails(ids: string[]) {
  const requested = await Promise.all(ids.map(async id => ({ id, safe: await verifyEmailId(id) })));
  return withClient(async imap => {
    const folders = await imap.list();
    const available = new Set(folders.filter(x => !x.flags?.has("\\Noselect")).map(x => x.path));
    const output = new Map<string, Awaited<ReturnType<typeof getYahooEmail>>>();
    const groups = new Map<string, typeof requested>();
    for (const item of requested) {
      if (!available.has(item.safe.folder)) continue;
      groups.set(item.safe.folder, [...(groups.get(item.safe.folder) || []), item]);
    }
    for (const [folder, items] of groups) {
      const lock = await imap.getMailboxLock(folder, { readOnly: true });
      try {
        const validity = String(imap.mailbox && imap.mailbox.uidValidity || "0");
        const valid = items.filter(item => item.safe.uidValidity === validity);
        if (!valid.length) continue;
        const fetched = [];
        for (let offset = 0; offset < valid.length; offset += 40) {
          fetched.push(...await imap.fetchAll(valid.slice(offset,offset+40).map(item => item.safe.uid).join(","), { envelope: true, source: { maxLength: 300_000 }, bodyStructure: true }, { uid: true }));
        }
        const byUid = new Map(fetched.map(message => [message.uid, message]));
        for (const item of valid) {
          const message = byUid.get(item.safe.uid); if (!message?.source) continue;
          const parsed = await simpleParser(message.source);
          output.set(item.id, { id:item.id, messageId:parsed.messageId||null, sender:address(message.envelope?.from), recipient:address(message.envelope?.to), subject:message.envelope?.subject||"(No subject)", date:message.envelope?.date?.toISOString()||null, folder, html:sanitizeEmailHtml(typeof parsed.html==="string"?parsed.html:(parsed.textAsHtml||parsed.text||"")), text:excerpt(parsed.text||parsed.html||"",20_000), attachments:parsed.attachments.map(x=>({filename:x.filename||"attachment",contentType:x.contentType,size:x.size})).slice(0,20) });
        }
      } finally { lock.release(); }
    }
    return ids.map(id => output.get(id)).filter((email): email is NonNullable<typeof email> => Boolean(email));
  });
}
