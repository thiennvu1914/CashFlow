import { Prisma } from '@prisma/client'
import type { Loan, LoanPayment, LoanStoredStatus, Transaction } from '@prisma/client'
import { createTranslator } from 'next-intl'
import { prisma } from '@/lib/prisma'
import { getUsableCurrentRate, type UsableRateResult } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { advanceByFrequency, retreatByFrequency } from '@/lib/datetime/add-months-clamped'
import {
  calendarDateToUtcCarrier,
  compareCalendarDates,
  formatCalendarDate,
} from '@/lib/datetime/calendar-date'
import { calendarDateToEntryInstant, instantToLocalDateTime } from '@/lib/datetime/local-date-time'
import type { Locale } from '@/lib/i18n/locale'
import {
  createLoanSchema,
  recordLoanPaymentSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type RecordLoanPaymentInput,
  type UpdateLoanInput,
} from '@/lib/validation/loan'
import enLoanMessages from '@/messages/en/loans.json'
import viLoanMessages from '@/messages/vi/loans.json'
import { lockAccountsForUpdate } from './account-lock'
import {
  LinkedAccountCurrencyMismatchError,
  SNAPSHOT_PAIR,
  ensureLoanInterestCategoryId,
  insertTransactionInTx,
} from './linked-transaction'
import { ConcurrentModificationError, lockAndVerifyTransactionRow } from './transaction'

/**
 * Loan service (spec §4.10) — money the user owes a lender, and the instalments
 * they have recorded against it.
 *
 * Six invariants live here and are never delegated to the UI:
 *
 * 1. **Money moves only through an account the user chose** (money-source
 *    linking, spec 2026-10-12 §4 and §6.3, which supersedes §4.10's "tracking
 *    only"). Creating a loan *received into* an account writes a CASH_IN of the
 *    principal in the same database transaction; recording an instalment *paid
 *    from* an account writes a CASH_OUT of its principal part and an EXPENSE of
 *    its interest part, filed under "Loan Interest & Fees" — each through the
 *    shared core `insertTransactionInTx`, and each linked with a composite,
 *    `ON DELETE RESTRICT` foreign key. A part of zero writes no transaction (an
 *    interest-only instalment has no CASH_OUT, a 0 % one no EXPENSE). *Without*
 *    an account (a loan that predates the app, or money that never touched a
 *    tracked account) the loan is bookkeeping about an agreement with a lender
 *    and nothing else is written. Editing or deleting an instalment keeps all
 *    three rows in step; closing a loan moves no money and creates nothing.
 * 2. **Outstanding principal is derived, never stored.** `principal − Σ
 *    principalAmount`, computed on read (spec §5, "never store what can drift").
 *    A stored copy would be a second source of truth that a rolled-back write, a
 *    deleted payment or a concurrent request could put out of step with the
 *    payment rows themselves — the same reasoning that keeps account balances
 *    derived.
 * 3. **Every instalment is a split, and only the principal part pays the loan
 *    down.** `totalAmount = principalAmount + interestAmount` is checked at
 *    three layers — Zod in exact cents before the request is trusted
 *    (`lib/validation/loan.ts`), a `Prisma.Decimal` re-check inside the locked
 *    transaction here, and the `LoanPayment_total_matches_split` CHECK a direct
 *    insert still has to answer to. Interest is the *cost* of the loan and
 *    reduces nothing, which is exactly why a single-`amount` payment model (as
 *    `debt.ts` has) would be wrong for a loan: the outstanding figure would fall
 *    by the interest too, and the loan would look repaid years early.
 *    An interest-only instalment (`principalAmount = 0`) is a real product
 *    — grace periods, and the early months of many loans — so it is accepted
 *    (ruling R6-6).
 * 4. **No principal overpayment, ever.** A principal part above what is still
 *    owed is refused (`LoanOverpaymentError`); exactly what is left is accepted.
 *    That is a cross-row invariant, so no CHECK constraint can express it and it
 *    is enforced here — under a row lock, see below. Interest is *not* capped:
 *    a fully repaid loan can still owe a final interest charge.
 * 5. **The schedule never drifts.** `nextDueDate` advances by exactly one
 *    interval per accepted instalment, computed from `dueDayOfMonth` — the
 *    anchor day captured at creation (ruling R6-6a). A loan due on the 31st
 *    therefore reads Jan 31 → Feb 28 → Mar 31, not Jan 31 → Feb 28 → Mar 28 (a
 *    plain clamp) and not Jan 31 → Mar 2 → Apr 1 (`+30 days`). See
 *    `lib/datetime/add-months-clamped.ts`, which is where that arithmetic and
 *    its reasoning live.
 * 6. **Money is `Prisma.Decimal` end to end.** Every amount that enters is built
 *    with `new Prisma.Decimal(String(...))` so a 2-decimal input is exact, and
 *    there is no `toNumber()` anywhere in this file. Each loan keeps its own
 *    currency and nothing here converts one (`User.baseCurrency` is display-only,
 *    ledger ruling R5-3): a linked account must already hold the loan's
 *    currency (`LinkedAccountCurrencyMismatchError` otherwise), and a loan
 *    created with an account simply takes that account's currency. The only FX
 *    involved is the USD/VND snapshot every Transaction carries.
 *
 * `interestRate` is stored and never used: it is percent per year, informational,
 * so the loan's terms are visible next to its history. Nothing here computes
 * interest or an amortisation schedule from it — the user reads their instalment
 * off their own loan statement and types the principal and interest parts in.
 * Deriving figures the bank did not charge would be inventing them.
 *
 * `userId` always arrives as an argument (server actions pass `requireUser().id`)
 * and scopes every query — including the raw locking `SELECT` below. Every
 * single-row lookup goes through the composite `userId_id` key, so another user's
 * loan, instalment or account id is a P2025, never a usable reference. The
 * user's timezone and locale arrive the same way, as a `LoanLinkContext` the
 * action layer builds from the session user — this module makes no assumption
 * about whose request it is serving.
 *
 * ## Why a row lock, and not Serializable
 *
 * `recordLoanPayment` is a read-check-write twice over: it sums the principal
 * paid, compares the new principal part against what is left, inserts, and then
 * *advances the due date it read at the start of the same transaction*. Under
 * READ COMMITTED each statement sees rows committed at the moment it runs, so
 * two instalments arriving together (a double-clicked button, two open tabs)
 * would each break one of the two:
 *
 * - two payments that cannot both fit would both read the *same* pre-race sum,
 *   both pass the check, and both commit — leaving a 1,000,000 loan with
 *   1,200,000 of principal recorded against it and a negative outstanding the UI
 *   cannot explain;
 * - two payments that *do* both fit would both read the same `nextDueDate` and
 *   both write the same +1 interval — a lost update, so two instalments would
 *   move the schedule forward by one.
 *
 * `SELECT … FOR UPDATE` on the Loan row, taken inside the same transaction as
 * both writes, closes both windows: the lock conflicts with any other
 * `FOR UPDATE` and with `UPDATE`, so the second payment queues until the first
 * commits and then re-reads the real, post-commit sum *and* the real,
 * post-commit due date. The first case is refused with `LoanOverpaymentError`,
 * the same error it would have got had the two arrived a second apart; the
 * second advances the date a second time, as it should.
 *
 * Serializable was the other candidate (and is what this group's plan proposed).
 * It is rejected here for the reason `debt.ts` sets out at length: it converts a
 * *predictable* domain failure into an unpredictable infrastructure one — the
 * loser aborts with a serialization failure (P2034) rather than "that is more
 * than is still owed", which the UI would have to surface as "please try again"
 * or paper over with a retry loop that then has to re-run the check anyway. The
 * row lock gives the loser the true answer on its first attempt, and gives the
 * *valid* concurrent payment the correct due date rather than an abort.
 *
 * The lock is also what makes the payment-vs-close race resolve cleanly, both
 * ways round, because `closeLoan` takes the same lock:
 *
 * - payment first: it commits, then the close proceeds and the instalment stays
 *   in the history (a loan closed after a partial repayment keeps that
 *   repayment — the money really was paid);
 * - close first: the payment re-reads the row *under the lock*, sees CLOSED and
 *   is refused with `LoanNotActiveError`, so no instalment can ever be recorded
 *   against a loan that was already closed, and the due date of a closed loan
 *   never moves.
 *
 * Every instalment writer — record, edit, delete — takes this lock, so under it
 * the instalment rows of one loan, and its due date, cannot change.
 *
 * ## Lock order: accounts, then the loan row, then transaction rows
 *
 * A linked write takes up to three kinds of lock, and always in this order —
 * the order `debt.ts` documents and uses:
 *
 * 1. the account(s) — `lockAccountsForUpdate`, one sorted statement, taken
 *    *explicitly before* the loan lock even though `insertTransactionInTx`
 *    locks its account again later (re-locking a row the same transaction
 *    already holds returns at once);
 * 2. the Loan row — `lockLoanRow`;
 * 3. the linked Transaction rows — `lockAndVerifyTransactionRow`.
 *
 * It is the order `createTransaction` (account), `updateTransaction`
 * (accounts, then the transaction row) and `deleteTransaction` already use,
 * and the paths with no account keep today's single loan lock. No path anywhere
 * holds a loan lock while waiting for an account, or a transaction-row lock
 * while waiting for a loan, so no two of them can wait on each other in a
 * cycle: a linked instalment racing an edit of another transaction in the same
 * account queues on that account; an instalment moved from account A to B
 * racing a transaction moved from B to A both lock {A, B} in the same sorted
 * statement; a close (loan lock only) never waits on an account. The two
 * transaction rows of one instalment are only ever locked together behind its
 * loan's lock, so no other writer can hold one of them while wanting the other.
 *
 * "Loan Interest & Fees" is looked up (and, for a user who has none, created)
 * by `ensureLoanInterestCategoryId` only *after* the account and loan locks,
 * and only when an interest transaction will be written, so a refused
 * instalment never leaves a category behind either.
 *
 * Which accounts to lock for an edit or a delete is read from a copy taken
 * before the transaction opens, so under the locks the instalment and its
 * linked transactions are re-verified against that copy; a row that changed in
 * between is a `ConcurrentModificationError`, exactly as `updateTransaction`
 * treats its own stale copy.
 *
 * FX is fetched *before* any transaction opens, and only when a linked
 * transaction will be written with a new snapshot: an interactive transaction
 * holds a pooled connection and its locks for its whole duration under
 * Prisma's 5s default timeout, so a provider call in there would stall every
 * other writer on the same account and loan (the reasoning `account-lock.ts`
 * sets out at length). The Zod parse and the calendar-date conversions are
 * hoisted out of the transaction too; inside it there is database work, the
 * `Prisma.Decimal` checks and the pure date arithmetic, and nothing else.
 */

/**
 * What a write needs to know about the user that only the session has, passed
 * by the action layer from `resolveProfileDefaults(user)` — the same shape as
 * `debt.ts`'s `DebtLinkContext`.
 */
export interface LoanLinkContext {
  /** The user's IANA zone. A start or payment *date* becomes the linked
   *  transactions' instant here (`calendarDateToEntryInstant`: now for today,
   *  else 12:00 that day), so it lands on the same calendar day the user
   *  picked whichever zone later reads it. */
  timezone: string
  /** The language of the default transaction note, rendered once at write
   *  time and stored — never re-rendered on read or on a later edit. */
  locale: Locale
}

/**
 * Thrown when an instalment's principal part would take a loan past repaid.
 *
 * Carries the outstanding principal that was true *under the lock*, so the
 * caller can tell the user what would have fitted without re-querying — a second
 * query would be another read outside the transaction, and could itself be stale
 * by the time it is rendered.
 */
export class LoanOverpaymentError extends Error {
  readonly outstandingPrincipal: Prisma.Decimal

  constructor(outstandingPrincipal: Prisma.Decimal) {
    super('Principal payment exceeds the outstanding principal.')
    this.name = 'LoanOverpaymentError'
    this.outstandingPrincipal = outstandingPrincipal
  }
}

/**
 * Thrown when a closed loan would receive an instalment or an edit.
 *
 * A distinct error rather than a P2025: the row exists and the user can still
 * see it in their list, so "that loan no longer exists" would be a lie. A closed
 * loan is frozen — the decision has been recorded and its history is now
 * read-only.
 */
export class LoanNotActiveError extends Error {
  constructor() {
    super('This loan is closed and cannot receive payments.')
    this.name = 'LoanNotActiveError'
  }
}

/**
 * Thrown when an instalment's total does not equal its principal plus its
 * interest.
 *
 * The service's own `Prisma.Decimal` re-check, and the second of the split
 * invariant's three layers. `recordLoanPaymentSchema` compares the same values
 * in exact cents and so rejects the same inputs first, which makes this branch
 * unreachable through the public API today — deliberately. It is here because
 * the arithmetic that the *database* will check is decimal arithmetic, not
 * float-derived integers, and a future caller (an import, a migration script, a
 * loosened schema) that reached the transaction with a mismatched split must be
 * refused by the service with a sentence about the split rather than by
 * Postgres with a constraint name.
 */
export class LoanSplitMismatchError extends Error {
  constructor() {
    super('Total must equal principal plus interest.')
    this.name = 'LoanSplitMismatchError'
  }
}

/**
 * Prisma's own `P2025`, byte for byte what `findUniqueOrThrow` raises on a
 * composite `(userId, id)` lookup that does not match.
 *
 * The locking `SELECT` in `lockLoanRow` is raw SQL, so an id belonging to
 * another user comes back as an empty result set rather than an error — and that
 * must not be distinguishable, by a caller or by an attacker, from Prisma's
 * answer for a nonexistent id. Rebuilt here (rather than imported from
 * `debt.ts`, where the equivalent helper is private and speaks about debts) so
 * the tenant-isolation contract every action error map and test already pins
 * down — a foreign loan id is a P2025 — holds for the locking path too, and for
 * an instalment that vanished between its pre-read and the lock.
 */
function prismaNotFound(
  model: 'Loan' | 'Loan payment',
  id: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. ${model} ${id} was not found for this user.`,
    { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
  )
}

/**
 * Takes an exclusive lock on one Loan row, tenant-scoped in the SQL itself.
 *
 * Must be called inside `prisma.$transaction`: the lock is held until that
 * transaction commits or rolls back, and taking it on the bare client would
 * release it immediately and prove nothing (`account-lock.ts` makes the same
 * point about accounts). Shared by every instalment writer and `closeLoan` so
 * that "the same lock" is literally the same statement, which is what makes
 * their races resolve deterministically either way round.
 *
 * Exactly one loan row is ever locked here, so there is no ordering among loan
 * rows to get wrong; its place relative to accounts and transaction rows is the
 * lock order in the module comment.
 */
async function lockLoanRow(
  tx: Prisma.TransactionClient,
  userId: string,
  loanId: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "Loan"
    WHERE "userId" = ${userId} AND "id" = ${loanId}
    FOR UPDATE`
  // An empty result means the id is not this user's loan — or does not exist at
  // all, and the two must be indistinguishable.
  if (locked.length === 0) throw prismaNotFound('Loan', loanId)
}

/** Spec §4's note labels (`loans.linkedNote.*`), one per linked movement. */
type LinkedNoteKind = 'disburse' | 'principal' | 'interest'

const LINKED_NOTE_MESSAGES = {
  vi: { loans: viLoanMessages },
  en: { loans: enLoanMessages },
} as const

/**
 * A linked transaction's note when the user gave none: "Vay – Vietcombank",
 * "Trả gốc – Vietcombank", "Lãi vay – Vietcombank" (and their English
 * equivalents) in the user's locale, rendered once here and stored.
 *
 * `createTranslator` is the same engine `getTranslations` runs, minus the
 * request scope this service does not have; `lender` is substituted as a
 * value, never parsed as ICU syntax, so a name with braces or quotes is safe.
 */
function linkedNote(locale: Locale, kind: LinkedNoteKind, lender: string): string {
  const t = createTranslator({ locale, messages: LINKED_NOTE_MESSAGES[locale] })
  return t(`loans.linkedNote.${kind}`, { lender })
}

/** The USD/VND snapshot columns a re-snapshotted transaction is written with. */
function snapshotColumns(fx: UsableRateResult) {
  return {
    vndPerUsdAtEntry: fx.rateDecimal,
    fxRateFetchedAt: fx.fetchedAt,
    fxRateEffectiveAt: fx.effectiveDate,
    fxRateSource: fx.source,
  }
}

/** The one status a loan row actually stores, plus the two states derived from
 *  its payments and its next due date. */
export type LoanDisplayStatus = 'ACTIVE' | 'OVERDUE' | 'PAID_OFF' | 'CLOSED'

/**
 * A loan with its instalment history — the shape every read in this module
 * returns.
 *
 * The payments always travel with the loan because a loan without them is
 * unreadable: the outstanding principal is *made of* them, and the UI shows the
 * history right under the figure. Written as a `GetPayload` so a later phase
 * that widens the include widens every caller with it, rather than silently not
 * seeing the new relation.
 *
 * Money-source linking widened it: the loan carries `disbursementTransactionId`
 * and each instalment its `principalTransactionId` and `interestTransactionId`
 * (null when nothing was recorded in an account, or for a part of zero), and
 * each brings the *account* of its linked transaction — the account an
 * instalment form pre-selects (spec §6.3) and an edit form starts from. Only
 * the account's id, name and status (`LINKED_ACCOUNT`, as on debts): the rest
 * of the transaction is the Transactions page's to show, and the name and
 * status let an edit form keep an account archived since the instalment rather
 * than silently offering "don't record" in its place.
 */
const LINKED_ACCOUNT = {
  accountId: true,
  account: { select: { name: true, status: true } },
} satisfies Prisma.TransactionSelect

export type LoanRow = Prisma.LoanGetPayload<{
  include: {
    payments: {
      include: {
        principalTransaction: { select: typeof LINKED_ACCOUNT }
        interestTransaction: { select: typeof LINKED_ACCOUNT }
      }
    }
    disbursementTransaction: { select: typeof LINKED_ACCOUNT }
  }
}>

/**
 * The same derived figures over a loan read *without* its instalments — what
 * `getLoansWithOutstanding(..., { includePayments: false })` returns.
 *
 * The mirror of `debt.ts`'s `DebtTotals`, and for the same reason: both sums
 * come from the `groupBy` on either path, so there is one definition of what a
 * loan still owes (`loan.test.ts` asserts the two paths agree figure by figure)
 * and only the payload differs.
 */
export interface LoanTotals {
  loan: Loan
  /** Σ of this loan's `principalAmount` values, from the authoritative
   *  `groupBy` sum — the only part that pays the loan down. */
  principalPaid: Prisma.Decimal
  /** Σ of this loan's `interestAmount` values: what the loan has cost so far.
   *  It reduces nothing and is reported separately for exactly that reason. */
  interestPaid: Prisma.Decimal
  outstandingPrincipal: Prisma.Decimal
  displayStatus: LoanDisplayStatus
}

export interface LoanWithOutstanding extends LoanTotals {
  loan: LoanRow
}

/**
 * Oldest instalment first — the order a history reads in.
 *
 * All three keys are compared so the order is total: `paymentDate` is a
 * calendar-date carrier, so several instalments can share a day, and `createdAt`
 * can tie inside a millisecond. Without the tie-breaks the same history could
 * render in one order on one request and another order on the next.
 */
const PAYMENT_ORDER = [
  { paymentDate: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.LoanPaymentOrderByWithRelationInput[]

/** The one include every read here uses, so no caller can accidentally fetch a
 *  loan without its instalments or with them in a different order — or without
 *  the linked accounts `LoanRow` promises. */
const WITH_PAYMENTS = {
  payments: {
    orderBy: PAYMENT_ORDER,
    include: {
      principalTransaction: { select: LINKED_ACCOUNT },
      interestTransaction: { select: LINKED_ACCOUNT },
    },
  },
  disbursementTransaction: { select: LINKED_ACCOUNT },
} satisfies Prisma.LoanInclude

/**
 * A loan with everything `LoanRow` promises, read back after a write.
 *
 * Every write here returns its row through this read rather than through an
 * `include` on the write itself, and always *after* its transaction: Prisma
 * loads an include's sibling relations concurrently, and inside a transaction —
 * an interactive one, or the implicit one a write with an `include` opens —
 * those reads share a single pg connection, which pg 8 deprecates ("Calling
 * client.query() when the client is already executing a query"). Read through
 * the pool, each relation query gets a connection of its own. It reads the
 * committed row, so it can only ever show the write that just succeeded, or a
 * later one.
 */
function readLoanRow(userId: string, loanId: string): Promise<LoanRow> {
  return prisma.loan.findUniqueOrThrow({
    where: { userId_id: { userId, id: loanId } },
    include: WITH_PAYMENTS,
  })
}

/** Newest instalment first, with the same total tie-breaks as `PAYMENT_ORDER`
 *  — which instalment is "the latest" when one is deleted. */
const LATEST_PAYMENT_FIRST = [
  { paymentDate: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.LoanPaymentOrderByWithRelationInput[]

/** Live loans before closed ones — the order the Loans page renders. */
const STATUS_RANK: Record<LoanStoredStatus, number> = { ACTIVE: 0, CLOSED: 1 }

/**
 * Sorted in memory rather than with `orderBy: { status: 'asc' }`, which would
 * order by the enum's *declaration* order in Postgres and so make the page's
 * display order an invisible consequence of how `LoanStoredStatus` happens to be
 * written in `schema.prisma`. The rank above says the intent outright. (Same
 * reasoning, and the same total ordering, as `debt.ts` and `savings-goal.ts`.)
 */
function compareForDisplay(a: Loan, b: Loan): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  )
}

/**
 * What is still owed on the loan itself: the principal borrowed minus the
 * principal parts repaid.
 *
 * The whole of invariant 2 in one line, exported and unit-tested directly.
 * `interestAmount` is deliberately absent: interest is the cost of borrowing,
 * not a repayment of it, so including it here would report a loan as repaid
 * while the lender still expects the principal back.
 *
 * `Prisma.Decimal` arithmetic, never a `number` detour: at VND magnitudes a
 * float subtraction can leave a phantom residue of a fraction of a dong, and
 * "is this loan paid off?" is decided by comparing this value with zero.
 */
export function deriveLoanOutstandingPrincipal(
  principal: Prisma.Decimal,
  principalPaid: Prisma.Decimal,
): Prisma.Decimal {
  return principal.sub(principalPaid)
}

/**
 * The state to show for a loan, given what principal is still outstanding and
 * what day it is for the user.
 *
 * The order of the branches *is* the product decision, and each one outranks the
 * ones below it for a reason:
 *
 * - **CLOSED** first: the user's recorded decision outranks any arithmetic. A
 *   closed loan with principal still nominally outstanding — refinanced,
 *   forgiven, settled off-book — is closed, not overdue.
 * - **PAID_OFF** next: a loan repaid *late* is repaid. Showing OVERDUE on a
 *   settled loan would tell the user to pay an instalment they no longer owe —
 *   and the stored `nextDueDate` of a fully repaid loan is very often in the
 *   past, because the last accepted payment advanced it to the next scheduled
 *   day and no further payment will ever move it again. `lte(0)` rather than
 *   `eq(0)` so a loan that somehow holds more principal payments than it
 *   borrowed (only reachable by writing rows outside this service) still reads
 *   as repaid instead of falling through to ACTIVE.
 * - **OVERDUE** next, from the schedule.
 * - then **ACTIVE**.
 *
 * `today` is a `yyyy-MM-dd` string the caller derives from the user's timezone
 * (`todayCalendarDateInZone`), and the comparison is between two calendar
 * strings — never `nextDueDate < new Date()`, which would compare a UTC-midnight
 * carrier against an instant and so call an instalment overdue up to a day early
 * or late depending on the reader's zone. Passing `today` in also keeps every
 * caller and every test deterministic (ruling R6-7).
 */
export function deriveLoanDisplayStatus(
  loan: { status: LoanStoredStatus; nextDueDate: Date },
  outstandingPrincipal: Prisma.Decimal,
  today: string,
): LoanDisplayStatus {
  if (loan.status === 'CLOSED') return 'CLOSED'
  if (outstandingPrincipal.lte(0)) return 'PAID_OFF'
  // Strictly before today: an instalment due *today* is not late — the user has
  // the whole day to pay it.
  if (compareCalendarDates(formatCalendarDate(loan.nextDueDate), today) < 0) return 'OVERDUE'
  return 'ACTIVE'
}

/**
 * Every loan the user has, closed ones included, each with its instalments.
 *
 * Unbounded by design, like `listDebts` and `listAllSavingsGoals`: a cap on a
 * user's complete data is silent data loss rather than a safeguard. Nothing here
 * deletes a loan, and closing one never hides it — it moves to the end of the
 * list.
 */
export async function listLoans(userId: string): Promise<LoanRow[]> {
  const loans = await prisma.loan.findMany({
    where: { userId },
    include: WITH_PAYMENTS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return loans.sort(compareForDisplay)
}

/**
 * The Loans page's read: every loan with its derived principal paid, interest
 * paid, outstanding principal and display status.
 *
 * Two queries regardless of how many loans the user has — one `findMany` for the
 * rows and their history, one `groupBy` for both sums — never a sum per loan,
 * which would make rendering the page cost a round trip per row. The `groupBy`
 * is the authoritative total and the included payments are the history the UI
 * lists; `loan.test.ts` asserts the two agree for every loan, so a total can
 * never disagree with the rows shown beneath it.
 *
 * The `groupBy` is scoped by `userId` alone rather than by the filtered loan ids:
 * it is one aggregate over the user's own payments either way, and a second
 * `where` clause built from the first query's results would make the two queries
 * dependent (and so sequential) for no gain. Extra entries for loans the filter
 * excluded are simply never looked up.
 *
 * `activeOnly` is what the dashboard and Net Worth pass: a closed loan is not a
 * liability any more, but it is still part of the user's history and stays
 * visible on the page itself.
 *
 * `includePayments: false` drops the instalment history from the payload and
 * nothing else (Phase 8, finding B-7). The figures are unchanged — they were
 * always the `groupBy`'s, never the included rows' — so this stays one read
 * path and one definition of a loan's outstanding principal, with the
 * O(payments) payload made optional for the callers that never render an
 * instalment: Net Worth (`position.ts`) and the export's Loans and Summary
 * sheets. The default is `true`, so the Loans page, which lists every
 * instalment, is untouched.
 */
export async function getLoansWithOutstanding(
  userId: string,
  today: string,
  options?: { activeOnly?: boolean; includePayments?: true },
): Promise<LoanWithOutstanding[]>
export async function getLoansWithOutstanding(
  userId: string,
  today: string,
  options: { activeOnly?: boolean; includePayments: boolean },
): Promise<LoanTotals[]>
export async function getLoansWithOutstanding(
  userId: string,
  today: string,
  options: { activeOnly?: boolean; includePayments?: boolean } = {},
): Promise<LoanTotals[]> {
  const where = options.activeOnly ? { userId, status: 'ACTIVE' as const } : { userId }
  const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
  const [loans, sums] = await Promise.all([
    // Two calls rather than one with a conditional `include` key, so each keeps
    // its own precise Prisma payload type instead of collapsing to a union the
    // caller would have to narrow.
    options.includePayments === false
      ? prisma.loan.findMany({ where, orderBy })
      : prisma.loan.findMany({ where, include: WITH_PAYMENTS, orderBy }),
    prisma.loanPayment.groupBy({
      by: ['loanId'],
      where: { userId },
      _sum: { principalAmount: true, interestAmount: true },
    }),
  ])

  const paidByLoan = new Map(sums.map((row) => [row.loanId, row._sum]))

  // Widened to `Loan` so the two `findMany` shapes share one sort and one
  // derivation; the overload above is what hands a caller back the precise row
  // type it asked for.
  const rows: Loan[] = loans
  return rows.sort(compareForDisplay).map((loan) => {
    const paid = paidByLoan.get(loan.id)
    const principalPaid = paid?.principalAmount ?? new Prisma.Decimal(0)
    const interestPaid = paid?.interestAmount ?? new Prisma.Decimal(0)
    const outstandingPrincipal = deriveLoanOutstandingPrincipal(loan.principal, principalPaid)
    return {
      loan,
      principalPaid,
      interestPaid,
      outstandingPrincipal,
      displayStatus: deriveLoanDisplayStatus(loan, outstandingPrincipal, today),
    }
  })
}

/**
 * What principal one loan still has outstanding.
 *
 * A convenience for a single-loan caller (a payment form's "how much is left?",
 * Net Worth's liability figure, and the tests) rather than the page's read path —
 * use `getLoansWithOutstanding` for a list, which costs two queries for any
 * number of loans instead of two per loan.
 *
 * Deliberately *not* the value `recordLoanPayment` checks against: this read
 * happens outside any transaction, so it is a snapshot that another request can
 * invalidate the moment it returns. The authoritative check is the one taken
 * under the row lock.
 */
export async function getLoanOutstandingPrincipal(
  userId: string,
  loanId: string,
): Promise<Prisma.Decimal> {
  const loan = await prisma.loan.findUniqueOrThrow({
    where: { userId_id: { userId, id: loanId } },
  })
  const principalPaid =
    (
      await prisma.loanPayment.aggregate({
        where: { userId, loanId },
        _sum: { principalAmount: true },
      })
    )._sum.principalAmount ?? new Prisma.Decimal(0)
  return deriveLoanOutstandingPrincipal(loan.principal, principalPaid)
}

/**
 * Records a new loan — received into an account, together with the money that
 * arrived.
 *
 * Fields are listed explicitly rather than spread, so the authenticated `userId`
 * can never be overridden regardless of Zod's stripping behaviour and a
 * client-supplied `status` is ignored rather than obeyed — a new loan is ACTIVE,
 * and only `closeLoan` changes that.
 *
 * `dueDayOfMonth` is *derived* here, from the UTC day of the first due date's
 * carrier, and is never accepted from the client (ruling R6-6a): an anchor that
 * disagreed with the stored due date would make the very first advance jump to a
 * day the user never picked. Deriving it is also what makes the anchor
 * unambiguous — "the day my instalment falls on" is exactly the day the user
 * just entered.
 *
 * Without `accountId` ("don't record in an account") this is the single insert
 * it always was: no FX lookup, no transaction, the currency the user chose.
 * With one, the loan and its disbursement (spec §4: a CASH_IN of the principal,
 * dated on `startDate` in the user's zone — `calendarDateToEntryInstant`) commit
 * together or not at all, and the loan takes the account's currency — the
 * form's currency choice only applies when no account is involved. The
 * transaction's note is the loan's notes when given, else the localized
 * "Vay – {lender}" label.
 *
 * Only the account is locked (by `insertTransactionInTx`): the loan row is
 * being created inside this transaction, so no one else can see it, let alone
 * lock it, before it commits.
 */
export async function createLoan(
  userId: string,
  input: CreateLoanInput,
  context: LoanLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<LoanRow> {
  const parsed = createLoanSchema.parse(input)
  const nextDueDate = calendarDateToUtcCarrier(parsed.nextDueDate)
  const data = {
    userId,
    lender: parsed.lender,
    // `String()` first, for every amount in this file: that is the exact
    // representation `lib/validation/money.ts` inspected when it accepted the
    // value as having at most 2 decimal places (and the one the pg adapter
    // serialises), so what is stored is precisely what was validated — rather
    // than whatever the Decimal constructor makes of a raw double.
    principal: new Prisma.Decimal(String(parsed.principal)),
    // Same reasoning at 3 decimal places, which is what `Decimal(6, 3)` holds
    // and what `createLoanSchema` checked.
    interestRate: new Prisma.Decimal(String(parsed.interestRate)),
    startDate: calendarDateToUtcCarrier(parsed.startDate),
    termMonths: parsed.termMonths,
    paymentFrequency: parsed.paymentFrequency,
    scheduledPaymentAmount: new Prisma.Decimal(String(parsed.scheduledPaymentAmount)),
    nextDueDate,
    // Read in UTC, because a carrier has no other zone: for `2026-01-31` this
    // is 31, and that is what keeps the schedule off the 28th from February
    // onwards.
    dueDayOfMonth: nextDueDate.getUTCDate(),
    notes: parsed.notes ?? null,
  }

  const { accountId } = parsed
  if (accountId === undefined) {
    const loan = await prisma.loan.create({
      data: { ...data, currency: parsed.currency },
      select: { id: true },
    })
    return readLoanRow(userId, loan.id)
  }

  // Before the transaction opens: never a provider call under a row lock, and
  // an outage leaves no loan behind rather than one without its transaction.
  const fx = await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)
  const date = calendarDateToEntryInstant(parsed.startDate, context.timezone)

  const loanId = await prisma.$transaction(async (tx) => {
    const disbursement = await insertTransactionInTx(
      tx,
      userId,
      {
        accountId,
        type: 'CASH_IN',
        amount: data.principal,
        date,
        note: parsed.notes ?? linkedNote(context.locale, 'disburse', parsed.lender),
      },
      fx,
    )
    const loan = await tx.loan.create({
      // `disbursement.currency` was copied from the locked account row, so the
      // loan and the money it brought in cannot disagree about the currency.
      data: {
        ...data,
        currency: disbursement.currency,
        disbursementTransactionId: disbursement.id,
      },
      select: { id: true },
    })
    return loan.id
  })
  return readLoanRow(userId, loanId)
}

/**
 * Corrects or renegotiates a loan: who the lender is, what the scheduled
 * instalment is now, and the notes.
 *
 * `principal`, `currency`, `interestRate`, `startDate`, `termMonths`,
 * `paymentFrequency` and `nextDueDate` are not editable and are not in
 * `updateLoanSchema` at all — see the ruling documented there: they define which
 * loan this is and what its terms are, and changing one after instalments exist
 * would re-interpret that history against terms the loan never had (or rewrite a
 * schedule the recorded payments already advanced). `scheduledPaymentAmount` is
 * the deliberate exception: a floating-rate instalment really does change, and
 * nothing derived is computed from it.
 *
 * The row is read first through the composite `userId_id` key, so another user's
 * loan id resolves to nothing and raises Prisma's P2025 (propagated untouched,
 * as every service here does). A closed loan is frozen and raises
 * `LoanNotActiveError` instead of being quietly reopened.
 *
 * No row lock: an edit touches none of the fields the payment check reads — not
 * the principal, not the due date, not the status — so it cannot race a payment
 * into breaking an invariant. The worst a concurrent close can do is let an edit
 * land a moment before the freeze, which is indistinguishable from the user
 * having clicked Save a moment earlier.
 */
export async function updateLoan(
  userId: string,
  loanId: string,
  input: UpdateLoanInput,
): Promise<LoanRow> {
  const parsed = updateLoanSchema.parse(input)
  const existing = await prisma.loan.findUniqueOrThrow({
    where: { userId_id: { userId, id: loanId } },
  })
  if (existing.status !== 'ACTIVE') throw new LoanNotActiveError()

  await prisma.loan.update({
    where: { userId_id: { userId, id: loanId } },
    data: {
      lender: parsed.lender,
      scheduledPaymentAmount: new Prisma.Decimal(String(parsed.scheduledPaymentAmount)),
      // An edit that clears the notes stores `null` — the absence has to be
      // written, not skipped, or the old value would survive and the user could
      // never remove it.
      notes: parsed.notes ?? null,
    },
  })
  return readLoanRow(userId, loanId)
}

/**
 * Locks the loan (after any accounts — see the lock order), re-reads it through
 * the typed client and refuses a closed one.
 *
 * The raw SELECT in `lockLoanRow` is only the lock — `$queryRaw` gives no
 * guarantee about how a DECIMAL column arrives in JS, and money must never
 * travel through a float — so the row every decision is made on comes from
 * Prisma's typed client. Under the lock, so a close that committed first is
 * visible here and no instalment can be recorded, edited or removed on an
 * already-closed loan, nor its due date moved.
 */
async function lockActiveLoan(
  tx: Prisma.TransactionClient,
  userId: string,
  loanId: string,
): Promise<Loan> {
  await lockLoanRow(tx, userId, loanId)
  const loan = await tx.loan.findUniqueOrThrow({ where: { userId_id: { userId, id: loanId } } })
  if (loan.status !== 'ACTIVE') throw new LoanNotActiveError()
  return loan
}

/**
 * The split re-checked in decimal arithmetic — layer two of three (Zod in exact
 * cents is the first, the `LoanPayment_total_matches_split` CHECK the third).
 */
function assertSplit(
  totalAmount: Prisma.Decimal,
  principalAmount: Prisma.Decimal,
  interestAmount: Prisma.Decimal,
): void {
  if (!totalAmount.equals(principalAmount.plus(interestAmount))) {
    throw new LoanSplitMismatchError()
  }
}

/**
 * What principal a locked loan still has outstanding, leaving out
 * `exceptPaymentId` — the instalment being edited, which must not count against
 * its own new principal part.
 *
 * Summed under the loan lock: this is the authoritative figure, not the one a
 * caller may have read a moment ago. Only the principal parts are summed —
 * interest never pays a loan down.
 */
async function outstandingPrincipalUnderLock(
  tx: Prisma.TransactionClient,
  userId: string,
  loan: Loan,
  exceptPaymentId?: string,
): Promise<Prisma.Decimal> {
  const principalPaid =
    (
      await tx.loanPayment.aggregate({
        where: {
          userId,
          loanId: loan.id,
          ...(exceptPaymentId === undefined ? {} : { id: { not: exceptPaymentId } }),
        },
        _sum: { principalAmount: true },
      })
    )._sum.principalAmount ?? new Prisma.Decimal(0)
  return deriveLoanOutstandingPrincipal(loan.principal, principalPaid)
}

/**
 * The two movements an instalment paid from an account makes (spec §4): its
 * principal part leaves as a CASH_OUT with no category, its interest part as an
 * EXPENSE filed under "Loan Interest & Fees".
 */
const LEG_TYPE = { principal: 'CASH_OUT', interest: 'EXPENSE' } as const
type Leg = keyof typeof LEG_TYPE

/**
 * Records an instalment against a loan, and advances the schedule — paid from
 * an account, together with the money that moved.
 *
 * The whole read-check-write-write happens inside one interactive transaction
 * that takes an exclusive row lock on the Loan row, for the reasons set out in
 * the module comment: without it two concurrent instalments would either take
 * the loan past repaid, or both advance the due date from the same starting
 * value and so lose one interval.
 *
 * The `LoanPayment` insert and the `nextDueDate` update are in the same
 * transaction on purpose, and that is what the returned pair reports. They
 * commit or roll back together, so there is never an instalment with an
 * unmoved schedule (the user would be asked to pay the same month twice) and
 * never a moved schedule with no instalment behind it (the month would silently
 * be skipped). `loan.test.ts` proves it from the outside: after a rejected
 * overpayment the due date is exactly where it was.
 *
 * With `accountId`, the linked transactions (spec §4: a CASH_OUT of the
 * principal part, and an EXPENSE of the interest part in "Loan Interest &
 * Fees"; none for a part of zero — `insertTransactionInTx` refuses a zero
 * amount, and an interest-only instalment is valid input, ruling R6-6) are
 * written in the same transaction, both dated on the payment day in the user's
 * zone (`calendarDateToEntryInstant`), with the user's note or the localized
 * "Trả gốc – {lender}" / "Lãi vay – {lender}" labels. The account is locked
 * *before* the loan (the module's lock order) and must hold the loan's
 * currency. Every check — account, loan status, split, over-payment, currency —
 * runs before anything is written, so a refusal leaves no orphan transaction
 * (and no interest category) behind. Without an account it is the two writes
 * it always was, with no FX lookup.
 */
export async function recordLoanPayment(
  userId: string,
  loanId: string,
  input: RecordLoanPaymentInput,
  context: LoanLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<{ payment: LoanPayment; nextDueDate: Date }> {
  // Hoisted out of the transaction: parsing and date conversion are pure CPU
  // work that must not happen while a row lock is held.
  const parsed = recordLoanPaymentSchema.parse(input)
  const totalAmount = new Prisma.Decimal(String(parsed.totalAmount))
  const principalAmount = new Prisma.Decimal(String(parsed.principalAmount))
  const interestAmount = new Prisma.Decimal(String(parsed.interestAmount))
  const paymentDate = calendarDateToUtcCarrier(parsed.paymentDate)
  const { accountId } = parsed
  const instant = calendarDateToEntryInstant(parsed.paymentDate, context.timezone)
  // FX only when money moves, and before the transaction opens.
  const fx =
    accountId === undefined ? null : await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)

  return prisma.$transaction(async (tx) => {
    // 1. The account first, so this path holds nothing while it queues behind
    //    another writer on the same account (P2025 for another user's,
    //    `ArchivedAccountError` for an archived one).
    const [account] =
      accountId === undefined ? [] : await lockAccountsForUpdate(tx, userId, [accountId])

    // 2. The loan: exclusive row lock, tenant-scoped (P2025 for an id that is
    //    not this user's), then the status check under it.
    const loan = await lockActiveLoan(tx, userId, loanId)

    // 3. The split, and the outstanding principal summed under the same lock.
    //    `gt`, so a principal payment of exactly what is left is accepted —
    //    settling a loan is the most common last payment there is. The interest
    //    part is not compared at all: a repaid loan can still owe a final charge.
    assertSplit(totalAmount, principalAmount, interestAmount)
    const outstandingPrincipal = await outstandingPrincipalUnderLock(tx, userId, loan)
    if (principalAmount.gt(outstandingPrincipal)) {
      throw new LoanOverpaymentError(outstandingPrincipal)
    }

    // 4. The money, when it moved through an account. Checked here, before the
    //    first write, rather than left to `insertTransactionInTx`'s own check,
    //    so a refusal writes nothing at all. The account lock is already ours,
    //    so the core's own lock returns at once.
    if (account !== undefined && account.currency !== loan.currency) {
      throw new LinkedAccountCurrencyMismatchError()
    }
    const linked = { principal: null as string | null, interest: null as string | null }
    if (accountId !== undefined && fx !== null) {
      const parts = { principal: principalAmount, interest: interestAmount }
      for (const leg of ['principal', 'interest'] as const) {
        if (!parts[leg].greaterThan(0)) continue
        const created = await insertTransactionInTx(
          tx,
          userId,
          {
            accountId,
            type: LEG_TYPE[leg],
            amount: parts[leg],
            date: instant,
            note: parsed.note ?? linkedNote(context.locale, leg, loan.lender),
            // After the account and loan locks, and only when an interest
            // transaction is actually written.
            categoryId: leg === 'interest' ? await ensureLoanInterestCategoryId(tx, userId) : null,
            expectedCurrency: loan.currency,
          },
          fx,
        )
        linked[leg] = created.id
      }
    }

    // 5. The instalment and the schedule, together. `advanceByFrequency` is pure
    //    arithmetic on the due date read under this lock, so the value written is
    //    one interval on from the real, current schedule — never from a stale
    //    read.
    const payment = await tx.loanPayment.create({
      data: {
        userId,
        loanId,
        totalAmount,
        principalAmount,
        interestAmount,
        paymentDate,
        note: parsed.note ?? null,
        principalTransactionId: linked.principal,
        interestTransactionId: linked.interest,
      },
    })
    const advanced = advanceByFrequency(loan.nextDueDate, loan.paymentFrequency, loan.dueDayOfMonth)
    await tx.loan.update({
      where: { userId_id: { userId, id: loanId } },
      data: { nextDueDate: advanced },
    })

    return { payment, nextDueDate: advanced }
  })
}

/**
 * Re-reads an instalment under its loan's lock and confirms it is still linked
 * the way the pre-transaction copy said.
 *
 * Every instalment writer holds the loan lock, so from here the instalment row
 * cannot change — but it may already have changed between the pre-read and the
 * lock, and the accounts this request locked were chosen from that pre-read. An
 * instalment that vanished is a P2025; one whose links changed (another edit
 * added or removed its account, or a part) is a `ConcurrentModificationError`,
 * as `updateTransaction` treats its own stale copy.
 */
async function verifyPaymentUnderLock(
  tx: Prisma.TransactionClient,
  userId: string,
  expected: LoanPayment,
): Promise<void> {
  const current = await tx.loanPayment.findUnique({
    where: { userId_id: { userId, id: expected.id } },
  })
  if (!current) throw prismaNotFound('Loan payment', expected.id)
  if (
    current.principalTransactionId !== expected.principalTransactionId ||
    current.interestTransactionId !== expected.interestTransactionId
  ) {
    throw new ConcurrentModificationError()
  }
}

/** What an instalment edit does to one of its two linked transactions. */
type LegPlan =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'update'; linked: Transaction; resnapshot: boolean }
  | { kind: 'delete'; linked: Transaction }

/**
 * Decides, before any lock is taken, what happens to one linked transaction:
 * the part is wanted when an account is chosen and the part is above zero.
 *
 * An update re-snapshots FX by ruling R-6 — exactly `updateTransaction`'s
 * rule: only when the transaction's economic content changes (its account, its
 * type, its amount or its instant), per transaction, so correcting only the
 * interest part leaves the principal transaction's snapshot as it was.
 */
function planLeg(
  linked: Transaction | null,
  leg: Leg,
  accountId: string | undefined,
  amount: Prisma.Decimal,
  instant: Date,
): LegPlan {
  const wanted = accountId !== undefined && amount.greaterThan(0)
  if (!wanted) return linked ? { kind: 'delete', linked } : { kind: 'none' }
  if (!linked) return { kind: 'create' }
  return {
    kind: 'update',
    linked,
    resnapshot:
      linked.accountId !== accountId ||
      linked.type !== LEG_TYPE[leg] ||
      // Compared as Decimal: 80000 and the stored "80000.00" are one amount.
      !amount.equals(linked.amount) ||
      instant.getTime() !== linked.date.getTime(),
  }
}

/**
 * Corrects a recorded instalment — its split, its date, its note, and which
 * account (if any) it was paid from — keeping both linked transactions in step
 * (spec §6.3).
 *
 * The rules are the ones the other writers already follow:
 *
 * - **The split** is re-checked in decimal arithmetic, and **over-payment** is
 *   measured against what is owed *without* this instalment, so correcting a
 *   principal part of 300,000 to 400,000 on a loan with 400,000 left before it
 *   is accepted; `LoanOverpaymentError.outstandingPrincipal` is then what would
 *   have fit.
 * - **Each linked transaction follows its part** (`planLeg`): part wanted and
 *   linked — the same transaction row is updated (account, amount, date, note,
 *   and its type and category re-asserted — CASH_OUT with none, EXPENSE in
 *   "Loan Interest & Fees" — so a stray edit from elsewhere is healed); wanted
 *   and not linked — a transaction is created, exactly as `recordLoanPayment`
 *   would; linked and no longer wanted (no account, or the part became zero) —
 *   the link is cleared and the transaction deleted (in that order — the link
 *   is `ON DELETE RESTRICT`). Both parts always move to the same account, which
 *   must hold the loan's currency.
 * - **The instant** stays the one the transactions already have when the date
 *   is unchanged (a note-only edit of an instalment paid today is not
 *   restamped, which would read as an economic change and need a fresh rate);
 *   a new date becomes an instant as on recording.
 * - **Notes**: the user's note when given. Without one, a transaction whose
 *   instalment had no note either keeps the label it was given when it was
 *   created — rendered once, never re-rendered in the current locale — and
 *   anything else (a new transaction, or an instalment whose own note was just
 *   cleared) gets the label rendered now.
 * - **FX follows ruling R-6** per transaction (`planLeg`), fetched before the
 *   transaction opens and only when some transaction needs it; a note-only
 *   edit keeps both snapshots exactly and needs no rate at all.
 * - **The schedule does not move**: correcting an instalment is not paying
 *   another one.
 * - **Frozen history**: an instalment of a closed loan cannot be edited.
 *
 * Concurrency: the instalment and its linked transactions are read once outside
 * the transaction (to choose the accounts to lock and to decide the FX
 * question), then accounts → loan → transaction rows are locked in the module's
 * order and every row re-verified against that copy.
 */
export async function updateLoanPayment(
  userId: string,
  paymentId: string,
  input: RecordLoanPaymentInput,
  context: LoanLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<LoanPayment> {
  const parsed = recordLoanPaymentSchema.parse(input)
  const totalAmount = new Prisma.Decimal(String(parsed.totalAmount))
  const principalAmount = new Prisma.Decimal(String(parsed.principalAmount))
  const interestAmount = new Prisma.Decimal(String(parsed.interestAmount))
  const paymentDate = calendarDateToUtcCarrier(parsed.paymentDate)
  const nextAccountId = parsed.accountId

  // Ownership-scoped and first: another user's instalment id is a P2025 here,
  // before any FX call or lock is taken for it.
  const {
    principalTransaction: principalLinked,
    interestTransaction: interestLinked,
    ...existing
  } = await prisma.loanPayment.findUniqueOrThrow({
    where: { userId_id: { userId, id: paymentId } },
    include: { principalTransaction: true, interestTransaction: true },
  })
  const current = principalLinked ?? interestLinked
  const instant =
    current !== null &&
    instantToLocalDateTime(current.date, context.timezone).slice(0, 10) === parsed.paymentDate
      ? current.date
      : calendarDateToEntryInstant(parsed.paymentDate, context.timezone)

  const plans = {
    principal: planLeg(principalLinked, 'principal', nextAccountId, principalAmount, instant),
    interest: planLeg(interestLinked, 'interest', nextAccountId, interestAmount, instant),
  }
  const needsRate = Object.values(plans).some(
    (plan) => plan.kind === 'create' || (plan.kind === 'update' && plan.resnapshot),
  )
  const fx = needsRate ? await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride) : null

  return prisma.$transaction(async (tx) => {
    // 1. Accounts: the one the linked transactions leave and the one they join,
    //    in one sorted statement (`lockAccountsForUpdate` de-duplicates), so an
    //    archived account can neither lose nor gain the movement.
    const accountIds = [principalLinked?.accountId, interestLinked?.accountId, nextAccountId]
    const accounts = await lockAccountsForUpdate(
      tx,
      userId,
      accountIds.filter((id): id is string => id !== undefined),
    )

    // 2. The loan, then the instalment re-verified under its lock.
    const loan = await lockActiveLoan(tx, userId, existing.loanId)
    await verifyPaymentUnderLock(tx, userId, existing)

    // 3. The linked transaction rows, last, against their pre-read copies: the
    //    Transactions page may have moved or edited them since.
    for (const linked of [principalLinked, interestLinked]) {
      if (linked) await lockAndVerifyTransactionRow(tx, userId, linked.id, linked)
    }

    assertSplit(totalAmount, principalAmount, interestAmount)
    const outstandingPrincipal = await outstandingPrincipalUnderLock(tx, userId, loan, paymentId)
    if (principalAmount.gt(outstandingPrincipal)) {
      throw new LoanOverpaymentError(outstandingPrincipal)
    }
    // The locked row of the account the money now moves through —
    // `lockAccountsForUpdate` resolved every id it was given or threw.
    const target = accounts.find((account) => account.id === nextAccountId)
    if (target !== undefined && target.currency !== loan.currency) {
      throw new LinkedAccountCurrencyMismatchError()
    }

    // `planLeg` decided which writes need a new snapshot, and `fx` was fetched
    // for exactly those, so this only fails on a planning bug.
    const snapshot = (): UsableRateResult => {
      if (fx === null) throw new RangeError('updateLoanPayment: a planned snapshot was not fetched')
      return fx
    }
    const parts = { principal: principalAmount, interest: interestAmount }
    const linkedIds = { principal: null as string | null, interest: null as string | null }
    for (const leg of ['principal', 'interest'] as const) {
      const plan = plans[leg]
      // A create or an update implies an account was chosen, so `target` is set.
      if (plan.kind === 'none' || plan.kind === 'delete' || target === undefined) continue
      // After the account and loan locks, and only for a transaction that is
      // written — re-asserted on an update, so the sync heals itself.
      const categoryId = leg === 'interest' ? await ensureLoanInterestCategoryId(tx, userId) : null
      if (plan.kind === 'create') {
        const created = await insertTransactionInTx(
          tx,
          userId,
          {
            accountId: target.id,
            type: LEG_TYPE[leg],
            amount: parts[leg],
            date: instant,
            note: parsed.note ?? linkedNote(context.locale, leg, loan.lender),
            categoryId,
            expectedCurrency: loan.currency,
          },
          snapshot(),
        )
        linkedIds[leg] = created.id
        continue
      }
      await tx.transaction.update({
        where: { userId_id: { userId, id: plan.linked.id } },
        data: {
          accountId: target.id,
          type: LEG_TYPE[leg],
          categoryId,
          amount: parts[leg],
          currency: target.currency,
          date: instant,
          note:
            parsed.note ??
            (existing.note === null && plan.linked.note !== null
              ? plan.linked.note
              : linkedNote(context.locale, leg, loan.lender)),
          ...(plan.resnapshot ? snapshotColumns(snapshot()) : {}),
        },
      })
      linkedIds[leg] = plan.linked.id
    }

    const updated = await tx.loanPayment.update({
      where: { userId_id: { userId, id: paymentId } },
      data: {
        totalAmount,
        principalAmount,
        interestAmount,
        paymentDate,
        note: parsed.note ?? null,
        principalTransactionId: linkedIds.principal,
        interestTransactionId: linkedIds.interest,
      },
    })
    // Only now that the instalment no longer references them can the
    // transactions it dropped go (`ON DELETE RESTRICT`).
    for (const plan of Object.values(plans)) {
      if (plan.kind === 'delete') {
        await tx.transaction.delete({ where: { userId_id: { userId, id: plan.linked.id } } })
      }
    }
    return updated
  })
}

/**
 * Removes a recorded instalment and, when it was paid from an account, the
 * transactions that moved its money (spec §6.3) — all or nothing.
 *
 * When it was the loan's latest instalment — by `paymentDate`, a tie broken by
 * `createdAt` (`LATEST_PAYMENT_FIRST`), decided under the loan lock — the due
 * date steps back by exactly the interval recording it advanced
 * (`retreatByFrequency`, the inverse of `advanceByFrequency` on the same
 * anchor), so the schedule asks for that instalment again. Deleting an older
 * instalment leaves the due date alone.
 *
 * Same locks and re-verification as `updateLoanPayment` (the linked account,
 * then the loan, then the transaction rows), so an archived account's frozen
 * history is respected exactly as `deleteTransaction` respects it, and an
 * instalment of a closed loan cannot be removed. The instalment row goes
 * first: it references the transactions, and those links are
 * `ON DELETE RESTRICT`.
 */
export async function deleteLoanPayment(userId: string, paymentId: string): Promise<void> {
  const {
    principalTransaction: principalLinked,
    interestTransaction: interestLinked,
    ...existing
  } = await prisma.loanPayment.findUniqueOrThrow({
    where: { userId_id: { userId, id: paymentId } },
    include: { principalTransaction: true, interestTransaction: true },
  })
  const linkedRows = [principalLinked, interestLinked].filter(
    (linked): linked is Transaction => linked !== null,
  )

  await prisma.$transaction(async (tx) => {
    await lockAccountsForUpdate(
      tx,
      userId,
      linkedRows.map((linked) => linked.accountId),
    )
    const loan = await lockActiveLoan(tx, userId, existing.loanId)
    await verifyPaymentUnderLock(tx, userId, existing)
    for (const linked of linkedRows) {
      await lockAndVerifyTransactionRow(tx, userId, linked.id, linked)
    }

    const latest = await tx.loanPayment.findFirst({
      where: { userId, loanId: loan.id },
      orderBy: LATEST_PAYMENT_FIRST,
      select: { id: true },
    })

    await tx.loanPayment.delete({ where: { userId_id: { userId, id: paymentId } } })
    for (const linked of linkedRows) {
      await tx.transaction.delete({ where: { userId_id: { userId, id: linked.id } } })
    }
    if (latest?.id === paymentId) {
      await tx.loan.update({
        where: { userId_id: { userId, id: loan.id } },
        data: {
          nextDueDate: retreatByFrequency(
            loan.nextDueDate,
            loan.paymentFrequency,
            loan.dueDayOfMonth,
          ),
        },
      })
    }
  })
}

/**
 * Records that a loan is finished — repaid, refinanced, forgiven, or settled
 * outside the app.
 *
 * The row is kept, its instalments are kept, and the outstanding principal is
 * *not* zeroed: what happened stays readable, and the page shows the loan as
 * closed from then on. Only its meaning changes — a closed loan is excluded from
 * Net Worth and the dashboard's totals and can receive no further instalments or
 * edits, so its `nextDueDate` never moves again either. No money moves: nothing
 * here touches a transaction, and those its disbursement or its instalments
 * recorded in an account stay exactly where they are (spec 2026-10-12 §4).
 *
 * Runs in a transaction taking the same row lock as `recordLoanPayment`, which is
 * what makes the payment-vs-close race resolve cleanly in both directions
 * (module comment). Locking also makes the idempotent early return honest: the
 * status it read cannot change between the read and the update.
 *
 * Idempotent, and deliberately not a `LoanNotActiveError`: closing an
 * already-closed loan is the *same request as the one that succeeded*, which is
 * what a double-click or a stale tab produces, and answering it with an error
 * would report a failure for a state the user already has. The early return is a
 * true no-op — no write at all, so `updatedAt` is not bumped either. Payments
 * and edits still throw, because those ask for a change that will not happen.
 */
export async function closeLoan(userId: string, loanId: string): Promise<LoanRow> {
  await prisma.$transaction(async (tx) => {
    await lockLoanRow(tx, userId, loanId)

    const loan = await tx.loan.findUniqueOrThrow({
      where: { userId_id: { userId, id: loanId } },
      select: { status: true },
    })
    if (loan.status === 'CLOSED') return

    await tx.loan.update({
      where: { userId_id: { userId, id: loanId } },
      data: { status: 'CLOSED' },
    })
  })
  return readLoanRow(userId, loanId)
}
