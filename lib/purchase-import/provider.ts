export type SourceProvider = "yahoo" | "gmail";

/**
 * Resolves which connected mailbox a fetched email came from. MUST be
 * looked up by the email's own signed `id` — the same value passed to
 * getMails(), which every returned email object echoes back unchanged
 * (see lib/yahoo/client.ts's getYahooEmails/getYahooEmail and
 * lib/gmail/client.ts's getGmailEmail, both of which set `id` to the
 * signed token they were given).
 *
 * REGRESSION: this must never be looked up by `order.messageId` — that is
 * a completely different identifier, in a different format per provider
 * (Yahoo: the email's own raw RFC "Message-ID" header, e.g.
 * "<abc@mail.yahoo.com>"; Gmail: "gmail:<gmail message id>"), and never
 * matches the signed ids this map is keyed by. Looking it up that way
 * always misses and silently falls back to "yahoo", misattributing every
 * Gmail candidate.
 *
 * A lookup miss returns null rather than ever guessing a provider.
 */
export function resolveSourceProvider(emailId: string, providerById: Map<string, SourceProvider>): SourceProvider | null {
  return providerById.get(emailId) ?? null;
}

/**
 * Which connected account to attribute a candidate to, given its resolved
 * provider. Kept as a pure lookup, separate from resolveSourceProvider, so
 * a wrong provider can never accidentally pull in the wrong account.
 */
export function resolveSourceAccount(provider: SourceProvider, accounts: { gmailAccountEmail: string | null; yahooEmail: string | null }): string | null {
  return provider === "gmail" ? accounts.gmailAccountEmail : accounts.yahooEmail;
}
