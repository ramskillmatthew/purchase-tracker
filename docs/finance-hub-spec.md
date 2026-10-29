# Finance Hub — locked product specification

Status: approved for implementation. The five approved mockups are the visual source of truth. Their example names, dates and amounts are illustrative; this document is the behavioural source of truth.

## Product boundary

Finance Hub is a GBP-only forward cash-position and commitments system for the reselling business. It is not general personal budgeting, bookkeeping, bank reconciliation software or a replacement for Sales, Purchases, Expenses or Returns. It links those records into a single operational cash view.

Tabs: Overview, Money In, Money Out, Allocations, Credit Cards, Accounts and History. The Overview also contains the 7/30/90/custom calendar and timeline. The default period is the next 30 days.

## Headline figures

- Tracked cash: sum of current manually tracked account balances.
- Pending incoming: active linked sales revenue plus active manual incoming amounts. Returned sales remain visible crossed out and contribute zero; partial refunds reduce the outstanding amount.
- Reserved: active allocation balances.
- Available after reservations: tracked cash minus reserved allocations.
- Due out: remaining active planned outgoings in the selected period, including overdue items.
- Card debt: total current balances across cards, including business and personal portions; negative balances are allowed.
- Statement balances due: only statement amounts whose due dates fall in the selected period, including overdue statements. Do not count the same card payment again as a generic planned outgoing.
- Projected position: tracked cash plus dated confirmed incoming minus dated planned outgoings minus statement balances due. Unknown-date incoming appears in total pending but not dated projections. Estimated incoming is displayed separately and excluded from the primary projection.

Every amount is stored/calculated in integer pence at the domain boundary.

## Money In and Sales synchronisation

- Eligible sale process states are `awaiting_dispatch`, `sent` and `delivered_awaiting_payout`.
- `completed` is received and removed from pending.
- `return_in_process`, `cancelled` and `returned_cancelled` contribute zero to pending.
- The Finance status is the Sales process status; it is never independently editable.
- Sales use the exact `total_revenue` from Sales, without deducting fees.
- Vinted, eBay and Other are the only Finance marketplace groups. Custom/other platforms group under Other while remaining individually visible.
- Expected arrival can be exact, a date range, unknown or blank. Sales dates can be set individually or in bulk.
- Selected completed sales can be confirmed as one combined payout. Confirmation records actual amount, destination account, received date and optional payment reference.
- A mismatch between selected expected revenue and actual receipt shows a warning and requires a permanent explanation.
- Completion marks linked items received, removes them from pending marketplace totals and credits the selected account once.
- Manual incoming supports source, Vinted/eBay/Other assignment, payment reference, description, amount, confirmed/estimated confidence, exact/range/unknown date, category, destination account, notes, attachments and partial receipts.
- Completed receipts remain permanently visible in History.
- Active returns leave the sale visible but crossed out with a warning; the warning opens the Return record. Partial refunds leave only the outstanding revenue pending.
- A later reversal/dispute creates a compensating event and reopens the amount while preserving original payout history.

## Money Out

Planned outgoing and allocation are distinct. A planned outgoing records an expected payment; an allocation protects existing money in a bank-backed pot. A planned outgoing may link to an allocation but need not be labelled covered/part-covered.

Outgoing types: planned stock purchase, planned expense, subscription/recurring expense, card payment and other business payment. Statuses: planned, partially paid, paid, cancelled and overdue.

- Payment method is optional at planning time and required when paid.
- Payments may be split across any number of accounts/cards. Each part has its own amount, date and status. The parent remains partially paid until every part is complete.
- Split payments apply to Purchases and Expenses.
- Paying from a bank immediately reduces that account.
- Paying by card increases that card's total and business portion, and is assigned to the statement cycle from its actual transaction date. It does not affect a bank until the card is paid.
- Exact, range and unknown dates are supported. Overdue commitments remain in projections.
- Monthly recurring payments create only the next occurrence, no more than one month ahead.

### Planned stock purchase conversion

The plan stores the same fields as manual Purchase entry, but uses planned payment date and creates no Purchase record before payment. It also supports the existing bulk-input workflow.

Before conversion, show a final review of actual price, quantity, purchase date and payment split. Preserve planned and actual values when they differ.

On full payment, atomically create one Purchase row per unit. All rows share one SKU equal to the greatest existing numeric Purchase SKU plus one. Quantity 50 creates 50 Purchase rows. The records retain a durable link to the originating Finance plan. Later editing/deleting one unit reverses only that unit's linked financial share when explicitly confirmed.

### Planned expense conversion

The plan stores the same fields as Expense entry. On payment, atomically creates the Expense and retains the Finance link.

## Accounts

- Accounts are manually tracked, business-use accounts. Even personally named accounts contribute fully to business cash.
- Store label/provider, optional masked details, opening/current balance, last reconciled time and archive state.
- All incoming, outgoing and allocations can target an account; manual override remains available.
- Transfers require from account, to account, amount, date, optional reference/notes and pending/completed status.
- A completed transfer debits and credits exactly once, appears in History and never counts as income, expenditure or profit.
- Reconciliation creates a clearly labelled adjustment with a mandatory reason; it never silently replaces a balance.
- Warn when an account has not been reconciled recently.

## Allocations

- Each pot belongs to one account and has a name, balance, optional target and optional deadline.
- Moving money between pots retains immutable movement history.
- Allocating beyond an account balance is allowed with a warning.
- Reserved money remains in the bank account but reduces Available after reservations.
- A linked obligation can release its allocation automatically when paid.
- Allocation is manual only; no automatic percentage rules in v1.

## Credit cards

Initial cards: Amex, Barclays and Capital on Tap; more may be added. Each stores provider/name, optional masked digits, opening/current total balance, business portion, personal portion, limit, available credit, current statement balance, statement date, payment due date and last updated time.

- Opening total/business/personal balances are entered manually. Historical Purchases are not backfilled.
- New Purchase/Expense card payments update the total and correct business/personal portion only when paid.
- Personal transactions affect the card but never business expenses/profit.
- Refunds are negative card transactions and may return to the original or a different account/card.
- Negative balances are valid and display as a negative amount owed.
- Manual corrections require the business/personal allocation and a reason.
- Deleting a linked Purchase asks whether to reverse its card/account transaction or retain it.
- Card payments support full and partial amounts, require the paying bank and reduce both bank and card balances.
- Forecast the statement balance due, not all current spending.
- Warnings: due within the configured window, less than £500 available credit and statement payment larger than available cash.
- Balance changes produce Finance notifications.

## Notifications and Tasks

The header bell opens the Finance notification feed. Events include incoming due/overdue, outgoing due/overdue, insufficient allocation, card due, card balance changed, less than £500 credit available, card due exceeding available cash, recurring occurrence created and payout variance.

Default due-soon threshold is three days, with 7-day and custom-range views. Only important overdue/deadline events create Tasks. Resolved notifications remain in completed history.

## History, deletion and files

- One searchable audit history covers automatic and manual activity, with type, account/card, source and date filters.
- Store before/after values for material adjustments.
- Attachments are optional images or PDFs.
- User-facing deletion uses an “Are you sure?” confirmation.
- Finance records use recoverable soft deletion where possible; compensating ledger entries preserve balance history.
- All mutations are owner-scoped, idempotent and atomic.

## Visual contract

- Match the approved dark desktop/mobile mockups: navigation placement, dense overview, tab order, cards, tables, timeline, chart, brand-inspired card colours, status dots and dialogs.
- Preserve the app's real Trotter's Attire header/sidebar rather than copying mockup-only navigation labels.
- Desktop and mobile have equal product priority. Mobile uses cards/agenda layouts, not squeezed desktop tables.
- No visual redesign, palette change or simplification without explicit approval.

## Mandatory final integration

- Keep Finance Hub isolated on `feature/finance-hub` while the eBay drafter is being developed in the main Purchase Tracker checkout.
- Do not leave the completed feature in the isolated worktree.
- After all Finance Hub building, database testing, functional testing and desktop/mobile visual verification are complete, merge the Finance Hub into the main Purchase Tracker application.
- Preserve Claude's eBay drafter changes during that integration, resolve any overlap deliberately, and rerun the complete application test and production-build checks after the merge.
