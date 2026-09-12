# Authenticated navigation: second batching pass

## Scope and measurement

Starting point: `55774e2f3ffc7c3a13dd7e663e870fce112f3aa9`, clean `main` in
`E:\Github\CashFlow`, fetched and fast-forward-only pulled before changes.
Production remains Browser → Render → Supabase. No environment, Docker,
authentication, schema, migration, financial write path or production data changes.

Measurements count `pg.Client.query` calls against the isolated local Vitest
database, including relation reads and any transaction-control commands. They
exclude authentication, rendering and provider HTTP requests. The fixture has a
VND account, expense/category, budget and recurring reminder with overdue and
upcoming occurrences; no FX conversion is needed. Baselines were measured before
changing the loaders. Assertions in `navigation-data.test.ts` retain the new
query budgets and compare the widget results with the existing service path.
No production timing or latency improvement in milliseconds is claimed.

| Page                     | Baseline SQL commands | After | Application dependency stages, before → after |
| ------------------------ | --------------------: | ----: | --------------------------------------------- |
| Dashboard                |                    51 |    28 | 5 → 3                                         |
| Accounts                 |                    22 |     7 | 3 → 3                                         |
| Transactions (unchanged) |                    12 |    12 | 2 → 2                                         |
| Reminders (unchanged)    |                    12 |    12 | 3 → 3                                         |

The original approximate 36–38/19/7/5–6 figures counted ORM operations, not all
driver SQL commands. Counts depend on populated relations and FX state; these
are reproducible fixture measurements, not universal production totals.
Transactions/Reminders use unchanged code; their present fixture measurement
also describes the baseline.

Stages describe source-level dependency chains after authentication, treating
each ORM operation as one stage. They are not measured packet counts or wall-clock
round trips: Prisma relation expansion, pool contention, transaction control and
provider cache misses can add sequential work inside a stage.

## Before and after query flow

Dashboard previously waited for current position (account read → three balance
aggregates plus four agreement reads) before starting every other widget. History
then read accounts again and issued three aggregates per month, eighteen for six
months. The longest application chain was current accounts → current aggregates
→ reminder definitions → materialization → occurrence reads.

Now all independent widgets start together. The finance branch loads accounts →
one timeline SQL command → four agreement reads. Current position reuses the
last timeline point. History reuses every point and the same account rows. Current
FX policy still finishes before the historical cache can read today's row.
The reminder branch retains definitions → materialization → occurrence reads.
Neither monthly activity nor budgets were given new financial calculators.

Accounts previously loaded active accounts, all accounts, account types and a
separate current position (including another active-account read). It then
repeated balance aggregates and separately queried account locks and future-entry
counts. Those groups cost 14 + 8 SQL commands in this fixture. It now loads all
accounts and types once → one timeline → the existing agreement reads. Active and
archived lists, labels, native balances, edit locks and the future-entry flag are
derived from those shared inputs. There is no per-account query loop.

Transactions retains its parallel ledger/accounts/categories/month-summary reads
followed by three balance aggregates. Its filters, ordering, limit, picker and
snapshot semantics are untouched. Reminders retains one materializing occurrence
read plus reminder definitions and form options. It still performs lazy,
idempotent materialization; there is no cron or globally cached reminder state.

## Every remaining Dashboard command

| Feature                                    | Commands | Purpose                                                                                                       |
| ------------------------------------------ | -------: | ------------------------------------------------------------------------------------------------------------- |
| All owned accounts                         |        1 | Opening balances, currencies, creation dates and active/archive state                                         |
| Balance timeline                           |        1 | All native balances at all cutoffs, shared with current position                                              |
| Debt rows + payment sums                   |        2 | Active receivables/payables and outstanding amounts                                                           |
| Loan rows + principal sums                 |        2 | Outstanding principal, excluding interest                                                                     |
| Monthly activity + account/category labels |        3 | Existing snapshot-based summary and group labels                                                              |
| Cash-flow trend                            |        1 | One date-range read, bucketed by the existing timezone-aware reducer                                          |
| Recent ledger + account/category labels    |        3 | Bounded, deterministically ordered transaction display                                                        |
| Budgets + category labels + expenses       |        3 | Existing budget-currency snapshot calculations                                                                |
| Savings goals                              |        1 | Current goal progress                                                                                         |
| Reminder materialization and display       |       11 | Definitions + createMany (2); two bounded occurrence/definition/account/category reads (8); overdue tally (1) |
| Total                                      |       28 | Single-currency fixture                                                                                       |

Accounts' seven commands are accounts (1), types (1), timeline (1), debt and loan
rows/payment sums (4). The agreement reads preserve the existing full-position
FX decision, including header-unavailable behavior for foreign agreements during
an outage; they were not dropped merely because the header shows account assets.

These reads are necessary for the retained service contracts, not a claim that
28 is an irreducible minimum. The low-teens target was not reached. The remaining
application opportunities are shared activity/trend/budget input scans and
consolidating repeated reminder labels. A broader shared-reducer change was
withheld after approval review flagged its financial scope; this pass keeps those
calculators and reminder read contracts unchanged. The user explicitly approved
connecting the tested, narrower Dashboard loader. Further consolidation needs
separate correctness work, not simply more `Promise.all` calls.

## Balance and FX guarantees

The old shared balance helper already grouped all accounts, but repeated three
queries for each cutoff and again for the current-position widget. The new
parameterized SQL combines the three ledger sources with `UNION ALL`, groups by
account/type/cutoff bucket and accumulates each kind in PostgreSQL `numeric`.
Prisma `groupBy` cannot express the calculated cutoff buckets/window sum. The
returned payload is bounded by accounts × cutoffs × types, not ledger length.
One command works for 1 or 100 accounts and all six points; an empty account set
does not query the ledger. This trades fewer round trips for server-side grouping;
large-ledger execution cost should still be profiled in the deployment region.

Every branch independently binds `userId` and account IDs. No input is inserted
as SQL text. Caller-supplied account rows must belong to the user. Request-local
position/history inputs validate owner and cutoff. No global financial cache was
introduced. SQL numeric maps directly to Prisma Decimal; no money passes through
Number. The original operation order remains opening balance + signed transaction
sum + incoming transfers − outgoing transfers. Transfer legs remain in native
currency. Account creation, inclusive cutoffs, future exclusion and archived
history remain intact. Transactional write-time balance validation is unchanged.

Historical FX cache reads batch distinct UTC days once; misses retain the
per-day provider/cache policy, original metadata and null chart gaps. Historical
transaction conversions still use their entry snapshots. Current position still
uses its one current-rate policy decision. Historical chart FX is never replaced
with today's rate. All date windows still come from the existing timezone helpers.

Focused coverage includes all six transaction types, full-width Decimal money,
initial balances, both transfer directions, same-currency conservation,
cross-currency legs, account creation, archives, exact boundaries, future/zero
activity, constant query count, foreign/injection-shaped inputs, FX precision,
missing days, and cached metadata. Dashboard comparisons cover current/previous
months, empty data, multiple accounts, income/expense/categories, future entries,
two tenants and Vietnam/New York month boundaries. Existing financial suites
remain part of full verification.
The Dashboard orchestration test explicitly holds current FX pending, proves
independent widgets start immediately and history waits, then checks both success
and unavailable-FX completion. No test relies on racing real provider requests.

## Navigation, authentication and indexes

Desktop shell, mobile navigation and More sheet already use `next/link`; default
prefetch is enabled. No normal tab uses a full-document reload or a forced refresh.
The persistent authenticated shell and existing page-body `loading.tsx` skeletons
already cover Dashboard, Accounts, Transactions, Transfers, Budgets, Reports,
Debts, Loans and Reminders. No visual changes or new loading delay were needed.
The cached session helper already deduplicates layout/page reads within a React
request; each page retains its own authentication guard.

Existing indexes inspected: Transaction `(userId,date)`, `(userId,accountId,date)`,
`(userId,categoryId,date)`; Transfer `(userId,date)`; account/type/category `userId`;
Budget `(userId,year,month)`; debt/loan `(userId,status)`; payments
`(userId,debtId,date)` / `(userId,loanId,paymentDate)`; reminders `(userId,active)`;
occurrences `(userId,status,dueAt)`; FX `(base,quote,effectiveDate)`.
The all-owned-account ledger batch can use the existing tenant-leading indexes.
No measured selective-transfer query justified new directional indexes, and no
production EXPLAIN was performed. No indexes or migrations were added.

## Safety and remaining bottlenecks

Vitest's existing URL comparison/prepare guards and worker override remain intact.
Tests use the isolated local `cashflow_test`, not production Supabase. No isolated
`E2E_DATABASE_URL` was configured, so Playwright is skipped. No secrets or sensitive
query parameters are logged; counting instrumentation is test-only.

Application overhead remains: overlapping widget scans, relation reads, reminder
materialization, large-ledger aggregation and rendering. These are distinct from
Render Free CPU limits, Render cold starts and the stated Singapore → Sydney
database path. Those infrastructure effects were not measured or changed here;
warm-navigation delays must not be attributed solely to cold starts. Production
still works independently of the developer laptop and local Docker.
