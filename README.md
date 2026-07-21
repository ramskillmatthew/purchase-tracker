# Purchase Tracker

Private Next.js 15 purchase and expense tracker backed by Supabase, with a read-only Yahoo Mail assistant powered by Anthropic and a review-before-import Vinted workflow.

## Security model

- Supabase Auth protects application pages and every data, export, Yahoo, Anthropic, and Vinted API route. `OWNER_EMAIL` is the only authorized account.
- Supabase secret/service-role, Yahoo app password, Anthropic key, and email-ID signing secret are server-only.
- Yahoo access uses `imap.mail.yahoo.com:993` with TLS. Connections are opened per request, bounded by timeouts, locked read-only, and closed in `finally` blocks.
- The model receives controlled, Zod-validated tools—not arbitrary IMAP commands. Email content is untrusted tool data and never treated as instructions.
- Search retrieves bounded metadata/candidates first. Full sanitized content is fetched only for selected messages or when the assistant explicitly needs it.
- Scripts, forms, event handlers, images/tracking pixels, and unsafe URL protocols are removed. Attachments are listed but never downloaded or executed.
- General email results are not persisted. Audit entries contain safe metadata only, never raw bodies, credentials, tokens, or prompts.
- Vinted syncing creates review candidates only. A separate request with `confirmed: true` and complete validated records is required to create purchases.

## Supabase setup

1. Create a Supabase project.
2. Run the existing schema/migrations in their established order for a new project.
3. Run `supabase-yahoo-email-agent.sql` in the SQL editor. It is idempotent and adds sync history, parsed candidates, audit/rate-limit tables, and Vinted duplicate constraints without replacing existing data.
4. In Authentication, create one email/password user. Set `OWNER_EMAIL` to that user's exact email address.
5. Copy the project URL, publishable/anon key, and server secret/service-role key into the variables below.

The service role bypasses RLS and is used only after server-side owner authorization. Never expose it with a `NEXT_PUBLIC_` prefix.

## Yahoo setup

1. Enable two-step verification on the Yahoo account.
2. In Yahoo account security, generate an app password for this application. Do not use the main account password.
3. Set `YAHOO_EMAIL` and `YAHOO_APP_PASSWORD` only in `.env.local` and Vercel server environment variables.
4. After signing in to Purchase Tracker, open Settings and use **Test connection**. A successful local build does not prove live Yahoo access.

Yahoo connection details are fixed to host `imap.mail.yahoo.com`, port `993`, TLS enabled. The application never sends, replies, forwards, deletes, moves, flags, or modifies mail.

## Anthropic setup

1. Create an Anthropic API key.
2. Set `ANTHROPIC_API_KEY` and a model available to your Anthropic account in `ANTHROPIC_MODEL`.
3. Keep both server-only. The browser calls authenticated application routes and never receives the API key.

## Environment variables

Copy `.env.example` to `.env.local` and fill values locally:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser-safe Supabase Auth anon/publishable key |
| `SUPABASE_SECRET_KEY` | Preferred server database secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy service-role fallback; leave blank when using the secret key |
| `OWNER_EMAIL` | Exact allowlisted Supabase Auth owner email |
| `YAHOO_EMAIL` | Yahoo mailbox address, server-only |
| `YAHOO_APP_PASSWORD` | Yahoo-generated app password, server-only |
| `ANTHROPIC_API_KEY` | Anthropic key, server-only |
| `ANTHROPIC_MODEL` | Configurable Anthropic model ID |
| `EMAIL_ID_SECRET` | Random secret of at least 32 characters used for short-lived opaque message IDs |

Generate `EMAIL_ID_SECRET` with a cryptographically secure password generator. Do not reuse another credential.

## Local development and tests

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use anonymized fixtures and do not connect to Yahoo, Anthropic, or Supabase.

## Vercel configuration

Add every applicable environment variable in **Project Settings → Environment Variables** for Production and Preview as required. Redeploy after changes. Do not mark server secrets as browser-exposed variables. Vercel functions open IMAP only during a request; there is no permanent connection. The Yahoo/assistant routes declare bounded serverless durations and process limited result pages.

Run the Supabase migration manually before using connection tests, search, or sync because rate limiting and audit storage depend on the new tables.

## Vinted workflow

1. Open **Vinted Import**, choose a date range, and sync Yahoo.
2. Review parsed candidates. Status/refund messages are identified deterministically; unknown formats are left unparsed.
3. Supply missing internal SKU, condition, size, seller, price, and other required fields. The application never invents them.
4. Select records and review the exact count, warnings, duplicates excluded, and total value.
5. Explicitly confirm. Database uniqueness constraints prevent repeated candidate, order-reference, or conservative fingerprint imports.

Large historical ranges may need narrower date windows because each serverless request intentionally processes a bounded page. General Yahoo search is temporary and does not create Vinted candidates or purchases.
