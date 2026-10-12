# CashFlow — Money-Source Linking (Group B, Part 1) Design

Status: approved by the owner on 2026-10-12 (decisions Q2–Q6 below, data model and flows reviewed in chat).
Amends: `2026-09-04-cashflow-mvp-design.md` §4.7, §4.8, §4.9, §4.10 and the matching §16 acceptance lines (see §2).

## 1. Problem

Only `Transaction` and `Transfer` move account balances. Debts, loans, savings goals and reminders are tracking-only silos, so one real-world money movement has to be recorded twice on two pages (e.g. a loan instalment needs a `LoanPayment` + a `CASH_OUT` for the principal + an `EXPENSE` for the interest). Every forgotten half silently distorts Net Worth (`totalBalance + receivables − payables − loanOutstanding`, `lib/server/services/position.ts`) — the live dashboard shows −36,170,128 VND net worth against 1,244,872 VND of account balances. The owner asked that features be linked so money sources stay consistent and operations stay simple.

## 2. Owner decisions (2026-10-12)

| # | Question | Decision |
|---|---|---|
| Q2 | Account on debt/loan create and on payments | **Optional, pre-selected** with the most recently used account; an explicit "Không ghi vào tài khoản / Don't record in an account" choice for agreements that predate the app. |
| Q3 | Existing debts/loans | A **"Ghi vào tài khoản / Record in an account"** action on each unlinked agreement creates the matching transactions (opening + optionally each existing payment) at the account and date the user picks. Nothing is linked automatically. |
| Q4 | Editing/deleting a linked transaction from the Transactions page | **Locked.** The row shows a link badge; its menu offers "Open debt/loan" instead of edit/delete. Edits happen on the source record, which updates both sides atomically. |
| Q5 | Savings goals | A goal may be **linked to an account**: progress = that account's derived balance (read-only). Unlinked goals record **"+ contribution / − withdrawal" entries** with history instead of overwriting an absolute amount. |
| Q6 | Reminder "Đã trả / Paid" | **One tap creates the transaction** from the reminder (type, expected amount, category, account, due date). Falls back to the prefilled create form when the reminder lacks what a transaction needs. "Chỉ đánh dấu / Mark only" and "Bỏ qua / Dismiss" stay. |
| — | Storage approach | Each source row holds nullable composite FKs to the transaction(s) it created (approach 1). |

**Spec amendments.** The MVP spec's "no FK and no code path to `FinancialAccount` or `Transaction`, ever" (§4.9, §4.10, §16), "`currentProgress` is entered manually — never derived from any account balance" (§4.8, §16) and "a reminder never creates a Transaction" (§4.7) are superseded by this document. The Phase 6 plan line forbidding "just also create a transaction" is superseded likewise. Every other MVP invariant stands.

## 3. Invariants (unchanged, binding)

- Account balance is never stored — always derived from Transaction + Transfer. Goal progress for a linked goal is derived from that balance, never copied.
- Money is Prisma `Decimal`; `Transaction.amount ≥ 0`, sign only from `type`.
- Every Transaction (including every auto-created one) snapshots `vndPerUsdAtEntry`/`fxRateFetchedAt`/`fxRateEffectiveAt`/`fxRateSource` through the real FX policy (`getUsableCurrentRate`), fetched **before** the DB transaction opens, never while a row lock is held.
- Every query is scoped by the session `userId` (`requireUser()`); every new cross-table reference is a composite `(userId, id)` FK.
- `Transaction.currency` equals its account's currency.
- No cron/background jobs.

## 4. Money mapping

| Event | Transaction(s) created on the chosen account |
|---|---|
| Debt RECEIVABLE created (I lent) | `CASH_OUT` = originalAmount |
| Debt RECEIVABLE payment (I was paid back) | `CASH_IN` = payment amount |
| Debt PAYABLE created (I borrowed) | `CASH_IN` = originalAmount |
| Debt PAYABLE payment (I repaid) | `CASH_OUT` = payment amount |
| Debt written off | none (no money moves; earlier linked transactions stay) |
| Loan created with "received into account" | `CASH_IN` = principal |
| Loan payment | `CASH_OUT` = principalAmount, and `EXPENSE` = interestAmount in category **"Loan Interest & Fees"** (skipped when interest is 0) |
| Reminder occurrence "Paid" | `INCOME` or `EXPENSE` (reminder type) = expectedAmount, reminder's category, due date |

Dates: the opening transaction uses the "money moved on" date the user picks (default: today in the user's zone); payment transactions use the payment date. Notes: the user's note when given, otherwise a short label rendered once in the user's locale at creation (e.g. "Cho mượn – {person}", "Thu nợ – {person}", "Vay – {lender}", "Trả gốc – {lender}", "Lãi vay – {lender}"; English equivalents) — message keys live in `messages/{vi,en}`.

Currency: a linked agreement's currency is the account's currency; the account picker lists only active accounts whose currency matches (or, on create, choosing an account sets the agreement currency). With "Don't record", the user picks the currency (default: base currency). Cross-currency linking is out of scope.

"Most recently used account": the account of the user's latest transaction (by `createdAt`), falling back to the first active account. No new storage.

## 5. Data model (one migration per feature task; all additive)

| Model | Change |
|---|---|
| `Debt` | `openingTransactionId String?` → composite FK `(userId, openingTransactionId)` → `Transaction(userId, id)`, `onDelete: Restrict`, unique. |
| `DebtPayment` | `transactionId String?` → same FK shape, unique. |
| `Loan` | `disbursementTransactionId String?` → same, unique. |
| `LoanPayment` | `principalTransactionId String?`, `interestTransactionId String?` → same, each unique. |
| `ReminderOccurrence` | `transactionId String?` → same, unique. (No `SetNull`: a composite FK would null `userId`; the delete path clears it in application code inside the same DB transaction, `Restrict` is the backstop.) |
| `SavingsGoal` | `linkedAccountId String?` → composite FK to `FinancialAccount(userId, id)`, `onDelete: Restrict`. `currentProgress` stays in the table but is no longer read or written (deprecated; dropped in a later release). |
| `SavingsGoalEntry` (new) | `id, userId, goalId, kind (CONTRIBUTION \| WITHDRAWAL), amount Decimal(18,2) ≥ 0 (CHECK), date, note?, createdAt`; composite FK to `SavingsGoal(userId, id)`; `@@unique([userId, id])`, `@@index([userId, goalId, date])`. |
| `Category` (data) | Every user gets an `EXPENSE` category named **"Loan Interest & Fees"**: added to `DEFAULT_EXPENSE_CATEGORIES` for new users and backfilled for existing users by an idempotent SQL data migration (insert only where the user has no category of that name and type). |
| `SavingsGoalEntry` (data) | For every existing goal with `currentProgress > 0`, one `CONTRIBUTION` entry dated the goal's `updatedAt`, so derived progress equals today's figure. Idempotent. |

Migrations are generated against the local Docker database only (`DATABASE_URL` overridden inline to `postgresql://cashflow:cashflow_dev_password@localhost:5439/cashflow`) with `prisma migrate dev`; never `db push`; never against `.env`.

## 6. Behaviour

### 6.1 Shared linking core
A server-only helper creates one transaction row inside an already-open `prisma.$transaction`, given the pre-fetched FX snapshot, after locking the account with the existing `lockAccountsForUpdate` (accounts first, sorted — same lock order as `createTransaction`/`updateTransaction`). It validates: account owned by the user, active, currency matches; category (when given) owned and of the right type. `createTransaction` is refactored to use the same core so both paths stay identical.

### 6.2 Debts
- Create: optional account (+ "money moved on" date). With an account: create `Debt` + opening transaction + set `openingTransactionId`, atomically.
- Payment: optional account, pre-selected with the account of the debt's opening transaction, else the most recently used. Creates `DebtPayment` + linked transaction.
- Edit/delete a payment (new): editing amount/date/account updates the linked transaction (or creates/removes it when the account choice changes); deleting removes both. Over-payment rules of the existing service stay.
- Editing a linked debt's original amount updates the opening transaction amount in the same DB transaction.

### 6.3 Loans
- Create: optional "received into account" → `CASH_IN` principal.
- Payment dialog: total pre-filled with `scheduledPaymentAmount`; the user enters interest; principal = total − interest (the existing `total = principal + interest` CHECK stays). Optional account → `CASH_OUT` principal + `EXPENSE` interest ("Loan Interest & Fees").
- Edit/delete a payment (new): updates/removes both linked transactions; deleting the latest payment steps `nextDueDate` back by one period (the inverse of what recording it did).

### 6.4 Legacy linking ("Record in an account")
Shown on every debt without `openingTransactionId` and every loan without `disbursementTransactionId`. Dialog: account (currency-matched), opening date (default: debt creation date / loan start date), and "also record the N existing payments" (default on; each keeps its own date). Creates every missing transaction in one DB transaction. Payments that already have a transaction are skipped.

### 6.5 Transactions page
- A transaction referenced by any debt/loan link shows a badge ("Nợ: {person}" / "Vay: {lender}") and its row menu offers "Open debt/loan" instead of edit/delete. `updateTransaction`/`deleteTransaction` refuse such rows with a new error code `LINKED_TRANSACTION` (localized message); the DB `Restrict` FK is the backstop.
- Ordinary transactions gain **Edit**: the existing create form in an edit sheet, wired to `updateTransaction` through a new `updateTransactionAction` (`requireUser`, Zod, `revalidatePath`).
- Reminder-linked transactions are ordinary: editable and deletable. Deleting one clears the occurrence's `transactionId` and returns it to `PENDING` in the same DB transaction.

### 6.6 Reminders
- "Paid" (new primary action on a pending occurrence): if the reminder has an active account whose currency equals the reminder currency, and a category (required for INCOME/EXPENSE), create the transaction, set the occurrence `ACKNOWLEDGED` + `actionedAt` + `transactionId`, atomically, and show "Đã ghi giao dịch — Sửa / Transaction recorded — Edit". Otherwise open the transaction create form pre-filled from the reminder; saving it links the occurrence the same way (`createTransactionAction` accepts an optional `occurrenceId`, validated: owned, pending).
- "Mark only" (today's acknowledge) and "Dismiss" are unchanged.

### 6.7 Savings goals
- Goal form: optional "Linked account" (currency-matched; the goal currency follows the account).
- Linked goal: progress = the account's current derived balance (read-only, labelled "Automatic from {account}"); no entry buttons. ACHIEVED is computed from derived progress where the service computes it today.
- Unlinked goal: "+ Contribute" / "− Withdraw" (amount, date, note) and an entry history; entries editable/deletable; a withdrawal may not take progress below zero. Progress = Σ contributions − Σ withdrawals.
- Switching a goal between linked and unlinked keeps its entries; only the progress source changes.

### 6.8 Errors and atomicity
Every multi-row operation runs in one `prisma.$transaction`; FX is fetched before it opens; any failure writes nothing. New error codes are mapped in the existing action-error mapping with vi/en messages. All server actions call `requireUser()`; all `(app)` pages keep `requireUserOrRedirect()`.

## 7. Deployment

All migrations are additive (nullable columns, new table, inserted rows), so they are safe to apply before the new code ships. Release order, done only with the owner's explicit go-ahead at push time: (1) `pg_dump -Fc` backup of the Supabase database using a client at least as new as the server; (2) `prisma migrate deploy` against Supabase; (3) `prisma migrate status` clean; (4) push to `main` → Render auto-deploys; (5) smoke check `/api/health` and the flows in §8.

## 8. Testing

- Service tests (Vitest, local `cashflow_test`): each mapping row in §4 (types, amounts, dates, account balance deltas, FX snapshot present), atomic rollback on failure, currency mismatch refused, another user's account/agreement refused (tenant isolation), linked-transaction lock, payment edit/delete keeps both sides consistent, loan `nextDueDate` step-back, legacy linking skips already-linked payments, reminder pay + fallback + delete-returns-to-pending, goal derived progress (linked and entries), data-migration idempotency.
- Component tests where the repo pattern allows (static markup); e2e (Playwright, local `cashflow_e2e`): debt with account → balance moves; repayment → balance moves back; loan instalment → two transactions, one in "Loan Interest & Fees"; legacy "Record in an account"; transaction edit; linked transaction shows badge and no edit/delete; reminder one-tap; linked goal progress follows a transfer into the account; unlinked goal contribute/withdraw.

## 9. Out of scope (later parts)

Part 2: net-worth breakdown card, remembered defaults on the ordinary transaction form, localized default category/account-type names, loan/debt due dates in "Upcoming", debt/loan currency defaults beyond §4. Part 3: navigation regrouping. Cross-currency linking. Automatic linking of existing data.
