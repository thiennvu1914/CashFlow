# CashFlow — MVP Design Specification

Status: **Approved** (architecture and financial model approved 2026-09-04). Implementation not yet started.

## 1. Overview & Scope

CashFlow is a multi-user personal finance web application. Each registered user's financial data is completely isolated. The MVP lets a user understand what they have, where it's stored, what they earn and spend, whether they're within budget, how their position changes over time, upcoming obligations, savings progress, and debts/loans.

Repository state at design time: empty (only `README.md`), single initial commit — a greenfield build with no conflicting prior art.

## 2. Non-Goals (MVP)

No bank integrations/sync, no receipt scanning/storage, no AI categorization or advisor, no investment/crypto tracking, no shared/household accounts, no Google OAuth, no email/push notifications (budgets are in-app only), no automatic bill payment, no automatic creation of recurring transactions, no background/cron jobs anywhere in the system.

## 3. Architecture

Single full-stack **Next.js (App Router) + TypeScript** monolith — no separate backend service.

- **Data access**: Prisma → PostgreSQL. All financial reads/writes go through a service layer (`lib/server/services/*`) that takes an explicit `userId` sourced only from the verified session — never from client input.
- **Mutations**: Server Actions (`'use server'`), colocated per feature, calling the service layer.
- **Route Handlers** (`app/api/...`) used only where Server Actions don't fit: Better Auth's mount (`/api/auth/[...all]`) and the Excel export download (`/api/reports/export`, needs to stream a binary file with headers).
- **Validation**: Zod schemas shared between React Hook Form (client, UX-only) and the server action (server always re-validates independently).
- **No stored balance column, anywhere.** `FinancialAccount` has no `currentBalance` field. Balance is always computed from `Transaction` + `Transfer`. This makes "planning/tracking modules must never silently touch balances" structurally true rather than policy-enforced.
- **Naming**: Better Auth's own schema defines a model called `Account` (its OAuth/credential-linking table). To avoid collision, the user-facing financial account model is named **`FinancialAccount`** (table `financial_accounts`) at the Prisma/code level. Everywhere in the UI and product language it is still just "Account."
- **i18n**: `next-intl`, `messages/vi.json` (default) + `messages/en.json`, preference persisted on the user profile.
- **Theme**: light/dark via CSS variables + Tailwind `dark:` class, preference persisted on the user profile, mirrored to a cookie so first paint has no flash of the wrong theme.
- **Package manager**: npm. **Local dev database**: Docker Compose Postgres, `DATABASE_URL` env-configurable.

New dependencies beyond the originally proposed stack, each with a concrete reason: `date-fns-tz` (IANA-correct timezone math — `date-fns` alone can't do this, and getting it wrong silently misfiles transactions into the wrong local day/month), `nodemailer` (SMTP transport for password-reset email).

## 4. Data Model

Shared enum: `Currency = VND | USD`.

### 4.1 User (Better Auth + additionalFields)

`baseCurrency` (default VND), `locale` (default vi), `theme` (default light), `timezone` (default `Asia/Ho_Chi_Minh`), `isDemo` (default false).

`baseCurrency` is a **display/aggregation preference only** — it is never a unit that any stored financial fact depends on. `isDemo` is **server-managed only**: it is absent from every client-facing Zod schema (registration, profile update), and server actions that write profile updates construct the Prisma `data:` payload by explicitly picking allowed fields — never by spreading the parsed input object — so no code path, including future refactors, can let a client set it. It is set exclusively by `scripts/seed-demo.ts` via a direct Prisma call.

### 4.2 AccountType / Category

Both: `id, userId (NOT NULL), name, icon?, isDefault: Boolean, status(ACTIVE|ARCHIVED)`.

**Design decision**: default rows are *copied per-user* at registration (from `DEFAULT_ACCOUNT_TYPES` / `DEFAULT_CATEGORIES` constants), not stored as shared rows with a nullable owner. Every financial query is therefore `WHERE userId = session.user.id` with zero exceptions anywhere in the codebase — no `OR isSystem` special-casing that could be forgotten and turn into an isolation bug. Cost is small per-user duplication; benefit is one uniform, reviewable authorization shape everywhere.

Default AccountTypes: Cash, Bank Account, E-wallet, Savings Account, Other.
Default expense Categories: Food & Dining, Transportation, Shopping, Entertainment, Bills & Utilities, Health, Education, Family, Travel, Other.
Default income Categories: Salary, Bonus, Freelance, Investment Income, Gift, Other.

Both are **archived, not hard-deleted**, when referenced by existing activity (mirrors the archive pattern FinancialAccount already needs) — deleting one in use would either break history or force a cascading delete into financial records, neither acceptable.

### 4.3 FinancialAccount

`id, userId, name, accountTypeId, initialBalance, currency, description?, status(ACTIVE|ARCHIVED), createdAt`.

`currency` and `initialBalance` are freely editable **only** while the account has zero `Transaction`s and zero `Transfer`s referencing it (checked via a cheap `EXISTS` query; the edit form disables both fields once activity exists). Once activity exists, both are locked — a currency change would invalidate every FX snapshot recorded against that account, and an `initialBalance` change would silently rewrite historical net worth. The correction path after activity exists is an explicit `ADJUSTMENT_INCREASE`/`ADJUSTMENT_DECREASE` transaction (§5.1) — not a field edit.

Archiving requires a derived balance of exactly zero, and an `ARCHIVED` account can never receive new activity: Transaction creation/update and both ends of a Transfer verify every referenced account is `ACTIVE` server-side. Together these guarantee an archived account cannot hide money or silently regain a balance.

### 4.4 Transaction

```
id, userId, accountId, categoryId?, type, amount, currency, date, note?,
vndPerUsdAtEntry, fxRateTimestamp, fxRateSource, createdAt, updatedAt
```

`type: INCOME | EXPENSE | CASH_IN | CASH_OUT | ADJUSTMENT_INCREASE | ADJUSTMENT_DECREASE` (§5.1). `amount` is always ≥ 0 — sign is determined solely by `type`, one exceptionless rule. `categoryId` is nullable; Zod requires it only when `type` is INCOME or EXPENSE (the other four types are never part of a category breakdown). `currency` is a denormalized snapshot of the account's currency at entry — a ledger row's historical meaning shouldn't depend on a join to a (lockable but still technically mutable pre-activity) parent.

`vndPerUsdAtEntry` is captured on **every** transaction regardless of its own currency (§6), via `getLatestRate` at creation time, with the outage-fallback chain in §6.3.

### 4.5 Transfer

`id, userId, fromAccountId, toAccountId, fromAmount, toAmount, exchangeRateUsed?, date, note?, createdAt`. Its own entity — never two Transaction rows — so it is structurally impossible for a transfer to be counted as income/expense. Does not carry the `vndPerUsdAtEntry` snapshot: transfers never enter Income/Expense/Net Income aggregation, so there is no cross-currency summing need to solve for them.

When both accounts share a currency the server derives `toAmount = fromAmount` and ignores any client-supplied `toAmount`, so a same-currency transfer conserves money by construction. Only cross-currency transfers accept an explicit `toAmount` (the amount actually received), with `exchangeRateUsed` recorded for audit.

### 4.6 Budget

`id, userId, year: Int, month: Int, scope(OVERALL|CATEGORY), categoryId?, amount, currency`. `year`/`month` are plain integers, not a `DateTime` — a budget's own identity ("this is March 2026") shouldn't require any timezone math to answer; only the *query* that sums that month's transactions needs the timezone-aware boundary function (§7). `@@unique([userId, scope, categoryId, year, month])`.

### 4.7 RecurringReminder / ReminderOccurrence

`RecurringReminder: id, userId, title, type(INCOME|EXPENSE), expectedAmount, currency, categoryId?, accountId?, recurrence{frequency: ONE_TIME|WEEKLY|MONTHLY|YEARLY, interval, dayOfWeek?/dayOfMonth?/month+dayOfMonth?}, startDate, note?, active`.

**Design decision**: this unifies the product spec's "Recurring Financial Reminders" and "Bill Reminders" into one engine — read side by side, they describe the same mechanism (recurrence, category, optional account, note, status, never auto-creates a transaction) with Bills simply being the expense-focused view of it. "Bills" in the UI is a filter over `type = EXPENSE` reminders; a generic "Reminders" list shows the rest (e.g. salary). This is a considered call, not a literal transcription of two separate spec sections — easy to split later if it proves wrong in practice.

```
ReminderOccurrence: id, userId, reminderId, dueAt, status(PENDING|ACKNOWLEDGED|DISMISSED), actionedAt?
@@unique([reminderId, dueAt])
```
No status is ever stored where it can drift from reality — "overdue" is a derived display flag (`dueAt < now && status = PENDING`), never persisted.

Occurrences are materialized lazily, with no background job: whenever the Dashboard or Reminders page is read, for each active reminder the service computes due dates from `max(startDate, today − 1 recurrence interval)` through `today + 30 days`, and inserts any missing `ReminderOccurrence` rows as PENDING (`createMany` with `skipDuplicates`, backed by the unique constraint above). It only ever creates missing rows — it never touches an existing ACKNOWLEDGED/DISMISSED row, so an actioned reminder never reappears, and the unique constraint makes double-creation impossible even under concurrent requests. Backfilling from "today − 1 interval" rather than from `startDate` avoids flooding an old reminder with years of historical overdue rows the first time it's ever viewed.

### 4.8 SavingsGoal

`id, userId, name, targetAmount, currentProgress, currency, deadline?, note?, status(ACTIVE|ACHIEVED|ARCHIVED)`. `currentProgress` is entered/edited manually by the user — never derived from any account balance, per the product invariant that goals are tracking objects only.

### 4.9 Debt / DebtPayment

`Debt: id, userId, direction(RECEIVABLE|PAYABLE), person, description?, originalAmount, currency, dueDate?, status(OPEN|PARTIALLY_PAID|PAID|WRITTEN_OFF), notes?, createdAt`. No stored outstanding amount:
```
outstanding(debt) = debt.originalAmount − Σ(DebtPayment.amount WHERE debtId = debt.id)
```
`DebtPayment: id, userId, debtId, amount, date, note?` — inherits the parent Debt's currency (no cross-currency debt payments in MVP; not a realistic near-term need). **No FK and no code path to `FinancialAccount` or `Transaction`, ever** — purely a tracking sub-ledger.

### 4.10 Loan / LoanPayment

`Loan: id, userId, lender, principal, currency, interestRate, startDate, termMonths, paymentFrequency, scheduledPaymentAmount, nextDueDate, status, notes?, createdAt`. No stored outstanding principal:
```
outstandingPrincipal(loan) = loan.principal − Σ(LoanPayment.principalAmount WHERE loanId = loan.id)
```
```
LoanPayment: id, userId, loanId, totalAmount, principalAmount, interestAmount, paymentDate, note?
```
`totalAmount = principalAmount + interestAmount` enforced both in Zod and as a Postgres `CHECK` constraint (added via a raw-SQL migration snippet alongside the Prisma-managed schema — Prisma doesn't express arbitrary multi-column checks natively). Same rule as DebtPayment: tracking only, no automatic mutation of any account, ever.

### 4.11 ExchangeRate (cache)

```
id, base: Currency, quote: Currency, rate: Decimal, effectiveDate: DateTime, fetchedAt: DateTime, source: String
@@unique([base, quote, effectiveDate])
```
Append-only. `effectiveDate` is stored at UTC midnight for the calendar date the rate represents (the date the provider states, falling back to today's UTC date if the provider doesn't state one). Full design in §6.

### 4.12 Tenant isolation at the schema level

Service-layer `WHERE userId = session.user.id` is the primary mechanism everywhere, but every relation between two user-owned entities additionally uses a **tenant-scoped composite foreign key**, so a cross-user reference is rejected by Postgres itself, not only by application logic:

```prisma
model FinancialAccount {
  id     String @id @default(cuid())
  userId String
  @@unique([userId, id])
}

model Transaction {
  id         String   @id @default(cuid())
  userId     String
  accountId  String
  categoryId String?
  date       DateTime
  account    FinancialAccount @relation(fields: [userId, accountId], references: [userId, id])
  category   Category?        @relation(fields: [userId, categoryId], references: [userId, id])
  @@index([userId, date])
  @@index([userId, accountId, date])
  @@index([userId, categoryId, date])
}
```

Applied the same way to: `Transfer`→(`FinancialAccount` ×2 for from/to), `Budget`→`Category`, `RecurringReminder`→(`Category`, `FinancialAccount`), and `userId` is denormalized onto `DebtPayment`/`LoanPayment`/`ReminderOccurrence` with the same composite-FK back-reference to their parent. Concretely: if application code ever had a bug letting `Transaction.userId = A` with `accountId` pointing at an account owned by `B`, the insert is rejected at the database — no row exists in `FinancialAccount` with the exact pair `(userId=A, id=<B's account>)`.

Indexes: `Transaction(userId, date)`, `(userId, accountId, date)`, `(userId, categoryId, date)`; `Transfer(userId, date)`; `ReminderOccurrence(userId, status, dueAt)`; `Budget` unique as above; `DebtPayment(userId, debtId, paymentDate)`; `LoanPayment(userId, loanId, paymentDate)`.

## 5. Financial Calculation Rules

### 5.1 Transaction types and their effects

| Type | Balance | Income report | Expense report | Net Income (Income−Expense) |
|---|---|---|---|---|
| INCOME | + | ✅ | — | ✅ |
| EXPENSE | − | — | ✅ | ✅ |
| CASH_IN | + | ❌ | ❌ | ❌ |
| CASH_OUT | − | ❌ | ❌ | ❌ |
| ADJUSTMENT_INCREASE | + | ❌ | ❌ | ❌ |
| ADJUSTMENT_DECREASE | − | ❌ | ❌ | ❌ |
| Transfer (separate entity) | ± both sides | ❌ | ❌ | ❌ |

CASH_IN/CASH_OUT cover real cash movements that are neither income nor expense — receiving loan proceeds, collecting a receivable, paying loan principal. ADJUSTMENT_INCREASE/DECREASE cover balance corrections and post-activity initial-balance fixes (§4.3). None of the four non-P&L types can inflate or deflate Income, Expense, or Net Income — structurally, by the table above, not by convention.

```
balance(account) = initialBalance
  + Σ(INCOME) − Σ(EXPENSE)
  + Σ(CASH_IN) − Σ(CASH_OUT)
  + Σ(ADJUSTMENT_INCREASE) − Σ(ADJUSTMENT_DECREASE)
  + Σ(transfers in, toAmount) − Σ(transfers out, fromAmount)
```

Because nothing but Transaction + Transfer feeds this formula, editing or deleting either automatically produces the correct balance everywhere on next read — no reconciliation code, no drift.

### 5.2 Current position vs. historical activity — the governing FX rule

This distinction is used throughout the architecture, not just for Transactions:

| | Uses | Applies to |
|---|---|---|
| **Current position** | latest live rate (`getLatestRate`) | Total Account Balance, Net Worth "now", Account Balance Distribution |
| **Historical activity** | each transaction's own FX snapshot, never today's rate | Monthly Income/Expense KPIs (including the current in-progress month — a recorded transaction is a fixed fact the moment it's entered), Net Income + its trend, Expense by Category, Income vs Expense, Reports (all periods), Budget progress (any month, open or closed) |
| **Historical position trend** | the rate that was actually in effect on that past date (`getHistoricalRate`), never today's rate | Account Balance Over Time |

**Why this matters** (the specific bug being prevented): a January transaction of 2,500,000 VND recorded at 25,000 VND/USD has a fixed historical value — 100 USD, or 2,500,000 VND. If today's rate later becomes 27,000 VND/USD, the January report must still show 2,500,000 VND / 100 USD, never a re-derived 2,700,000 VND. Today's rate must never change the value of a historical Income/Expense report, and the same reasoning extends to historical points on the Account Balance Over Time chart — computing a past net-worth point with today's rate would reproduce the identical bug in a different widget.

### 5.3 Historical conversion — `historicalAmountIn`

One pure function, the only place this math happens, used for every historical/activity aggregation:

```
historicalAmountIn(target: Currency, tx: {amount, currency, vndPerUsdAtEntry}): Decimal
  if tx.currency === target:                    return tx.amount
  if tx.currency === 'USD' && target === 'VND': return tx.amount * tx.vndPerUsdAtEntry
  if tx.currency === 'VND' && target === 'USD': return tx.amount / tx.vndPerUsdAtEntry
```

It takes no dependency on `User.baseCurrency` or the live rate — only the row itself. Report/budget aggregation fetches the relevant transactions and reduces them through this function in the service layer (application code, not raw SQL — see §17 for the scale assumption behind this choice); each row contributes using *its own* snapshot, so a mixed-currency sum stays correct regardless of when it's computed.

### 5.4 Net Worth

```
netWorth = Σ(account balances, own currency → baseCurrency @ current rate)
  + Σ(open receivables outstanding, own currency → baseCurrency @ current rate)
  − Σ(open payables outstanding, own currency → baseCurrency @ current rate)
  − Σ(outstanding loan principal, own currency → baseCurrency @ current rate)
```
With exactly two supported currencies, this converts directly VND↔USD at the current rate — no intermediate pivot currency is needed. (If a third currency is ever added, that is the point at which a proper reference-currency pivot gets reintroduced for both position and activity math — a contained, well-understood generalization, not a redesign.)

### 5.5 Budget progress

For any month — open or closed — budget consumption sums that month's EXPENSE transactions via `historicalAmountIn(budget.currency, tx)`: each transaction's own snapshot, never today's rate. A closed month's percentage is permanently fixed; only the open month's total grows as new transactions are added to it.

### 5.6 Dashboard terminology

The Income−Expense KPI is named **Net Income** (not "Net Cash Flow") — the calculation is unchanged, but "Net Cash Flow" would misleadingly imply it accounts for loan/debt/adjustment movements, which it deliberately excludes. The "Cash Flow Trend" chart keeps its name (from the original product scope) but its third series is labeled "Net Income." A second metric — "Net Account Movement" (all external balance-increasing movements minus all external balance-decreasing movements, excluding transfers) — is deliberately **not** built for MVP; it may be added later only if it materially improves the dashboard.

## 6. Currency & Foreign Exchange

### 6.1 Provider abstraction

```
type CurrencyPair = { base: Currency; quote: Currency }   // MVP: VND/USD only

interface RateResult { rate: Decimal; effectiveDate: Date; fetchedAt: Date; source: string }

interface ExchangeRateProvider {
  getLatestRate(pair: CurrencyPair): Promise<RateResult>
  getHistoricalRate(pair: CurrencyPair, date: Date): Promise<RateResult | null>
}
```

The two methods are deliberately distinct rather than one `getRateAsOf(date)`: an append-only cache can only ever answer "the latest rate we happen to have fetched," which is not the same as "the rate that was genuinely in effect on an arbitrary past date." `getHistoricalRate` may legitimately return `null` if the concrete provider has no historical data for that date — callers must never substitute the live rate in that case (§6.4).

Default concrete provider candidate: `open.er-api.com` for `getLatestRate` (free, no key, includes VND). **Whether it — or any candidate — supports date-based historical lookups for VND/USD is unverified and must be confirmed during Phase 3 implementation against the live API.** If it doesn't, swap to a provider that does (e.g. Frankfurter, exchangerate.host) behind this same interface, with no change to any calling code. If no free provider is found to support historical VND rates at all, that limitation is documented and `getHistoricalRate` simply returns `null` for all dates — Account Balance Over Time then shows gaps rather than fabricated history, which is the correct degraded behavior, not a blocker to shipping.

### 6.2 Cache

All rates — latest or historical — live in the single `ExchangeRate` table (§4.11), keyed by `(base, quote, effectiveDate)`. "Latest" is simply the row where `effectiveDate` = today. A historical row, once correctly retrieved, is an immutable fact and is cached permanently (no re-fetch, no expiry).

`getHistoricalRate(pair, date)`: check cache for an exact `effectiveDate = date` match → if absent, call the provider's historical endpoint for that date → if the provider has no rate for that exact date (e.g. a weekend/holiday) but is generally historical-capable, it is expected to return its own nearest-prior-trading-day value (standard FX provider behavior) which is cached under the *requested* date → if the provider returns nothing at all, return `null`.

### 6.3 Outage handling — Transaction creation (entry-time snapshot)

Every Transaction requires `vndPerUsdAtEntry`, regardless of its own currency. On creation:

1. Call `getLatestRate` for a fresh rate.
2. If the live call fails, fall back to the most recent cached row for the pair whose `effectiveDate` is **within the last 48 hours** (`getUsableCurrentRate` / `MAX_FALLBACK_STALENESS_MS`) — persist its *actual* original `fetchedAt` and `source` (labeled `cache-fallback:<original source>`, with `isFallback: true` so the UI can say the figure may be out of date), never "now." The window is measured on `effectiveDate`, not `fetchedAt`: a historical row cached minutes ago for a chart point years back has a recent `fetchedAt` and an ancient rate, and only an `effectiveDate` filter excludes it. Rows dated in the future are excluded too. An outage is measured in hours, not days; beyond that window it is more honest to fail than to snapshot a stale figure as if it were current.
3. Persist whatever real rate/timestamp/source was actually used.
4. Never invent a rate, never default to 1, never hardcode a conversion.
5. If no cached row qualifies *and* the live call fails, the transaction-creation operation fails clearly and recoverably (a retryable error surfaced in the UI) rather than storing a financially incorrect snapshot.

In practice, step 5 should be rare: dashboard and other read paths also call `getLatestRate`, so by the time a user creates their first transaction a cached rate almost always already exists.

### 6.4 Historical rate unavailability — Account Balance Over Time

For each past chart point, `getHistoricalRate(pair, date)` is called. If it returns a rate, that point is plotted normally. If it returns `null`, that point is rendered as a **gap** in the chart — the UI never substitutes today's rate to fill it in.

## 7. Timezone Handling

`User.timezone: String @default("Asia/Ho_Chi_Minh")`. Instants are always stored in UTC (`timestamptz`, Prisma's default `DateTime` mapping) — what changes is how period *boundaries* are computed. One function, used everywhere a period matters:

```
getPeriodBounds(timezone, period, referenceDate) → { startUtc, endUtc }
```
covering day/week/month/quarter/year, with `weekStartsOn: 1` (Monday) throughout, implemented via `date-fns-tz` for genuine IANA-correct conversion (not a hardcoded offset). This governs Report filter ranges, which local month a Budget's transactions fall into, and reminder due-date computation.

## 8. Authentication, Email & Security

**Auth**: Better Auth, email+password only (no Google OAuth). Register, login, logout, forgot/reset/change password, profile. Secure session cookies (`httpOnly`, `sameSite=lax`, `secure` in production). CSRF via Better Auth + Server Actions' built-in origin checks. Rate limiting on auth endpoints via Better Auth's built-in mechanism. Reset tokens single-use, short expiry (Better Auth default behavior). No mandatory email verification for MVP (addable later without a schema change).

**Email delivery**:
```
interface EmailSender { send(msg: { to: string; subject: string; html: string }): Promise<void> }
```
Dev: `ConsoleEmailSender` logs the reset link to the server console — nothing else required locally. Prod: SMTP via `nodemailer`, configured by `SMTP_HOST/PORT/USER/PASSWORD`, `EMAIL_FROM`. Wired into Better Auth's password-reset email hook. Forgot Password is not considered complete until the reset link is actually observable end-to-end (console in dev, real inbox in prod) and completes a real password change.

**General security**: `requireUser()` helper wraps the verified session; a client-supplied userId is never trusted for authorization. Zod validation is always re-run server-side. Prisma parameterizes all queries — no raw SQL string concatenation (the one deliberate exception, the `CHECK` constraint in §4.10, is static DDL, not query input). Secrets live in `.env` (gitignored), with `.env.example` committed as placeholders. No financial payloads, tokens, or passwords appear in logs — errors log class/stack only. Tenant isolation is enforced both at the service layer and at the schema level (§4.12).

## 9. Route Structure

```
(auth): /login  /register  /forgot-password  /reset-password/[token]
(app):  /dashboard  /transactions  /transfers  /accounts  /categories
        /budgets  /reminders (tabs: Reminders | Bills)  /goals  /debts  /loans
        /reports  /settings (profile, password, currency/locale/timezone/theme)
```
Most CRUD happens in modals/sheets over the relevant list page rather than dedicated create/edit routes. `app/api/auth/[...all]` and `app/api/reports/export` are the only Route Handlers.

## 10. Component/Module Structure

```
app/(auth)/...                 app/(app)/<feature>/page.tsx
components/ui/                 shadcn primitives, restyled — not the stock look
components/layout/             AppShell, Sidebar, MobileNav, AddTransactionFab
components/<feature>/          feature-scoped UI
lib/server/services/           balance.ts, transfers.ts, networth.ts, budget.ts, fx.ts, reminders.ts
lib/server/actions/            'use server' mutations — thin, call services
lib/validation/                zod schemas, shared client+server
lib/currency/                  ExchangeRateProvider + implementation, historicalAmountIn
lib/datetime/                  getPeriodBounds and related timezone utilities
lib/i18n/
prisma/schema.prisma, migrations/, seed-demo.ts, clear-demo.ts
messages/vi.json, en.json
```
The service layer is where every financial invariant lives and is the primary unit-test target; feature UI stays thin.

## 11. UI Design System

Manrope via `next/font/google` (self-hosted, no runtime external font request). Tabular numerals (`font-variant-numeric: tabular-nums`) applied globally to monetary/numeric displays. The approved light/dark palette wired as CSS variables into the Tailwind theme; shadcn primitives installed but re-skinned, not stock. Small/moderate radii (~6–10px), flat elevation via thin borders rather than large shadows, Lucide icons used functionally only — no emoji-as-icon, no decorative gradients or glassmorphism.

Desktop: collapsible sidebar/rail grouped Overview / Money / Planning / Reports / Settings. Mobile: bottom tab bar (Dashboard, Transactions, Reports, More) with a raised, centered Add-Transaction action — an intentionally designed pattern, not a shrunk sidebar. Dashboard: compact KPI tiles (not oversized hero numbers) plus a grid of the ten distinct chart widgets from the product scope, each in a quiet, thinly-bordered section rather than everything wrapped in a heavy card. The `dataviz` skill's palette/accessibility methodology is applied on top of the brand colors when charts are actually implemented (e.g. the ~8–10 distinguishable category colors needed for Expense by Category).

## 12. Excel Export

Full workbook sheets: **Summary, Accounts, Transactions, Transfers, Budgets, Savings Goals, Debts, Debt Payments, Loans, Loan Payments, Reminders.** Categories/AccountTypes are deliberately not separate sheets — they're reference data already denormalized as name columns on the sheets that use them. Filtered export remains Transactions + a period Summary sheet only.

The workbook builder is an extensible registry of per-sheet builder functions, populated incrementally as modules land (§14) rather than built all at once — by the end of Phase 6 the full workbook matches the complete sheet list above.

## 13. Demo Data

`scripts/seed-demo.ts` / `scripts/clear-demo.ts`. Both refuse to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED_IN_PRODUCTION=true` is explicitly set (a deliberately unambiguous flag name). The demo user is identified by `User.isDemo` (server-managed only, §4.1) rather than an email-string match; `clear-demo.ts` deletes precisely `WHERE userId = <demo user's id>`, never touching real users. Demo data is documented inline in both scripts as development-only and safe to delete.

## 14. Implementation Phases

| Phase | Scope |
|---|---|
| 0 | Bootstrap: Next.js/TS/Tailwind/shadcn, Prisma + local Postgres (docker-compose), design tokens, i18n scaffold, timezone-aware period-bounds utility as a foundational service |
| 1 | Auth & tenancy: Better Auth, `requireUser()`, protected routes, rate limiting, `User.timezone`, `EmailSender` abstraction (console dev + SMTP prod adapters) — Forgot Password not done until the link is observably deliverable |
| 2 | Core money model: Accounts, Categories, Transactions (6-type model), Transfers, balance engine (TDD-heavy); account currency/initialBalance locking; tenant-scoped composite FKs established as the standing convention from here on |
| 3 | Currency & FX: `ExchangeRateProvider` (`getLatestRate` + `getHistoricalRate`), append-only cache, outage fallback chain, `historicalAmountIn`; verify the concrete provider's historical-date support, swap if needed |
| 4 | Dashboard v1 + Reports + Excel export: everything derivable from the core model + FX; export builder designed as an extensible sheet-registry from the start; Income/Expense widgets correctly filtered to those two types only |
| 5 | Budgets: overall + category monthly budgets, progress via `historicalAmountIn` for any month; Budget Progress widget; Budgets sheet added to the export registry |
| 6 | Planning modules: Recurring Reminders/Bills (idempotent lazy materialization), Savings Goals, Debts + DebtPayments, Loans + LoanPayments (both derived-outstanding); their dashboard widgets; remaining sheets added to the export registry, completing the full workbook |
| 7 | i18n completeness, theme polish, responsive/mobile navigation pass, accessibility pass |
| 8 | Demo data scripts (guarded from the moment they're written, not retrofitted), final security review, hardening |

## 15. Testing Strategy

- **Unit (Vitest)**: balance calculation across all six transaction types; `historicalAmountIn` round-trip correctness, explicitly proven stable when "today's rate" changes; transfer consistency; net worth; budget progress FX-stability across a rate change; recurrence next-due-date math including month-length edge cases; timezone boundary correctness across at least two different IANA zones; idempotent occurrence materialization including no-resurrection-after-dismiss; debt/loan outstanding derivation; account currency/initialBalance lock enforcement; the FX outage fallback chain including the hard-failure-with-no-cache case.
- **Integration**: server actions against a real local/CI Postgres (not SQLite, to keep Decimal/relations faithful); a direct test proving a cross-tenant reference is rejected at the database constraint level, not merely by application logic.
- **Component (RTL)**: transaction and transfer forms, including currency handling.
- **E2E (Playwright)**: register → login → add account → add transaction → dashboard reflects it; transfer correctness; budget threshold states (50/80/100/exceeded); Excel export; forgot-password round trip visible via the console adapter in dev.
- Manual dev-server click-through for every UI milestone before it is called done.

## 16. MVP Acceptance Criteria

- Auth (register/login/logout/reset/change password) works end-to-end; a reset email is actually observable (dev console / prod inbox) and the link completes a real password change.
- Balances always match the derived formula (§5.1), including after edits/deletes.
- All six transaction types classify correctly per the table in §5.1; loan/debt/adjustment cash movements never appear in Income or Expense.
- Transfers never appear as income/expense, including cross-currency transfers.
- Categories/AccountTypes: default + custom, per-user isolated, archivable rather than hard-deletable.
- Changing `User.baseCurrency` does not rewrite any Transaction row (verified: `updatedAt`/content unchanged before vs. after); the underlying historical economic value is unchanged (`historicalAmountIn` returns the same figures regardless of when called or what today's rate is); the *displayed* number correctly changes denomination.
- Budgets show correct 50/80/100/exceeded states; a closed month's budget percentage does not change when today's FX rate changes.
- Account Balance Over Time never substitutes today's rate for an unavailable historical point — it shows a gap instead.
- Reminders/Bills surface when due and can be acknowledged/dismissed without ever creating a transaction; occurrences are never duplicated and never resurface after being actioned.
- Savings goals track manually; they never move money.
- Debts/Loans track outstanding amounts (always derived from payment history, never stored/drifting) and payment history without touching account balances.
- `FinancialAccount.currency`/`initialBalance` are rejected for direct edit once any activity exists; correction requires an ADJUSTMENT transaction.
- A direct attempt to make a Transaction reference another user's Account/Category fails at the database level, proven by an integration test — not merely blocked in application code.
- Dashboard renders all specified widgets correctly on desktop/tablet/mobile, with the Income−Expense KPI labeled "Net Income."
- Reports filter correctly across all periods (in the user's timezone, Monday-start weeks) and export to Excel — filtered (Transactions + summary) and full (all eleven sheets from §12).
- VND/USD both work, with a visible "rate last updated" indicator and graceful degradation on provider outage (§6.3) that never fabricates a rate.
- UI defaults to Vietnamese, switches to English, persists; theme persists.
- `isDemo` cannot be set through any client-facing input; demo seed/clear scripts refuse to run under `NODE_ENV=production` without the explicit override flag, and clear only the demo user's own data.
- No secrets committed; passwords hashed; sessions secure.

## 17. Risks, Assumptions & Deferred Items

- **FX provider historical-date support is unverified** until it's checked against a live API in Phase 3. If unsupported, `getHistoricalRate` returns `null` universally and Account Balance Over Time shows gaps for all past points — a documented degradation, not a launch blocker.
- Free-tier FX APIs can have uptime hiccups; mitigated by the cache + fallback chain in §6.3, which hard-fails only on true cold-start-plus-outage (expected to be rare).
- `historicalAmountIn` aggregation is done in application code (fetch + reduce), not raw SQL — acceptable at the assumed personal-use data scale (thousands, not millions, of transactions per user); a documented future optimization if that assumption breaks.
- No cron/background jobs anywhere in MVP by design — reminders and Account Balance Over Time are both computed lazily on read.
- **True historical Net Worth is deferred.** The historical chart is deliberately named "Account Balance Over Time" and reconstructs *account balances only* as of each past point. The Net Worth KPI additionally includes active receivables, payables and outstanding loan principal, whose *past* state is not modeled (Debt/Loan have no temporal status history). Labeling the chart "Net Worth Over Time" would silently use a different formula from the KPI; approximating past liabilities with today's outstanding values would fabricate history. Both are rejected — a genuine historical Net Worth chart requires modeling liability state as-of every point and is out of MVP scope.
- Single-instance in-memory rate limiting won't scale to a multi-instance deployment; a follow-up concern if horizontally scaled later.
- Unifying Recurring Reminders and Bill Reminders into one engine (§4.7) is a considered design call, not a literal spec transcription — flagged as reversible if it proves wrong in practice.
- DebtPayment/LoanPayment always inherit their parent's currency; no cross-currency payment support in MVP.
- Better Auth's API surface should be reverified against current docs at implementation time rather than relying on possibly-stale knowledge.
