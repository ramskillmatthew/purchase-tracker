# Yahoo Email System Rebuild Plan

Status: **Phase 0 — planning only. No application code has been changed.**
Branch: `rebuild/yahoo-email-system`

This document is the single source of truth for the rebuild. It records the
target architecture and the exact file-level change list for every phase, so
each phase can be implemented, reviewed, and merged independently without
re-deriving the plan from scratch.

## 1. Why this rebuild exists

The current system (see audit history in this repo's conversation log / PR
description) has three independent, overlapping pipelines that each try to
solve "does this email match what the user meant" in their own way:

- **Live chat search** — `lib/anthropic/assistant.ts` + `lib/yahoo/client.ts`'s
  `imapQuery`/`imapQueries`/`countQueries`, using regex-generated sender typo
  variants and semantic subject-term guessing (`lib/yahoo/search-terms.ts`),
  then re-filtering results in JS with Levenshtein fuzzy matching
  (`lib/yahoo/query-relevance.ts`).
- **Metadata index sync** — `lib/email-index/classify.ts`'s
  `classifyIndexedEmail`, a second independent regex classifier.
- **Vinted/purchase import** — `lib/purchase-import/classify.ts`'s
  `isPurchaseConfirmationSubject`, a third independent regex classifier.

These three classifiers drift independently, live IMAP search times out or
truncates silently on broad queries, and there is no automatic indexing, so
most chat queries fall back to the slow/fragile live path. Full detail is in
the audit already shared; this document only carries the forward-looking plan.

## 2. Target architecture

One clear model, replacing the three-pipeline design:

1. **The metadata index is the only search backend.** All chat search/count
   queries read from Postgres (`email_metadata_index`), never live IMAP.
   Live IMAP is used only for (a) syncing the index and (b) fetching one
   email's full body by its signed opaque id when the user opens a result.
2. **Indexing is automatic and incremental**, driven by a scheduled job, not
   a manual "Sync metadata" button. The index is always warm.
3. **One shared classifier** is used by indexing, chat search, and
   purchase/Vinted import — no more parallel regex sets that can disagree.
4. **Claude is the only interpreter of free-text intent** for chat. The
   deterministic "planner short-circuit" that currently tries to answer
   before Claude sees the message is removed; Claude always calls a tool,
   and the tool queries the index (fast, so this is not a performance
   regression).
5. **Date-range parsing stays deterministic** (`lib/yahoo/query-dates.ts`).
   It is not part of the reliability problem — it is well-tested (39 cases)
   and used by both the chat path and the Vinted-import "instruction" field,
   which has no LLM in its loop. It is kept, not rebuilt.
6. **Sender-variant fuzzy probing for bulk IMAP scans is kept**, scoped to
   what it is actually good at: narrowing a full-mailbox metadata scan by a
   named retailer during sync (`scanYahooMetadata`). This is different from
   using fuzzy matching to decide final chat-search relevance, which is
   being removed.
7. **IMAP connection plumbing, signed message ids, HTML sanitization, auth,
   rate limiting, and audit logging are unchanged.** They are not part of
   the reliability problem this rebuild addresses.

## 3. Non-goals

- Not rebuilding the Vinted/general purchase-import **field extraction**
  regex (item/price/seller/reference parsing) — only the shared
  "is this a purchase-type email" **classification gate** they call into.
- Not changing auth, the owner-allowlist model, or the Supabase schema for
  `purchases`/`expenses`.
- Not adding multi-user support.
- Not changing the IMAP provider, connection settings, or timeouts.

## 4. Phase-by-phase file plan

Each phase should land as its own PR/commit and pass `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build` before merging.

### Phase 0 — Planning (this phase)

- **Added:** `docs/YAHOO_REBUILD_PLAN.md` (this file)
- No other files touched.

### Phase 1 — One shared classifier

Goal: a single module and a single enum for "what kind of email is this,"
used everywhere three separate classifiers exist today.

- **Added:** `lib/email/classify.ts` — merges `classifyEmailIntent`
  (currently in `lib/yahoo/search-terms.ts`), `classifyIndexedEmail`
  (currently in `lib/email-index/classify.ts`), and
  `isPurchaseConfirmationSubject`/`isPurchaseLifecycleSubject`/
  `isPurchaseCandidateSubject`/`shouldInspectPurchaseHeader` (currently in
  `lib/purchase-import/classify.ts`) into one rule set and one exported
  `EmailType` union.
- **Added:** `tests/email-classify.test.ts` — consolidated, corpus-driven
  test suite replacing the three existing classifier test files below.
- **Modified:**
  - `lib/yahoo/client.ts` — `countYahoo` imports the shared classifier
    instead of `classifyEmailIntent` from `search-terms.ts`.
  - `lib/anthropic/assistant.ts` — imports `EmailType`/classifier from the
    new shared module instead of `IndexedEmailType` from
    `lib/email-index/classify.ts`.
  - `lib/email-index/classify.ts` — keeps only `extractMetadata` and
    `entityFromSender` (not classification); re-exports `EmailType` from the
    shared module for backward compatibility with existing imports until
    Phase 2 cleans up call sites.
  - `lib/purchase-import/classify.ts` — becomes a thin re-export of the
    shared module's purchase-gate functions, or is deleted once all call
    sites (`lib/purchase-import/parser.ts`, `app/api/vinted/sync/route.ts`)
    are updated to import from `lib/email/classify.ts` directly.
  - `lib/yahoo/search-terms.ts` — `classifyEmailIntent` removed (moved);
    `searchVariants`, `senderSearchVariants`, `canonicalSender`,
    `isExactEmailAddress` remain (still used by `scanYahooMetadata` and, for
    now, by `imapQuery`/`imapQueries` until Phase 2).
  - `lib/vinted/parser.ts` — purchase/lifecycle gate calls point at the
    shared classifier.
- **Deleted:**
  - `tests/email-index-classify.test.ts` (superseded by
    `tests/email-classify.test.ts`)
  - `tests/purchase-import-classify.test.ts` (superseded)
- **Unchanged:** `tests/search-terms.test.ts` keeps its sender-variant and
  date-adjacent cases; only its `classifyEmailIntent` import/cases move into
  the new consolidated test file.

### Phase 2 — Index becomes the sole search backend

Goal: chat search/count no longer touch live IMAP; the fuzzy relevance layer
is retired.

- **Added:**
  - `supabase-email-search-index.sql` — idempotent migration adding a
    `search_vector tsvector` (or `pg_trgm`-indexed text) column and a stored
    sanitized excerpt column to `email_metadata_index`, plus the
    corresponding GIN/trigram index.
  - `lib/email-index/search.ts` — new query functions (`searchIndex`
    alongside the existing `queryIndex`/`countIndex`) that perform
    full-text/trigram search against the new column, replacing free-text
    IMAP querying.
- **Modified:**
  - `app/api/yahoo/index/route.ts` — sync now stores a short sanitized
    excerpt per message (fetched via `scanYahooMetadata`) so chat search has
    text to search over without hitting IMAP again.
  - `lib/yahoo/client.ts` — `scanYahooMetadata` extended to optionally fetch
    and sanitize a bounded excerpt; `imapQuery`, `imapQueries`,
    `countQueries`, and the free-text branches of `searchYahoo`/`countYahoo`
    are removed. `searchYahoo`/`countYahoo` are reduced to what
    `getYahooEmail`/`getYahooEmails`-adjacent flows still need (folder
    listing, id-based fetch) — effectively most of this file's query-building
    logic is deleted.
  - `lib/email-index/query.ts` — merged into `lib/email-index/search.ts` or
    kept alongside it; `entity`-based `ilike` filtering is replaced by the
    new full-text/trigram search.
- **Deleted:**
  - `lib/yahoo/query-relevance.ts` (Levenshtein relevance filtering — no
    longer needed once search happens in Postgres)
  - `app/api/yahoo/search/route.ts` (direct free-text IMAP search endpoint;
    confirmed unused by any page — nothing in `app/` fetches
    `/api/yahoo/search`)
  - From `lib/yahoo/search-terms.ts`: `semanticSubjectTerms`,
    `countSubjectTerms` (only used by the `imapQuery`/`imapQueries`/
    `countQueries` functions being deleted). `searchVariants`,
    `senderSearchVariants`, `canonicalSender`, `isExactEmailAddress` are
    **kept** — still used by `scanYahooMetadata` for sync-time entity
    narrowing.
  - `tests/query-relevance.test.ts`
  - `tests/search-terms.test.ts` cases for `semanticSubjectTerms`/
    `countSubjectTerms` (remaining sender-variant cases move to a slimmer
    `tests/search-terms.test.ts` covering only the kept functions)
- **Added tests:** `tests/email-search-index.test.ts` for the new
  full-text/trigram query functions.
- **Unchanged:** `lib/yahoo/query-dates.ts`, `lib/yahoo/tokens.ts`,
  `lib/yahoo/sanitize.ts`, `getYahooEmail`/`getYahooEmails`.

### Phase 3 — Automatic incremental indexing

Goal: the index is always warm; no manual sync button required for chat to
be fast and complete.

- **Added:**
  - `app/api/cron/yahoo-index/route.ts` — cron-triggered endpoint that syncs
    "since last completed coverage" instead of a manually chosen range.
  - `vercel.json` — cron schedule configuration invoking the above route.
- **Modified:**
  - `app/api/yahoo/index/route.ts` — `POST` handler gains an incremental
    mode (no explicit date range = sync from last coverage to today);
    manual full-range sync remains available for backfill.
  - `app/settings/page.tsx` — status copy updated to reflect automatic
    background syncing; manual button becomes "Sync now" / backfill rather
    than the only way to index.
  - `lib/email-index/query.ts` (or `search.ts` post-Phase-2) — `hasCoverage`
    usage simplified now that coverage should normally be contiguous up to
    "today."
- **Deleted:** none.

### Phase 4 — Simplify the assistant loop

Goal: remove the deterministic short-circuit; Claude always decides via
tools, and tools always query the index.

- **Modified:**
  - `lib/anthropic/assistant.ts` — remove the `planEmailQuery`/
    `indexedCoverage`/`plan.transactional` short-circuit branches; the
    `search_emails`/`count_emails` tool implementations call the Phase 2
    index-search functions (`lib/email-index/search.ts`) instead of
    `searchYahoo`/`countYahoo`; `relevantResults`/`resultMatchesQueryEntity`
    usage removed (superseded by Postgres-side matching).
  - `lib/yahoo/query-plan.ts` — trimmed to only what
    `app/api/vinted/sync/route.ts`'s free-text "instruction" field still
    needs (date range + entity extraction via `explicitDateRange` and
    `queryEntityTokens`); `operation`, `intent`, `transactional` fields
    removed since nothing consumes them after this phase.
  - `lib/yahoo/query-relevance.ts`'s `queryEntityTokens`/
    `queryRequestsTransaction` — relocate to `lib/yahoo/query-plan.ts` (or a
    new small `lib/yahoo/entity-tokens.ts`) since `query-relevance.ts` itself
    was deleted in Phase 2; these two functions are still needed by
    `query-plan.ts` for the Vinted sync instruction field.
- **Deleted:** none beyond what Phase 2 already removed.
- **Tests:** `tests/query-plan.test.ts` updated to match the trimmed
  `EmailQueryPlan` shape (drop `operation`/`intent`/`transactional`
  assertions).

### Phase 5 — Consolidate purchase-import parsing on the shared classifier

Goal: Vinted and generic purchase parsers use the one classifier from
Phase 1 as their entry gate; field-extraction regex is untouched.

- **Modified:**
  - `lib/vinted/parser.ts` — purchase/lifecycle gating calls
    `lib/email/classify.ts` instead of inline regex; extraction logic
    (title/seller/price/size/reference regex) unchanged.
  - `lib/purchase-import/parser.ts` — same; also adds currency detection
    (`£`/`GBP`/`$`/`USD`/`€`/`EUR`) instead of the hardcoded `£` assumption,
    threading a `currency` field through to `vinted_import_candidates`.
  - `supabase-yahoo-email-agent.sql` — new idempotent follow-up migration
    (or a new `supabase-purchase-currency.sql`) adding a `currency` column
    default `'GBP'` to `vinted_import_candidates` and `purchases` if not
    already present.
  - `app/api/vinted/import/route.ts`, `app/vinted-import/page.tsx` — thread
    `currency` through the review/import UI and insert payload.
- **Deleted:** none.
- **Tests:** `tests/vinted-parser.test.ts`, `tests/purchase-import-parser.test.ts`
  gain currency cases.

### Phase 6 — Regression corpus

Goal: catch classifier/parser drift automatically instead of finding out
via silent missed matches.

- **Added:**
  - `tests/fixtures/email-corpus/*.json` — de-identified real subject
    lines/snippets (retailer names genericized) spanning
    confirmation/shipping/delivery/cancellation/refund/sold across several
    retailers.
  - `tests/email-classify-corpus.test.ts` — runs the shared classifier
    against the fixture corpus and asserts expected labels.
- **Modified:** none.
- **Deleted:** none.

### Phase 7 — Observability

Goal: make truncation and fallback behavior visible instead of silent.

- **Modified:**
  - `lib/security/activity.ts` or a new `lib/security/telemetry.ts` — extend
    `audit()` calls to record which path answered a chat query (index hit
    vs. full-body fetch) and whether any bound was hit (e.g., candidate cap).
  - `lib/anthropic/assistant.ts`, `app/api/assistant/route.ts` — pass
    truncation/path metadata into the existing `audit(user.id,
    "assistant_completed", ...)` call.
  - `app/email-assistant/page.tsx` — surface a "results may be incomplete,
    narrow your search" notice when the API reports truncation (mirrors what
    `app/vinted-import/page.tsx` already does for its `truncated` flag).
- **Added:** none (reuses existing `assistant_action_audit` table).

### Phase 8 — Cutover

Goal: remove now-dead code once the new path is proven equal or better on
the Phase 6 corpus.

- **Deleted (if not already removed earlier):** any remaining unused
  exports left temporarily for backward compatibility during Phases 1–2
  (e.g., re-export shims in `lib/purchase-import/classify.ts`,
  `lib/email-index/classify.ts`).
- **Modified:** `README.md` — update the Yahoo/search description to match
  the new architecture; remove references to manual metadata sync being
  required for fast answers.

## 5. Explicitly kept, unmodified in every phase

- `lib/auth/*`, `middleware.ts` — owner allowlist and route protection.
- `lib/yahoo/tokens.ts` — signed opaque email ids.
- `lib/yahoo/sanitize.ts` — HTML sanitization.
- `getYahooEmail`/`getYahooEmails` in `lib/yahoo/client.ts` — read-by-id.
- `lib/security/activity.ts`'s `enforceRateLimit` (extended in Phase 7, not
  replaced).
- `supabase-schema.sql` and all existing `purchases`/`expenses` migrations.
- `lib/vinted/parser.ts` and `lib/purchase-import/parser.ts` field-extraction
  regex (only their classification *gate* changes, in Phase 5).

## 6. Open decisions needed before Phase 1 starts

1. Postgres full-text (`tsvector`/`websearch_to_tsquery`) vs. `pg_trgm` for
   the new search column in Phase 2 — trigram is more typo-tolerant, tsvector
   is faster for larger corpora; mailbox size here is small enough that
   either works, so this is a preference call.
2. Cron cadence for Phase 3 (hourly vs. every few hours) — trades index
   freshness against Vercel cron invocation limits on the current plan.
3. Whether Phase 6's corpus should be hand-built from the owner's own mailbox
   (de-identified) or synthetic — real subject lines will catch more, but
   need careful scrubbing before committing to the repo.
