import type { SearchObject } from "imapflow";
import type { EmailSearch } from "@/lib/validation/email";
import { canonicalSender, countSubjectTerms, isExactEmailAddress, searchVariants, semanticSubjectTerms, senderSearchVariants } from "./search-terms";

// Pure IMAP search-object builders, kept separate from lib/yahoo/client.ts
// (which is "server-only" and cannot be loaded by vitest) so the query
// *shape* — which fields survive a broadening fallback, which sender
// spelling variants are tried — can be asserted directly in tests instead
// of only being exercisable against a live mailbox.

export function imapQuery(criteria: EmailSearch): SearchObject {
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

export function imapQueries(criteria: EmailSearch): SearchObject[] {
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

/**
 * Builds the IMAP search object(s) used for count_emails. A sender, once
 * present on the criteria, must never be dropped from these queries — a
 * count fallback may broaden *where* text is searched (e.g. drop the
 * subject-line requirement so a body-only cancellation notice still
 * surfaces) but must keep searching only that sender's mail, never the
 * whole mailbox. Only whole-phrase spelling variants (accented/unaccented,
 * UK/US) are used for the bare mailbox-wide text search — never
 * senderSearchVariants' truncated-prefix or single-character-deletion typo
 * probes (e.g. "poke", "cent" for "Pokémon Center"), which exist to make
 * From-header matching typo-tolerant and are far too short/generic to use as
 * an unrestricted full-text search term without matching unrelated mail.
 */
export function countQueries(criteria: EmailSearch): SearchObject[] {
  const base = imapQuery({ ...criteria, sender: undefined, terms: [] });
  const intents = countSubjectTerms(criteria.terms).slice(0, 12);
  if (criteria.sender && isExactEmailAddress(criteria.sender)) {
    base.from = criteria.sender.trim();
    return intents.length ? intents.map(subject => ({ ...base, subject })) : [base];
  }
  if (criteria.sender) {
    const senderVariants = searchVariants([criteria.sender]).slice(0, 6);
    if (intents.length) return [{ ...base, or: senderVariants.flatMap(text => intents.map(subject => ({ text, subject }))).slice(0, 36) }];
    return [{ ...base, or: senderVariants.map(text => ({ text })) }];
  }
  if (intents.length) return intents.map(subject => ({ ...base, subject }));
  if (criteria.terms.length) base.text = criteria.terms.join(" ");
  return [base];
}
