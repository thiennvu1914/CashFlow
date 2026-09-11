import { Prisma } from '@prisma/client'
import type { Debt, DebtPayment, DebtStoredStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  calendarDateToUtcCarrier,
  compareCalendarDates,
  formatCalendarDate,
} from '@/lib/datetime/calendar-date'
import {
  createDebtSchema,
  recordDebtPaymentSchema,
  updateDebtSchema,
  type CreateDebtInput,
  type RecordDebtPaymentInput,
  type UpdateDebtInput,
} from '@/lib/validation/debt'

/**
 * Debt service (spec §4.9) — money someone owes the user (RECEIVABLE) or the
 * user owes someone else (PAYABLE), plus the repayments recorded against it.
 *
 * Five invariants live here and are never delegated to the UI:
 *
 * 1. **Tracking only.** Nothing in this file creates a Transaction or a
 *    Transfer, reads or writes a FinancialAccount, or changes a balance — it
 *    imports none of `transaction.ts`, `transfer.ts`, `balance.ts` or
 *    `financial-account.ts`, and `debt.test.ts` proves the absence twice over:
 *    structurally (no such import specifier appears in this source) and
 *    behaviourally (the account/transaction/transfer counts, the seeded rows
 *    and the derived balance are re-asserted after *every* case). Recording a
 *    repayment is bookkeeping about an agreement between two people; whether
 *    the cash also moved through a tracked account is a separate fact the user
 *    records separately, and no automatic rule can tell the two apart.
 * 2. **Outstanding is derived, never stored.** `originalAmount − Σ payments`,
 *    computed on read (spec §5, "never store what can drift"). A stored copy
 *    would be a second source of truth that a rolled-back write, a deleted
 *    payment or a concurrent request could put out of step with the payment
 *    rows themselves — the same reasoning that keeps account balances derived.
 * 3. **The display status is derived too**, all of it except WRITTEN_OFF.
 *    OPEN / PARTIALLY_PAID / PAID follow from the outstanding amount and
 *    OVERDUE from the due date, so none of them can go stale; writing a debt
 *    off is the one genuine human decision ("I am never getting this back"),
 *    so it is the one thing stored — and it is terminal.
 * 4. **No overpayment, ever.** A payment above what is still owed is refused
 *    (`DebtOverpaymentError`); a payment of exactly what is left is accepted.
 *    That rule is a cross-row invariant, so no CHECK constraint can express it
 *    and it is enforced here — under a row lock, see below.
 * 5. **Money is `Prisma.Decimal` end to end.** Every amount that enters is
 *    built with `new Prisma.Decimal(String(...))` so a 2-decimal input is
 *    exact, and there is no `toNumber()` anywhere in this file. Each debt keeps
 *    its own currency and nothing here converts one (`User.baseCurrency` is
 *    display-only, ledger ruling R5-3), so there is no FX import at all.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — including the raw locking
 * `SELECT` below. Every single-row lookup goes through the composite `userId_id`
 * key, so another user's debt id is a P2025, never a usable reference.
 *
 * ## Why a row lock, and not Serializable
 *
 * `recordDebtPayment` is a read-check-write: it sums the payments, compares the
 * new amount against what is left, and only then inserts. Under READ COMMITTED
 * each statement sees rows committed at the moment it runs, so two payments
 * arriving together (a double-clicked button, two open tabs) would both read
 * the *same* pre-race sum, both pass the check, and both commit — leaving a
 * 1,000,000 debt with 1,200,000 recorded against it and a negative outstanding
 * the UI cannot explain.
 *
 * `SELECT … FOR UPDATE` on the Debt row, taken inside the same transaction as
 * the insert, closes that window: the lock conflicts with any other
 * `FOR UPDATE` and with `UPDATE`, so the second payment queues until the first
 * commits and then re-reads the real, post-commit sum — and is refused with
 * `DebtOverpaymentError`, the same error it would have got had the two arrived
 * a second apart. Serialisation, not optimism, exactly as
 * `lib/server/services/account-lock.ts` does it for accounts.
 *
 * Serializable was the other candidate (and is what this group's plan
 * proposed). It is rejected here because it converts a *predictable* domain
 * failure into an unpredictable infrastructure one: the loser aborts with a
 * serialization failure (P2034) rather than "that is more than is still owed",
 * which the UI would have to either surface as "please try again" — asking the
 * user to redo a request whose real answer is already known — or paper over
 * with a retry loop that then has to re-run the check anyway. The row lock
 * gives the loser the true answer on its first attempt, with no retry scheme,
 * no P2034 mapping and no lost work.
 *
 * The lock is also what makes the payment-vs-write-off race resolve cleanly,
 * both ways round, because `writeOffDebt` takes the same lock:
 *
 * - payment first: it commits, then the write-off proceeds and the payment
 *   stays in the history (a debt written off after a partial repayment keeps
 *   that repayment — the money really did arrive);
 * - write-off first: the payment re-reads the row *under the lock*, sees
 *   WRITTEN_OFF and is refused with `DebtNotActiveError`, so no payment can
 *   ever be recorded against a debt that was already closed.
 *
 * There is deliberately no FX call, no network access and no non-database work
 * of any kind inside either transaction: an interactive transaction holds a
 * pooled connection and its locks for its whole duration under Prisma's 5s
 * default timeout, so anything slow in there would stall every other writer on
 * the same debt (the reasoning `account-lock.ts` sets out at length).
 */

/**
 * Thrown when a payment would take a debt past settled.
 *
 * Carries the outstanding amount that was true *under the lock*, so the caller
 * can tell the user what would have fitted without re-querying — a second query
 * would be another read outside the transaction, and could itself be stale by
 * the time it is rendered.
 */
export class DebtOverpaymentError extends Error {
  readonly outstanding: Prisma.Decimal

  constructor(outstanding: Prisma.Decimal) {
    super('Payment exceeds the amount still owed.')
    this.name = 'DebtOverpaymentError'
    this.outstanding = outstanding
  }
}

/**
 * Thrown when a written-off debt would receive a payment or an edit.
 *
 * A distinct error rather than a P2025: the row exists and the user can still
 * see it in their list, so "that debt no longer exists" would be a lie. A
 * written-off debt is frozen — the decision has been recorded and its history
 * is now read-only.
 */
export class DebtNotActiveError extends Error {
  constructor() {
    super('This debt has been written off and cannot receive payments.')
    this.name = 'DebtNotActiveError'
  }
}

/**
 * Prisma's own `P2025`, byte for byte what `findUniqueOrThrow` raises on a
 * composite `(userId, id)` lookup that does not match.
 *
 * The locking `SELECT` in `lockDebtRow` is raw SQL, so an id belonging to
 * another user comes back as an empty result set rather than an error — and
 * that must not be distinguishable, by a caller or by an attacker, from
 * Prisma's answer for a nonexistent id. Rebuilt here (rather than exported from
 * `account-lock.ts`, where the equivalent helper is private and speaks about
 * financial accounts) so the tenant-isolation contract every action error map
 * and test already pins down — a foreign debt id is a P2025 — holds for the
 * locking path too.
 */
function prismaNotFound(debtId: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. Debt ${debtId} was not found for this user.`,
    { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
  )
}

/**
 * Takes an exclusive lock on one Debt row, tenant-scoped in the SQL itself.
 *
 * Must be called inside `prisma.$transaction`: the lock is held until that
 * transaction commits or rolls back, and taking it on the bare client would
 * release it immediately and prove nothing (`account-lock.ts` makes the same
 * point about accounts). Shared by `recordDebtPayment` and `writeOffDebt` so
 * that "the same lock" is literally the same statement, which is what makes
 * their race resolve deterministically either way round.
 *
 * Exactly one row is ever locked here, so there is no lock-ordering deadlock to
 * avoid — the reason `lockAccountRows` has to sort its ids does not arise.
 */
async function lockDebtRow(
  tx: Prisma.TransactionClient,
  userId: string,
  debtId: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "Debt"
    WHERE "userId" = ${userId} AND "id" = ${debtId}
    FOR UPDATE`
  // An empty result means the id is not this user's debt — or does not exist at
  // all, and the two must be indistinguishable.
  if (locked.length === 0) throw prismaNotFound(debtId)
}

/** The one status a debt row actually stores, plus the four states derived from
 *  its payments and its due date. */
export type DebtDisplayStatus = 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'WRITTEN_OFF'

/**
 * A debt with its payment history — the shape every read in this module
 * returns.
 *
 * The payments always travel with the debt because a debt without them is
 * unreadable: the outstanding amount is *made of* them, and the UI shows the
 * history right under the figure. Written as a `GetPayload` so a later phase
 * that widens the include widens every caller with it, rather than silently not
 * seeing the new relation.
 */
export type DebtRow = Prisma.DebtGetPayload<{ include: { payments: true } }>

/**
 * The same derived figures over a debt read *without* its history — what
 * `getDebtsWithOutstanding(..., { includePayments: false })` returns.
 *
 * Deliberately the same four fields in the same order, differing only in the
 * `debt` row's shape: `paid` and `outstanding` come from the `groupBy` sum on
 * both paths, so there is exactly one definition of what a debt has outstanding
 * (`debt.test.ts` asserts the two paths agree figure by figure). A caller that
 * renders the history asks for it; one that renders a total does not, and is
 * then held to that by the type rather than by a comment.
 */
export interface DebtTotals {
  debt: Debt
  /** Σ of this debt's payments, from the authoritative `groupBy` sum. */
  paid: Prisma.Decimal
  outstanding: Prisma.Decimal
  displayStatus: DebtDisplayStatus
}

export interface DebtWithOutstanding extends DebtTotals {
  debt: DebtRow
}

/**
 * Oldest payment first — the order a history reads in.
 *
 * All three keys are compared so the order is total: `date` is a calendar-date
 * carrier, so several payments can share a day, and `createdAt` can tie inside
 * a millisecond. Without the tie-breaks the same history could render in one
 * order on one request and another order on the next.
 */
const PAYMENT_ORDER = [
  { date: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.DebtPaymentOrderByWithRelationInput[]

/** The one include every read here uses, so no caller can accidentally fetch a
 *  debt without its payments or with them in a different order. */
const WITH_PAYMENTS = { payments: { orderBy: PAYMENT_ORDER } } satisfies Prisma.DebtInclude

/** Live debts before closed ones — the order the Debts page renders. */
const STATUS_RANK: Record<DebtStoredStatus, number> = { ACTIVE: 0, WRITTEN_OFF: 1 }

/**
 * Sorted in memory rather than with `orderBy: { status: 'asc' }`, which would
 * order by the enum's *declaration* order in Postgres and so make the page's
 * display order an invisible consequence of how `DebtStoredStatus` happens to
 * be written in `schema.prisma`. The rank above says the intent outright.
 * (Same reasoning, and the same total ordering, as `savings-goal.ts`.)
 */
function compareForDisplay(a: Debt, b: Debt): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  )
}

/** `undefined` (no agreed date) stays `null`; a `yyyy-MM-dd` becomes its
 *  UTC-midnight carrier. The only place a debt's due date is built. */
function dueDateCarrier(dueDate: string | undefined): Date | null {
  return dueDate === undefined ? null : calendarDateToUtcCarrier(dueDate)
}

/**
 * What is still owed: the original amount minus everything paid against it.
 *
 * The whole of invariant 2 in one line, exported and unit-tested directly.
 * `Prisma.Decimal` arithmetic, never a `number` detour: at VND magnitudes a
 * float subtraction can leave a phantom residue of a fraction of a dong, and
 * "is this debt settled?" is decided by comparing this value with zero.
 */
export function deriveDebtOutstanding(
  originalAmount: Prisma.Decimal,
  paid: Prisma.Decimal,
): Prisma.Decimal {
  return originalAmount.sub(paid)
}

/**
 * The state to show for a debt, given what is still outstanding and what day it
 * is for the user.
 *
 * The order of the branches *is* the product decision, and each one outranks
 * the ones below it for a reason:
 *
 * - **WRITTEN_OFF** first: the user's recorded decision outranks any
 *   arithmetic. A written-off debt with money still nominally owed is written
 *   off, not overdue.
 * - **PAID** next: a debt repaid *late* is repaid. Showing OVERDUE on a settled
 *   debt would tell the user to chase money they already have. `lte(0)` rather
 *   than `eq(0)` so a debt that somehow holds more payments than its original
 *   amount (only reachable by writing rows outside this service) still reads as
 *   settled instead of falling through to OPEN.
 * - **OVERDUE** next, ahead of PARTIALLY_PAID: what matters about a late debt
 *   is that it is late, whether or not something has been paid.
 * - then **PARTIALLY_PAID** / **OPEN** from the arithmetic.
 *
 * `today` is a `yyyy-MM-dd` string the caller derives from the user's timezone
 * (`todayCalendarDateInZone`), and the comparison is between two calendar
 * strings — never `dueDate < new Date()`, which would compare a UTC-midnight
 * carrier against an instant and so call a debt overdue up to a day early or
 * late depending on the reader's zone. Passing `today` in also keeps every
 * caller and every test deterministic (ruling R6-7).
 */
export function deriveDebtDisplayStatus(
  debt: { status: DebtStoredStatus; originalAmount: Prisma.Decimal; dueDate: Date | null },
  outstanding: Prisma.Decimal,
  today: string,
): DebtDisplayStatus {
  if (debt.status === 'WRITTEN_OFF') return 'WRITTEN_OFF'
  if (outstanding.lte(0)) return 'PAID'
  // Strictly before today: a debt due *today* is not late — the user has the
  // whole day to settle it.
  if (debt.dueDate && compareCalendarDates(formatCalendarDate(debt.dueDate), today) < 0) {
    return 'OVERDUE'
  }
  if (outstanding.lt(debt.originalAmount)) return 'PARTIALLY_PAID'
  return 'OPEN'
}

/**
 * Every debt the user has, written-off ones included, each with its payments.
 *
 * Unbounded by design, like `listAllBudgets` and `listAllSavingsGoals`: a cap on
 * a user's complete data is silent data loss rather than a safeguard. Nothing
 * here deletes a debt, and writing one off never hides it — it moves to the end
 * of the list.
 */
export async function listDebts(userId: string): Promise<DebtRow[]> {
  const debts = await prisma.debt.findMany({
    where: { userId },
    include: WITH_PAYMENTS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return debts.sort(compareForDisplay)
}

/**
 * The Debts page's read: every debt with its derived paid total, outstanding
 * amount and display status.
 *
 * Two queries regardless of how many debts the user has — one `findMany` for
 * the rows and their history, one `groupBy` for the sums — never a sum per
 * debt, which would make rendering the page cost a round trip per row. The
 * `groupBy` is the authoritative total and the included payments are the
 * history the UI lists; `debt.test.ts` asserts the two agree for every debt, so
 * a total can never disagree with the rows shown beneath it.
 *
 * The `groupBy` is scoped by `userId` alone rather than by the filtered debt
 * ids: it is one aggregate over the user's own payments either way, and a
 * second `where` clause built from the first query's results would make the two
 * queries dependent (and so sequential) for no gain. Extra entries for debts
 * the filter excluded are simply never looked up.
 *
 * `activeOnly` is what the dashboard and Net Worth will pass: a written-off
 * debt is not an asset or a liability any more, but it is still part of the
 * user's history and stays visible on the page itself.
 *
 * `includePayments: false` drops the history from the payload and nothing else
 * (Phase 8, finding B-7). The figures are unchanged — they were always the
 * `groupBy`'s, never the included rows' — so this is one read path and one
 * definition of what a debt has outstanding, with the O(payments) payload made
 * optional for the callers that never render a payment: Net Worth
 * (`position.ts`, which the dashboard and the Accounts page's header total both
 * read through) and the export's Debts and Summary sheets. The default is
 * `true`, so the Debts page, which does render every repayment, is untouched.
 */
export async function getDebtsWithOutstanding(
  userId: string,
  today: string,
  options?: { activeOnly?: boolean; includePayments?: true },
): Promise<DebtWithOutstanding[]>
export async function getDebtsWithOutstanding(
  userId: string,
  today: string,
  options: { activeOnly?: boolean; includePayments: boolean },
): Promise<DebtTotals[]>
export async function getDebtsWithOutstanding(
  userId: string,
  today: string,
  options: { activeOnly?: boolean; includePayments?: boolean } = {},
): Promise<DebtTotals[]> {
  const where = options.activeOnly ? { userId, status: 'ACTIVE' as const } : { userId }
  const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
  const [debts, sums] = await Promise.all([
    // Two calls rather than one with a conditional `include` key, so each keeps
    // its own precise Prisma payload type instead of collapsing to a union the
    // caller would have to narrow.
    options.includePayments === false
      ? prisma.debt.findMany({ where, orderBy })
      : prisma.debt.findMany({ where, include: WITH_PAYMENTS, orderBy }),
    prisma.debtPayment.groupBy({
      by: ['debtId'],
      where: { userId },
      _sum: { amount: true },
    }),
  ])

  const paidByDebt = new Map(
    sums.map((row) => [row.debtId, row._sum.amount ?? new Prisma.Decimal(0)]),
  )

  // Widened to `Debt` so the two `findMany` shapes share one sort and one
  // derivation; the overload above is what hands a caller back the precise row
  // type it asked for.
  const rows: Debt[] = debts
  return rows.sort(compareForDisplay).map((debt) => {
    const paid = paidByDebt.get(debt.id) ?? new Prisma.Decimal(0)
    const outstanding = deriveDebtOutstanding(debt.originalAmount, paid)
    return {
      debt,
      paid,
      outstanding,
      displayStatus: deriveDebtDisplayStatus(debt, outstanding, today),
    }
  })
}

/**
 * What one debt still has owed against it.
 *
 * A convenience for a single-debt caller (a payment form's "how much is left?",
 * and the tests) rather than the page's read path — use
 * `getDebtsWithOutstanding` for a list, which costs two queries for any number
 * of debts instead of two per debt.
 *
 * Deliberately *not* the value `recordDebtPayment` checks against: this read
 * happens outside any transaction, so it is a snapshot that another request can
 * invalidate the moment it returns. The authoritative check is the one taken
 * under the row lock.
 */
export async function getDebtOutstanding(userId: string, debtId: string): Promise<Prisma.Decimal> {
  const debt = await prisma.debt.findUniqueOrThrow({
    where: { userId_id: { userId, id: debtId } },
  })
  const paid =
    (await prisma.debtPayment.aggregate({ where: { userId, debtId }, _sum: { amount: true } }))._sum
      .amount ?? new Prisma.Decimal(0)
  return deriveDebtOutstanding(debt.originalAmount, paid)
}

/**
 * Records a new debt.
 *
 * Fields are listed explicitly rather than spread, so the authenticated
 * `userId` can never be overridden regardless of Zod's stripping behaviour and
 * a client-supplied `status` is ignored rather than obeyed — a new debt is
 * ACTIVE, and only `writeOffDebt` changes that.
 */
export async function createDebt(userId: string, input: CreateDebtInput): Promise<DebtRow> {
  const parsed = createDebtSchema.parse(input)

  return prisma.debt.create({
    data: {
      userId,
      direction: parsed.direction,
      person: parsed.person,
      description: parsed.description ?? null,
      // `String()` first, for every amount in this file: that is the exact
      // representation `lib/validation/money.ts` inspected when it accepted
      // the value as having at most 2 decimal places (and the one the pg
      // adapter serialises), so what is stored is precisely what was
      // validated — rather than whatever the Decimal constructor makes of a
      // raw double.
      originalAmount: new Prisma.Decimal(String(parsed.originalAmount)),
      currency: parsed.currency,
      dueDate: dueDateCarrier(parsed.dueDate),
      notes: parsed.notes ?? null,
    },
    include: WITH_PAYMENTS,
  })
}

/**
 * Corrects or renegotiates a debt: who it is with, what it was for, when it is
 * due, and the notes.
 *
 * `direction`, `originalAmount` and `currency` are not editable and are not in
 * `updateDebtSchema` at all — see the ruling documented there: they define
 * which debt this is, and changing one after payments exist would re-interpret
 * that history against terms the debt never had.
 *
 * The row is read first through the composite `userId_id` key, so another
 * user's debt id resolves to nothing and raises Prisma's P2025 (propagated
 * untouched, as every service here does). A written-off debt is frozen and
 * raises `DebtNotActiveError` instead of being quietly reopened.
 *
 * No row lock: an edit touches none of the fields the payment check reads, so
 * it cannot race a payment into breaking an invariant. The worst a concurrent
 * write-off can do is let an edit land a moment before the freeze — which is
 * indistinguishable from the user having clicked Save a moment earlier.
 */
export async function updateDebt(
  userId: string,
  debtId: string,
  input: UpdateDebtInput,
): Promise<DebtRow> {
  const parsed = updateDebtSchema.parse(input)
  const existing = await prisma.debt.findUniqueOrThrow({
    where: { userId_id: { userId, id: debtId } },
  })
  if (existing.status !== 'ACTIVE') throw new DebtNotActiveError()

  return prisma.debt.update({
    where: { userId_id: { userId, id: debtId } },
    data: {
      person: parsed.person,
      // An edit that clears one of these stores `null` — the absence has to be
      // written, not skipped, or the old value would survive and the user could
      // never remove it.
      description: parsed.description ?? null,
      dueDate: dueDateCarrier(parsed.dueDate),
      notes: parsed.notes ?? null,
    },
    include: WITH_PAYMENTS,
  })
}

/**
 * Records a repayment against a debt.
 *
 * The whole read-check-write happens inside one interactive transaction that
 * first takes an exclusive row lock on the Debt row, for the reasons set out in
 * the module comment: without it two concurrent payments would both read the
 * same outstanding amount, both pass the check, and together take the debt past
 * settled.
 *
 * Tracking only: the single write is the `DebtPayment` row. No account, no
 * transaction, no balance, and no FX — a payment inherits the debt's currency,
 * so there is nothing to convert and nothing slow inside the lock.
 */
export async function recordDebtPayment(
  userId: string,
  debtId: string,
  input: RecordDebtPaymentInput,
): Promise<DebtPayment> {
  const parsed = recordDebtPaymentSchema.parse(input)
  const amount = new Prisma.Decimal(String(parsed.amount))
  const date = calendarDateToUtcCarrier(parsed.date)

  return prisma.$transaction(async (tx) => {
    // 1. Exclusive row lock, tenant-scoped, or P2025 for an id that is not
    //    this user's.
    await lockDebtRow(tx, userId, debtId)

    // 2. Typed re-read under the lock. The raw SELECT is only the lock —
    //    `$queryRaw` gives no guarantee about how a DECIMAL column arrives in
    //    JS, and money must never travel through a float, so the row the
    //    decision is made on comes from Prisma's typed client.
    const debt = await tx.debt.findUniqueOrThrow({
      where: { userId_id: { userId, id: debtId } },
    })
    // Under the lock, so a write-off that committed first is visible here and
    // no payment can land against an already-closed debt.
    if (debt.status !== 'ACTIVE') throw new DebtNotActiveError()

    // 3. Sum under the same lock: this is the authoritative outstanding amount,
    //    not the one a caller may have read a moment ago.
    const paid =
      (await tx.debtPayment.aggregate({ where: { userId, debtId }, _sum: { amount: true } }))._sum
        .amount ?? new Prisma.Decimal(0)
    const outstanding = deriveDebtOutstanding(debt.originalAmount, paid)
    // `gt`, so a payment of exactly what is left is accepted — settling a debt
    // is the most common last payment there is.
    if (amount.gt(outstanding)) throw new DebtOverpaymentError(outstanding)

    // 4. The one write. Tracking only — nothing else is touched.
    return tx.debtPayment.create({
      data: { userId, debtId, amount, date, note: parsed.note ?? null },
    })
  })
}

/**
 * Records that a debt will not be repaid (or has been forgiven).
 *
 * The row is kept, its payments are kept, and the outstanding amount is *not*
 * zeroed: what happened stays readable, and the page shows the debt as written
 * off from then on. Only its meaning changes — a written-off debt is excluded
 * from Net Worth and the dashboard's totals (Group 4 onwards) and can receive
 * no further payments or edits.
 *
 * Runs in a transaction taking the same row lock as `recordDebtPayment`, which
 * is what makes the payment-vs-write-off race resolve cleanly in both
 * directions (module comment). Locking also makes the idempotent early return
 * honest: the status it read cannot change between the read and the update.
 *
 * Idempotent, and deliberately not a `DebtNotActiveError`: writing off an
 * already-written-off debt is the *same request as the one that succeeded*,
 * which is what a double-click or a stale tab produces, and answering it with
 * an error would report a failure for a state the user already has. The early
 * return is a true no-op — no write at all, so `updatedAt` is not bumped
 * either. Payments and edits still throw, because those ask for a change that
 * will not happen.
 */
export async function writeOffDebt(userId: string, debtId: string): Promise<DebtRow> {
  return prisma.$transaction(async (tx) => {
    await lockDebtRow(tx, userId, debtId)

    const debt = await tx.debt.findUniqueOrThrow({
      where: { userId_id: { userId, id: debtId } },
      include: WITH_PAYMENTS,
    })
    if (debt.status === 'WRITTEN_OFF') return debt

    return tx.debt.update({
      where: { userId_id: { userId, id: debtId } },
      data: { status: 'WRITTEN_OFF' },
      include: WITH_PAYMENTS,
    })
  })
}
