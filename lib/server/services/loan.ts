import { Prisma } from '@prisma/client'
import type { LoanPayment, LoanStoredStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { advanceByFrequency } from '@/lib/datetime/add-months-clamped'
import {
  calendarDateToUtcCarrier,
  compareCalendarDates,
  formatCalendarDate,
} from '@/lib/datetime/calendar-date'
import {
  createLoanSchema,
  recordLoanPaymentSchema,
  updateLoanSchema,
  type CreateLoanInput,
  type RecordLoanPaymentInput,
  type UpdateLoanInput,
} from '@/lib/validation/loan'

/**
 * Loan service (spec §4.10) — money the user owes a lender, and the instalments
 * they have recorded against it.
 *
 * Six invariants live here and are never delegated to the UI:
 *
 * 1. **Tracking only.** Nothing in this file creates a Transaction or a
 *    Transfer, reads or writes a FinancialAccount, or changes a balance — it
 *    imports none of `transaction.ts`, `transfer.ts`, `balance.ts` or
 *    `financial-account.ts`, and `loan.test.ts` proves the absence twice over:
 *    structurally (no such import specifier appears in this source) and
 *    behaviourally (the account/transaction/transfer counts, the seeded rows and
 *    the derived balance are re-asserted after *every* case). Paying an
 *    instalment is bookkeeping about an agreement with a lender; whether the
 *    cash also moved through a tracked account is a separate fact the user
 *    records separately, and no automatic rule can tell the two apart.
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
 *    ledger ruling R5-3), so there is no FX import at all — and therefore
 *    nothing slow that could run inside a held lock.
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
 * loan id is a P2025, never a usable reference.
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
 * There is deliberately no FX call, no network access and no non-database work
 * of any kind inside either transaction: an interactive transaction holds a
 * pooled connection and its locks for its whole duration under Prisma's 5s
 * default timeout, so anything slow in there would stall every other writer on
 * the same loan (the reasoning `account-lock.ts` sets out at length). The Zod
 * parse and the calendar-date conversions are therefore hoisted out of the
 * transaction, and the only arithmetic inside it is `Prisma.Decimal` comparison
 * and the pure date advance.
 */

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
 * down — a foreign loan id is a P2025 — holds for the locking path too.
 */
function prismaNotFound(loanId: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. Loan ${loanId} was not found for this user.`,
    { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
  )
}

/**
 * Takes an exclusive lock on one Loan row, tenant-scoped in the SQL itself.
 *
 * Must be called inside `prisma.$transaction`: the lock is held until that
 * transaction commits or rolls back, and taking it on the bare client would
 * release it immediately and prove nothing (`account-lock.ts` makes the same
 * point about accounts). Shared by `recordLoanPayment` and `closeLoan` so that
 * "the same lock" is literally the same statement, which is what makes their
 * race resolve deterministically either way round.
 *
 * Exactly one row is ever locked here, so there is no lock-ordering deadlock to
 * avoid — the reason `lockAccountRows` has to sort its ids does not arise.
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
  if (locked.length === 0) throw prismaNotFound(loanId)
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
 */
export type LoanRow = Prisma.LoanGetPayload<{ include: { payments: true } }>

export interface LoanWithOutstanding {
  loan: LoanRow
  /** Σ of this loan's `principalAmount` values, from the authoritative
   *  `groupBy` sum — the only part that pays the loan down. */
  principalPaid: Prisma.Decimal
  /** Σ of this loan's `interestAmount` values: what the loan has cost so far.
   *  It reduces nothing and is reported separately for exactly that reason. */
  interestPaid: Prisma.Decimal
  outstandingPrincipal: Prisma.Decimal
  displayStatus: LoanDisplayStatus
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
 *  loan without its instalments or with them in a different order. */
const WITH_PAYMENTS = { payments: { orderBy: PAYMENT_ORDER } } satisfies Prisma.LoanInclude

/** Live loans before closed ones — the order the Loans page renders. */
const STATUS_RANK: Record<LoanStoredStatus, number> = { ACTIVE: 0, CLOSED: 1 }

/**
 * Sorted in memory rather than with `orderBy: { status: 'asc' }`, which would
 * order by the enum's *declaration* order in Postgres and so make the page's
 * display order an invisible consequence of how `LoanStoredStatus` happens to be
 * written in `schema.prisma`. The rank above says the intent outright. (Same
 * reasoning, and the same total ordering, as `debt.ts` and `savings-goal.ts`.)
 */
function compareForDisplay(a: LoanRow, b: LoanRow): number {
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
 */
export async function getLoansWithOutstanding(
  userId: string,
  today: string,
  options: { activeOnly?: boolean } = {},
): Promise<LoanWithOutstanding[]> {
  const [loans, sums] = await Promise.all([
    prisma.loan.findMany({
      where: options.activeOnly ? { userId, status: 'ACTIVE' } : { userId },
      include: WITH_PAYMENTS,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.loanPayment.groupBy({
      by: ['loanId'],
      where: { userId },
      _sum: { principalAmount: true, interestAmount: true },
    }),
  ])

  const paidByLoan = new Map(sums.map((row) => [row.loanId, row._sum]))

  return loans.sort(compareForDisplay).map((loan) => {
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
 * Records a new loan.
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
 */
export async function createLoan(userId: string, input: CreateLoanInput): Promise<LoanRow> {
  const parsed = createLoanSchema.parse(input)
  const nextDueDate = calendarDateToUtcCarrier(parsed.nextDueDate)

  return prisma.loan.create({
    data: {
      userId,
      lender: parsed.lender,
      // `String()` first, for every amount in this file: that is the exact
      // representation `lib/validation/money.ts` inspected when it accepted the
      // value as having at most 2 decimal places (and the one the pg adapter
      // serialises), so what is stored is precisely what was validated — rather
      // than whatever the Decimal constructor makes of a raw double.
      principal: new Prisma.Decimal(String(parsed.principal)),
      currency: parsed.currency,
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
    },
    include: WITH_PAYMENTS,
  })
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

  return prisma.loan.update({
    where: { userId_id: { userId, id: loanId } },
    data: {
      lender: parsed.lender,
      scheduledPaymentAmount: new Prisma.Decimal(String(parsed.scheduledPaymentAmount)),
      // An edit that clears the notes stores `null` — the absence has to be
      // written, not skipped, or the old value would survive and the user could
      // never remove it.
      notes: parsed.notes ?? null,
    },
    include: WITH_PAYMENTS,
  })
}

/**
 * Records an instalment against a loan, and advances the schedule.
 *
 * The whole read-check-write-write happens inside one interactive transaction
 * that first takes an exclusive row lock on the Loan row, for the reasons set out
 * in the module comment: without it two concurrent instalments would either take
 * the loan past repaid, or both advance the due date from the same starting
 * value and so lose one interval.
 *
 * The two writes — the `LoanPayment` insert and the `nextDueDate` update — are in
 * the same transaction on purpose, and that is what the returned pair reports.
 * They commit or roll back together, so there is never an instalment with an
 * unmoved schedule (the user would be asked to pay the same month twice) and
 * never a moved schedule with no instalment behind it (the month would silently
 * be skipped). `loan.test.ts` proves it from the outside: after a rejected
 * overpayment the due date is exactly where it was.
 *
 * Tracking only: the two writes above are the only writes. No account, no
 * transaction, no balance, and no FX — an instalment inherits the loan's
 * currency, so there is nothing to convert and nothing slow inside the lock.
 */
export async function recordLoanPayment(
  userId: string,
  loanId: string,
  input: RecordLoanPaymentInput,
): Promise<{ payment: LoanPayment; nextDueDate: Date }> {
  // Hoisted out of the transaction: parsing and date conversion are pure CPU
  // work that must not happen while a row lock is held.
  const parsed = recordLoanPaymentSchema.parse(input)
  const totalAmount = new Prisma.Decimal(String(parsed.totalAmount))
  const principalAmount = new Prisma.Decimal(String(parsed.principalAmount))
  const interestAmount = new Prisma.Decimal(String(parsed.interestAmount))
  const paymentDate = calendarDateToUtcCarrier(parsed.paymentDate)

  return prisma.$transaction(async (tx) => {
    // 1. Exclusive row lock, tenant-scoped, or P2025 for an id that is not this
    //    user's.
    await lockLoanRow(tx, userId, loanId)

    // 2. Typed re-read under the lock. The raw SELECT is only the lock —
    //    `$queryRaw` gives no guarantee about how a DECIMAL column arrives in
    //    JS, and money must never travel through a float, so the row the
    //    decision is made on comes from Prisma's typed client.
    const loan = await tx.loan.findUniqueOrThrow({
      where: { userId_id: { userId, id: loanId } },
    })
    // Under the lock, so a close that committed first is visible here and no
    // instalment can land against an already-closed loan.
    if (loan.status !== 'ACTIVE') throw new LoanNotActiveError()

    // 3. The split, re-checked in decimal arithmetic (layer two of three).
    if (!totalAmount.equals(principalAmount.plus(interestAmount))) {
      throw new LoanSplitMismatchError()
    }

    // 4. Sum under the same lock: this is the authoritative outstanding
    //    principal, not the one a caller may have read a moment ago. Only the
    //    principal parts are summed — interest never pays a loan down.
    const principalPaid =
      (
        await tx.loanPayment.aggregate({
          where: { userId, loanId },
          _sum: { principalAmount: true },
        })
      )._sum.principalAmount ?? new Prisma.Decimal(0)
    const outstandingPrincipal = deriveLoanOutstandingPrincipal(loan.principal, principalPaid)
    // `gt`, so a principal payment of exactly what is left is accepted —
    // settling a loan is the most common last payment there is. The interest
    // part is not compared at all: a repaid loan can still owe a final charge.
    if (principalAmount.gt(outstandingPrincipal)) {
      throw new LoanOverpaymentError(outstandingPrincipal)
    }

    // 5. The two writes, together. `advanceByFrequency` is pure arithmetic on
    //    the due date read under this lock, so the value written is one interval
    //    on from the real, current schedule — never from a stale read.
    const payment = await tx.loanPayment.create({
      data: {
        userId,
        loanId,
        totalAmount,
        principalAmount,
        interestAmount,
        paymentDate,
        note: parsed.note ?? null,
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
 * Records that a loan is finished — repaid, refinanced, forgiven, or settled
 * outside the app.
 *
 * The row is kept, its instalments are kept, and the outstanding principal is
 * *not* zeroed: what happened stays readable, and the page shows the loan as
 * closed from then on. Only its meaning changes — a closed loan is excluded from
 * Net Worth and the dashboard's totals and can receive no further instalments or
 * edits, so its `nextDueDate` never moves again either.
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
  return prisma.$transaction(async (tx) => {
    await lockLoanRow(tx, userId, loanId)

    const loan = await tx.loan.findUniqueOrThrow({
      where: { userId_id: { userId, id: loanId } },
      include: WITH_PAYMENTS,
    })
    if (loan.status === 'CLOSED') return loan

    return tx.loan.update({
      where: { userId_id: { userId, id: loanId } },
      data: { status: 'CLOSED' },
      include: WITH_PAYMENTS,
    })
  })
}
