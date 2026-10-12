# Money-Source Linking (Group B, Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debts, loans, savings goals and reminders move (or follow) real account balances, so one money movement is recorded once and balances, net worth and agreements stay consistent.

**Architecture:** A shared server-only core inserts a transaction row inside an already-open `prisma.$transaction` (FX snapshot fetched before, account locked inside). Each source row stores nullable composite FKs to the transaction(s) it created; services create/update/delete both sides atomically. Linked transactions are locked on the Transactions page; ordinary transactions become editable. Goals either derive progress from an account balance or from contribution/withdrawal entries.

**Tech Stack:** Next.js 16.3.4 App Router (read `node_modules/next/dist/docs/` before relying on any Next API), React 19.2, Prisma 7.10 WASM client + `@prisma/adapter-pg`, PostgreSQL 16 (local Docker) / Supabase (prod), Zod 4.5 (`import * as z from 'zod'` — namespace import keeps locales out of client bundles), next-intl 4.14 (messages in `messages/{vi,en}/*.json`), Base UI / shadcn 4.21, Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-money-source-linking-design.md` (binding; read §2–§6 before starting any task).

## Global Constraints

- Branch `fix/web-fixes-2026-10` in `E:\Github\CashFlow` (already checked out). Never switch branches, never push. Stage only the files you changed (`git add <paths>`, never `git add -A`).
- **The local `.env` `DATABASE_URL` is the PRODUCTION Supabase database.** Never run `npm run dev`, `next start`, `node scripts/start-standalone.mjs`, `npm run demo:*`, or any raw `prisma migrate|db|studio` command. Create migrations ONLY with `bash "C:/Users/SingPC/AppData/Local/Temp/claude/e--Github-CashFlow/d5a052fd-5a5b-439c-a3a7-9a973586e671/scratchpad/migrate-local.sh" <migration_name>` (pins `DATABASE_URL` to `localhost:5439/cashflow` and refuses anything else). `npx prisma generate` and `npx prisma validate` are safe. Vitest is safe (local `cashflow_test`, migrated automatically). Playwright is safe only as `E2E_DATABASE_URL="postgresql://cashflow:cashflow_dev_password@localhost:5439/cashflow_e2e" CI=1 npx playwright test <specs>` with port 3000 free.
- Before every code commit run, in order: `npm run format:check`, `npm run lint`, `npm run test`, `npm run build` — all must pass. Never run two Vitest suites or two Playwright runs at once.
- Financial invariants (never weaken): no stored account balance — always derived from Transaction + Transfer; money is Prisma `Decimal`, never Float; `Transaction.amount ≥ 0`, sign only from `type`; every Transaction snapshots `vndPerUsdAtEntry`/`fxRateFetchedAt`/`fxRateEffectiveAt`/`fxRateSource` via `getUsableCurrentRate` fetched BEFORE `prisma.$transaction` opens (never while a row lock is held); `historicalAmountIn()` is the only historical conversion; every query scoped by the session `userId` via `requireUser()`; cross-table references are composite `(userId, id)` FKs; `Transaction.currency` = its account's currency; `User.isDemo` never in client-facing Zod; no cron/background jobs; every `(app)` page calls `requireUserOrRedirect()`, every server action calls `requireUser()`.
- Lock order: accounts first (sorted, via `lockAccountsForUpdate` in `lib/server/services/account-lock.ts`), then the source row (`lockDebtRow`/loan equivalent), then transaction rows — the same order the existing services use, so new paths cannot deadlock against old ones.
- Owner decisions Q2–Q6 in spec §2 are final. Money mapping = spec §4 table. Notes for auto-created transactions = the user's note, else the localized label from spec §4 rendered at creation in the user's locale.
- A calendar-date (`YYYY-MM-DD`) payment/opening date becomes a transaction instant at **12:00 in the user's IANA zone** (`localDateTimeToInstant(`${date}T12:00`, timezone)` from `lib/datetime/local-date-time.ts`), so it never crosses a day boundary in any zone.
- New user-facing strings exist in BOTH `messages/vi` and `messages/en` (key parity is tested); Vietnamese is the default UI. New error codes go through `lib/server/actions/map-action-error.ts` and `lib/ui/action-error-messages.ts` with vi/en copy.
- UI follows the owner-approved current look (AGENTS.md design line); reuse existing primitives (`AccountSelect`-style pickers, `ConfirmDialog`, sheets, `PageSkeleton`); hover fills via `bg-accent`.
- When a task relabels or adds UI, grep `e2e/` for affected selectors and update them in the same task.

---

### Task 1: Linking core, "Loan Interest & Fees" category, most-recently-used account

**Files:**
- Create: `lib/server/services/linked-transaction.ts`, `lib/server/services/linked-transaction.test.ts`
- Modify: `lib/server/services/transaction.ts` (`createTransaction` uses the core), `lib/server/defaults.ts` (+ category), `lib/server/defaults.test.ts` if present
- Create migration: `prisma/migrations/<ts>_loan_interest_category/migration.sql` (data only)

**Interfaces (produces):**
```ts
// lib/server/services/linked-transaction.ts  (import 'server-only' is not used in this repo — follow the existing service files)
import type { Prisma, Transaction, TransactionType, Currency } from '@prisma/client'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'

export interface LinkedTransactionInput {
  accountId: string
  type: TransactionType
  amount: Prisma.Decimal          // must be > 0
  date: Date                      // instant
  note: string | null
  categoryId?: string | null      // validated with the existing resolveCategoryId rules
  expectedCurrency?: Currency     // when set, the account's currency must equal it
}
/** Locks the account (lockAccountsForUpdate), validates ownership/active/currency/category, inserts one Transaction with the given FX snapshot. Must be called inside prisma.$transaction. */
export function insertTransactionInTx(tx: Prisma.TransactionClient, userId: string, input: LinkedTransactionInput, fx: UsableRateResult): Promise<Transaction>
/** Account of the user's latest transaction by createdAt that is still ACTIVE, else the first active account (same order as listActiveAccountPickerRows), else null. */
export function getMostRecentlyUsedAccountId(userId: string): Promise<string | null>
/** Finds the user's active EXPENSE category named LOAN_INTEREST_CATEGORY_NAME, creating it if missing (safety net for users created between migration and deploy). */
export function ensureLoanInterestCategoryId(tx: Prisma.TransactionClient, userId: string): Promise<string>
export class LinkedAccountCurrencyMismatchError extends Error {}  // name it consistently with the existing CurrencyMismatchError if that one fits — reuse it when its semantics match
// lib/server/defaults.ts
export const LOAN_INTEREST_CATEGORY_NAME = 'Loan Interest & Fees'
```

- [ ] **Step 1: Failing tests** in `linked-transaction.test.ts` (DB-backed, follow existing service-test fixtures; reset the FX memo with `resetFxMemoForTests()` in cleanup like other ExchangeRate-touching tests): inserts a CASH_OUT with the passed FX snapshot fields verbatim and `currency` = account currency; refuses another user's account (P2025/not-found path the existing services use); refuses an archived account (`ArchivedAccountError`); refuses `expectedCurrency` mismatch; enforces category rules (EXPENSE needs an EXPENSE category of the user); `getMostRecentlyUsedAccountId` returns the latest-used active account, skips archived, falls back to first active, null with no accounts; `ensureLoanInterestCategoryId` returns the existing category and creates exactly one when missing (idempotent across two calls). Existing `transaction.test.ts` must stay green unchanged.
- [ ] **Step 2:** `npx vitest run lib/server/services/linked-transaction.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the module by extracting the body of `createTransaction`'s `prisma.$transaction` callback (lock → `resolveCategoryId` → `tx.transaction.create` with snapshot fields) into `insertTransactionInTx`; make `createTransaction` call it. Add `LOAN_INTEREST_CATEGORY_NAME` to `DEFAULT_EXPENSE_CATEGORIES` (before `'Other'`).
- [ ] **Step 4:** Data migration: run `migrate-local.sh loan_interest_category --create-only`, then write the SQL — idempotent insert for every user lacking an EXPENSE category with that exact name (check `prisma/schema.prisma` `Category` columns and constraints; generate ids with `'c' || replace(gen_random_uuid()::text, '-', '')`; set `createdAt/updatedAt` to `now()`; respect any `archived`/status column defaults). Apply with `migrate-local.sh loan_interest_category` (or `prisma migrate dev` via the script with no new schema changes). Add a test that runs the migration SQL file twice against the test DB inside a transaction for a fixture user and asserts exactly one category results (read the file with `fs`, execute with `prisma.$executeRawUnsafe`).
- [ ] **Step 5:** Tests GREEN; four pre-commit checks; commit `feat(linking): add the shared linked-transaction core and loan interest category`.

### Task 2: Debts — schema and services

**Files:**
- Modify: `prisma/schema.prisma` (Debt.openingTransactionId, DebtPayment.transactionId — spec §5), migration via `migrate-local.sh debt_transaction_links`
- Modify: `lib/server/services/debt.ts`, `lib/validation/debt.ts`, `lib/server/actions/debt-actions.ts`, `lib/server/actions/map-action-error.ts`, `lib/ui/action-error-messages.ts`, `messages/{vi,en}/*` (labels for notes)
- Tests: `lib/server/services/debt.test.ts`, `lib/server/actions/debt-actions.test.ts` (if present), `lib/validation/debt.test.ts`

**Interfaces:**
- Consumes: `insertTransactionInTx`, `getMostRecentlyUsedAccountId` (Task 1).
- Produces:
```ts
// validation: createDebtSchema gains optional `accountId: string` and `movedOn: 'YYYY-MM-DD'` (required when accountId is set; default today client-side);
// when accountId is set, `currency` is ignored server-side and taken from the account.
// recordDebtPaymentSchema gains optional `accountId`.
export async function createDebt(userId: string, input: CreateDebtInput, providerOverride?: ExchangeRateProvider): Promise<DebtRow>
export async function recordDebtPayment(userId: string, debtId: string, input: RecordDebtPaymentInput, providerOverride?: ExchangeRateProvider): Promise<DebtPayment>
export async function updateDebtPayment(userId: string, paymentId: string, input: RecordDebtPaymentInput, providerOverride?: ExchangeRateProvider): Promise<DebtPayment>
export async function deleteDebtPayment(userId: string, paymentId: string): Promise<void>
// DebtRow gains `openingTransactionId: string | null`; each payment row gains `transactionId: string | null` and the linked account id (for pre-selecting pickers).
// actions: updateDebtPaymentAction(paymentId, input), deleteDebtPaymentAction(paymentId) — requireUser, Zod, revalidatePath('/debts') + '/accounts' + '/transactions' + '/dashboard'.
```
Rules: mapping per spec §4 (RECEIVABLE create → CASH_OUT, payment → CASH_IN; PAYABLE inverse). Note label keys e.g. `debts.linkedNote.lend|borrow|collect|repay` with `{person}`; resolve the user's locale server-side the way other server code does (`resolveLocale()` / user profile). Payment edit: keep over-payment rule (outstanding excluding this payment); changing amount/date updates the linked transaction (re-snapshot FX when amount/date/account change, same rule as `updateTransaction` R-6); switching account→none deletes the linked transaction; none→account creates one. Delete removes the transaction then the payment (or payment then transaction — whichever the FK Restrict direction requires: the payment references the transaction, so delete the payment row first, then the transaction). Write-off creates nothing. FX fetched before the DB transaction only when an account is involved. `direction`, `originalAmount` and `currency` stay immutable after creation (`lib/validation/debt.ts:71`), so spec §6.2's "editing a linked debt's original amount" never arises — `updateDebt` needs no transaction sync.

- [ ] **Step 1: Failing tests:** create RECEIVABLE with account → debt + CASH_OUT (amount, note, date at 12:00 user zone, FX fields, currency from account), account balance −amount; PAYABLE → CASH_IN +amount; create without account → no transaction, currency as chosen; payment with account → linked CASH_IN/CASH_OUT, outstanding and balance move; payment over outstanding refused and nothing written (no orphan transaction); another user's account/debt refused; archived account refused; currency mismatch refused; updateDebtPayment amount change updates the transaction amount and keeps FX rule; account→none deletes the transaction; deleteDebtPayment removes both; write-off creates no transaction; tenant isolation for update/delete payment.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Schema + migration (`migrate-local.sh debt_transaction_links`), then services/validation/actions/error mapping. **Step 4:** GREEN.
- [ ] **Step 5:** Four checks; commit `feat(debts): record debt money movements in a chosen account`.

### Task 3: Debts — UI

**Files:** `components/debts/debt-form.tsx`, `components/debts/debt-row-actions.tsx` (payment form + payment list edit/delete), `components/debts/debt-list.tsx`, `app/(app)/debts/page.tsx`, `messages/{vi,en}/debts.json`, related `*.test.tsx`, `e2e/phase7-debts-loans.spec.ts` (or the debts spec — `grep -ln "debts" e2e/*.spec.ts`).

**Interfaces:** Consumes Task 2 actions/rows; page loads `listActiveAccountPickerRows(userId)` and `getMostRecentlyUsedAccountId(userId)` in its existing `Promise.all`.

Requirements (spec §6.2, Q2): create form gets an account picker (active accounts; first option "Không ghi vào tài khoản / Don't record in an account"; pre-selected = most recently used) and a "Tiền đi ngày / Money moved on" date (default today in the user's zone, hidden when no account); currency control shows only when "don't record" is chosen (default base currency), otherwise displays the account currency read-only. Payment form gets the same picker pre-selected with the debt's opening account, else most recently used; picker lists only accounts in the debt's currency. Each recorded payment row gets Edit (same form, prefilled) and Delete (`ConfirmDialog`) — copy explains the linked transaction is changed/removed too. Remove the old warning copy that told users to record the cash movement by hand (`messages/vi/debts.json:3` and en) or rewrite it to describe the new behaviour.

- [ ] Steps: failing component tests (static markup: picker present with "don't record" option, pre-selection, currency control visibility) → implement → e2e: create a RECEIVABLE with an account and check `/accounts` balance drops; record a payment and check it rises; edit and delete a payment and check balances; create with "don't record" and check balances unchanged → four checks → commit `feat(debts): pick the money account when lending, borrowing and repaying`.

### Task 4: Loans — schema and services

**Files:** `prisma/schema.prisma` (Loan.disbursementTransactionId, LoanPayment.principalTransactionId, interestTransactionId), migration `migrate-local.sh loan_transaction_links`; `lib/server/services/loan.ts`, `lib/validation/loan.ts`, `lib/server/actions/loan-actions.ts`, error mapping, messages; tests `lib/server/services/loan.test.ts`, validation/action tests.

**Interfaces:**
- Consumes: Task 1 core + `ensureLoanInterestCategoryId`.
- Produces:
```ts
// createLoanSchema gains optional `accountId` (received into); currency from the account when set.
// recordLoanPaymentSchema gains optional `accountId`.
export async function createLoan(userId: string, input: CreateLoanInput, providerOverride?: ExchangeRateProvider): Promise<LoanRow>
export async function recordLoanPayment(userId: string, loanId: string, input: RecordLoanPaymentInput, providerOverride?: ExchangeRateProvider): Promise<LoanPayment>
export async function updateLoanPayment(userId: string, paymentId: string, input: RecordLoanPaymentInput, providerOverride?: ExchangeRateProvider): Promise<LoanPayment>
export async function deleteLoanPayment(userId: string, paymentId: string): Promise<void>
// actions: updateLoanPaymentAction, deleteLoanPaymentAction (requireUser, Zod, revalidate '/loans','/accounts','/transactions','/dashboard')
```
Rules: create with account → CASH_IN principal at `startDate` 12:00 user zone. Payment with account → CASH_OUT principalAmount + EXPENSE interestAmount in the loan-interest category (no interest transaction when interest is 0). Edit payment: update/create/delete each of the two transactions to match (FX re-snapshot rule as R-6). Delete payment: remove both transactions and the payment; if it was the latest payment by `paymentDate` (tie → createdAt), step `nextDueDate` back by exactly the period `recordLoanPayment` advanced it (inverse of the existing advance helper — `advanceByFrequency`/`addMonthsUtcClamped` with `dueDayOfMonth`); deleting an older payment leaves `nextDueDate` alone. A closed loan refuses payment edits/deletes the same way it refuses new payments today. Keep the DB CHECK `total = principal + interest`.

- [ ] Steps: failing tests for every rule above (incl. interest-0 path, step-back for latest vs older payment, tenant isolation, archived/currency refusals, rollback leaves no orphan transactions) → schema/migration → implement → GREEN → four checks → commit `feat(loans): record disbursements and instalments in a chosen account`.

### Task 5: Loans — UI

**Files:** `components/loans/loan-form.tsx`, `loan-payment-form.tsx`, `loan-payment-math.ts`, `loan-row-actions.tsx`, `loan-list.tsx`, `app/(app)/loans/page.tsx`, `messages/{vi,en}/loans.json`, tests, loans e2e spec.

Requirements (spec §6.3): create form "Nhận tiền vào tài khoản / Received into account" picker (with "don't record", pre-selected most recently used; currency follows account; currency control only for "don't record"). New-loan "Kỳ tới / Next due" must not default to today if the existing form does (default = startDate + one period — check `loan-form.tsx:51` and fix only if it defaults to today). Payment dialog: total pre-filled with `scheduledPaymentAmount`; user types interest; principal = total − interest shown live (reuse/extend `loan-payment-math.ts`, Decimal-safe string math as today); account picker (loan currency only, pre-selected with the disbursement account, else most recently used). Each payment row: Edit and Delete (`ConfirmDialog`; copy says both linked transactions change). Replace the "record cash movement by hand" warning copy (`messages/vi/loans.json:3` and en).

- [ ] Steps: failing component tests (prefill, live principal, picker options) → implement → e2e: create loan into an account → balance up; record an instalment with interest → two transactions on `/transactions` (one in "Loan Interest & Fees"), balance down by total; delete it → balances restore and "next due" steps back → four checks → commit `feat(loans): prefill instalments and pick the paying account`.

### Task 6: Legacy linking — "Record in an account"

**Files:** `lib/server/services/debt.ts`, `lib/server/services/loan.ts` (or a new `lib/server/services/legacy-linking.ts` if both grow too much), validation, actions (`linkDebtToAccountAction`, `linkLoanToAccountAction`), `components/debts/*`, `components/loans/*` (dialog), messages, tests, e2e.

**Interfaces:**
```ts
export async function linkDebtToAccount(userId: string, debtId: string, input: { accountId: string; openedOn: string /* YYYY-MM-DD */; includePayments: boolean }, providerOverride?: ExchangeRateProvider): Promise<DebtRow>
export async function linkLoanToAccount(userId: string, loanId: string, input: { accountId: string; disbursedOn: string; includePayments: boolean }, providerOverride?: ExchangeRateProvider): Promise<LoanRow>
```
Rules (spec §6.4): only for agreements without an opening/disbursement link (else refuse with a clear error); account currency must equal agreement currency; creates the opening transaction and, when `includePayments`, one transaction (two for loan payments with interest) per existing payment that has no link yet, each at its own date; all in one DB transaction with one FX fetch beforehand. Written-off debts and closed loans may still be linked (money did move). UI: action "Ghi vào tài khoản / Record in an account" in the row menu of unlinked agreements; dialog with account picker (currency-matched), date (default: debt `createdAt` calendar date in user zone / loan `startDate`), checkbox "Ghi bù N lần trả đã có / Also record the N existing payments" (default on); success hides the action.

- [ ] Steps: failing tests (opening only; with payments; skips already-linked payments; refuses linked agreement; currency mismatch; tenant isolation; rollback) → implement → e2e: an agreement created with "don't record" + one payment → link it → `/accounts` balance reflects opening and payment → four checks → commit `feat(linking): record existing debts and loans in an account on demand`.

### Task 7: Transactions page — edit, link badges, locked linked rows

**Files:** `lib/server/services/transaction.ts` (`updateTransaction`/`deleteTransaction` refuse linked rows), new `lib/server/services/transaction-links.ts`, `lib/server/actions/transaction-actions.ts` (+ `updateTransactionAction`), error mapping (`LINKED_TRANSACTION`), `components/transactions/transaction-list.tsx`, `transaction-ledger-section.tsx`, `transaction-form.tsx` / `transaction-create-panel.tsx` (edit mode in a sheet), messages, tests, `e2e/phase7-transactions.spec.ts`.

**Interfaces:**
```ts
export type TransactionLink = { kind: 'debt'; debtId: string; person: string } | { kind: 'loan'; loanId: string; lender: string }
/** One query per source table, all scoped by userId; returns links for the given ids. */
export async function findTransactionLinks(userId: string, transactionIds: string[]): Promise<Map<string, TransactionLink>>
export class LinkedTransactionError extends Error {}   // mapped to code LINKED_TRANSACTION
export async function updateTransactionAction(transactionId: string, input: CreateTransactionInput): Promise<ActionResult>
```
Rules (spec §6.5, Q4): `updateTransaction`/`deleteTransaction` call `findTransactionLinks` inside their DB transaction (after locks) and throw `LinkedTransactionError` for debt/loan-linked rows. The ledger passes each row's link to the list; linked rows show a badge ("Nợ: {person}" / "Vay: {lender}") and their menu shows only "Mở khoản nợ / Open debt" (→ `/debts`) or "Mở khoản vay / Open loan" (→ `/loans`); ordinary rows show Edit + Delete. Edit opens the existing transaction form in a sheet prefilled with the row (type, amount, account, category, date+time in the user zone, note) and submits `updateTransactionAction` (requireUser, Zod, `revalidatePath('/transactions')`, `/accounts`, `/dashboard`). Keep Task 7 of the latency plan's optimistic delete behaviour and the in-flight delete disable intact. Reminder links are NOT handled here (Task 8).

- [ ] Steps: failing service tests (linked update/delete refused, ordinary update works incl. FX R-6 rule, tenant isolation) + action tests + component static tests (badge, menu items) → implement → e2e: edit a transaction's amount and see the balance change; a debt-linked transaction shows the badge and no Edit/Delete → four checks → commit `feat(transactions): edit transactions and lock the ones a debt or loan owns`.

### Task 8: Reminders — one-tap "Paid"

**Files:** `prisma/schema.prisma` (`ReminderOccurrence.transactionId`), migration `migrate-local.sh occurrence_transaction_link`; `lib/server/services/reminder.ts`, `lib/server/services/transaction.ts` (`deleteTransaction` clears the occurrence link; `createTransaction` accepts `occurrenceId`), `lib/server/actions/reminder-actions.ts` (+ `payOccurrenceAction`), `lib/server/actions/transaction-actions.ts`, `lib/validation/transaction.ts` (optional `occurrenceId`), `components/reminders/occurrence-actions.tsx`, dashboard reminder widget if it renders occurrence actions, `components/transactions/transaction-create-panel.tsx` (prefill from query), messages, tests, reminders e2e.

**Interfaces:**
```ts
export type PayOccurrenceResult =
  | { status: 'created'; transactionId: string }
  | { status: 'needs-form'; prefill: { type: 'INCOME' | 'EXPENSE'; amount: string; currency: Currency; accountId: string | null; categoryId: string | null; date: string /* YYYY-MM-DD */; note: string; occurrenceId: string } }
export async function payOccurrence(userId: string, occurrenceId: string, providerOverride?: ExchangeRateProvider): Promise<PayOccurrenceResult>
export async function payOccurrenceAction(occurrenceId: string): Promise<ActionResult<PayOccurrenceResult>>
```
Rules (spec §6.6, Q6): `payOccurrence` creates the transaction (type = reminder type, amount = expectedAmount, category, account, date = occurrence due calendar date at 12:00 user zone, note = reminder title) and sets the occurrence `ACKNOWLEDGED`, `actionedAt = now`, `transactionId`, atomically — only when the occurrence is the user's and PENDING, the reminder has an active account with currency = reminder currency, and a category (owned, matching type); otherwise returns `needs-form`. The UI's primary "Đã trả / Paid" button calls it: on `created` show an inline "Đã ghi giao dịch — Sửa / Transaction recorded — Edit" (Edit → `/transactions` with the row's edit sheet if Task 7 supports deep-linking, else just `/transactions`); on `needs-form` navigate to `/transactions?occurrence=<id>#new` with the prefill encoded so the create panel opens prefilled, and `createTransactionAction` with `occurrenceId` links the occurrence in the same DB transaction (refuse if not the user's or not PENDING). Existing acknowledge becomes "Chỉ đánh dấu / Mark only"; Dismiss unchanged. `deleteTransaction`: if an occurrence references the transaction, set it back to `PENDING`, clear `actionedAt` and `transactionId` in the same DB transaction before deleting. Reminder-linked transactions stay editable (not covered by `LinkedTransactionError`).

- [ ] Steps: failing tests (created path with balance + FX; needs-form for missing account / archived account / currency mismatch / missing category; non-pending and other-user refused; createTransaction with occurrenceId links; delete returns occurrence to PENDING) → schema/migration → implement → e2e: a reminder with account+category → "Paid" → transaction appears and balance moves; a reminder without account → form opens prefilled → save → occurrence acknowledged → four checks → commit `feat(reminders): record the transaction when a reminder is paid`.

### Task 9: Savings goals — schema and services

**Files:** `prisma/schema.prisma` (`SavingsGoal.linkedAccountId`, new `SavingsGoalEntry` + enum `SavingsGoalEntryKind { CONTRIBUTION WITHDRAWAL }`, CHECK amount ≥ 0 via raw SQL in the migration like the loan CHECK), migration `migrate-local.sh savings_goal_entries` including the idempotent data backfill (one CONTRIBUTION per goal with `currentProgress > 0`, dated `updatedAt`, only if the goal has no entries yet); `lib/server/services/savings-goal.ts`, `lib/validation/savings-goal.ts`, `lib/server/actions/savings-goal-actions.ts`, error mapping, messages; tests.

**Interfaces:**
```ts
// SavingsGoalRow gains: linkedAccount: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED' } | null; progress: Prisma.Decimal (derived); entries?: SavingsGoalEntryRow[]
export async function addSavingsGoalEntry(userId: string, goalId: string, input: { kind: 'CONTRIBUTION' | 'WITHDRAWAL'; amount: string; date: string; note?: string }): Promise<SavingsGoalEntryRow>
export async function updateSavingsGoalEntry(userId: string, entryId: string, input: same): Promise<SavingsGoalEntryRow>
export async function deleteSavingsGoalEntry(userId: string, entryId: string): Promise<void>
export class SavingsGoalWithdrawalExceedsProgressError extends Error {}
// create/update goal schemas gain optional `linkedAccountId`; when set, goal currency = account currency; `currentProgress` input removed from create (initial amount becomes an optional first CONTRIBUTION entry) — keep the column untouched in the DB.
// actions: addSavingsGoalEntryAction, updateSavingsGoalEntryAction, deleteSavingsGoalEntryAction (requireUser, Zod, revalidate '/goals' and '/dashboard')
```
Rules (spec §6.7, Q5): linked goal progress = the account's current derived balance via the existing balance service (batch for all linked goals in one call, e.g. `getAccountBalancesForUser`); unlinked = Σ contributions − Σ withdrawals (Decimal, one grouped query); entries refused on linked goals; withdrawal (and edits/deletes of contributions) may not make progress negative; ACHIEVED derivation (`deriveSavingsGoalStatus`) uses derived progress; `updateSavingsGoalProgress` and its action are removed or turned into entry creation (choose removal + migrate its callers in Task 10; no dead code left). Remove every read/write of `currentProgress` from app code; add a schema comment marking it deprecated.

- [ ] Steps: failing tests (linked progress follows a transfer into the account; unlinked progress from entries; backfill SQL idempotent run twice; withdrawal over progress refused; entries on linked goal refused; tenant isolation; ACHIEVED from derived progress) → schema/migration → implement → GREEN → four checks → commit `feat(goals): derive savings progress from an account or contribution entries`.

### Task 10: Savings goals — UI

**Files:** `components/goals/goal-form.tsx`, `goal-row-actions.tsx`, `goal-list.tsx`, `goal-create-button.tsx`, `app/(app)/goals/page.tsx`, dashboard goal widget if it shows progress, `messages/{vi,en}/goals.json`, tests, goals e2e (`grep -ln "goals\|Tiết kiệm" e2e/*.spec.ts`).

Requirements (spec §6.7): goal form "Gắn với tài khoản / Linked account" picker (optional; first option "Không gắn / Not linked"; currency follows the account); linked goals show progress labelled "Tự động theo số dư {account} / Automatic from {account}" with no edit controls (warn if the account is archived); unlinked goals get "+ Góp / Contribute" and "− Rút / Withdraw" (amount, date default today, note) and an expandable history with edit/delete per entry; the old "update progress" control is gone; create form's initial amount (if kept) becomes the first contribution. Replace the old "tracking only" warning (`messages/vi/goals.json:3` and en).

- [ ] Steps: failing component tests → implement → e2e: create a goal linked to an account, make a transfer into that account, goal progress rises; unlinked goal: contribute then withdraw, history shows both, progress correct → four checks → commit `feat(goals): link goals to accounts and record contributions`.
