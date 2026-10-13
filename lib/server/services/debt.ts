import { Prisma } from '@prisma/client'
import type { Debt, DebtPayment, DebtStoredStatus } from '@prisma/client'
import { createTranslator } from 'next-intl'
import { prisma } from '@/lib/prisma'
import { getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import {
  calendarDateToUtcCarrier,
  compareCalendarDates,
  formatCalendarDate,
} from '@/lib/datetime/calendar-date'
import { calendarDateToEntryInstant, instantToLocalDateTime } from '@/lib/datetime/local-date-time'
import type { Locale } from '@/lib/i18n/locale'
import {
  createDebtSchema,
  linkDebtToAccountSchema,
  recordDebtPaymentSchema,
  updateDebtSchema,
  type CreateDebtInput,
  type LinkDebtToAccountInput,
  type RecordDebtPaymentInput,
  type UpdateDebtInput,
} from '@/lib/validation/debt'
import {
  unlinkFromAccountSchema,
  type UnlinkFromAccountInput,
} from '@/lib/validation/link-to-account'
import enDebtMessages from '@/messages/en/debts.json'
import viDebtMessages from '@/messages/vi/debts.json'
import { lockAccountsForUpdate } from './account-lock'
import {
  LinkedAccountCurrencyMismatchError,
  SNAPSHOT_PAIR,
  insertTransactionInTx,
  linkTransactionOptions,
} from './linked-transaction'
import {
  ConcurrentModificationError,
  lockAndVerifyTransactionRow,
  lockTransactionRowsInAccounts,
} from './transaction'

/**
 * Debt service (spec §4.9) — money someone owes the user (RECEIVABLE) or the
 * user owes someone else (PAYABLE), plus the repayments recorded against it.
 *
 * Five invariants live here and are never delegated to the UI:
 *
 * 1. **Money moves only through an account the user chose** (money-source
 *    linking, spec 2026-10-12 §4 and §6.2, which supersedes §4.9's "tracking
 *    only"). Creating a debt or recording a payment *with* an account writes
 *    the matching Transaction in the same database transaction, through the
 *    shared core `insertTransactionInTx` — CASH_OUT when the user lent and
 *    CASH_IN when they were repaid (RECEIVABLE), CASH_IN when they borrowed and
 *    CASH_OUT when they repaid (PAYABLE) — and links it with a composite,
 *    `ON DELETE RESTRICT` foreign key. *Without* an account (an agreement that
 *    predates the app, or cash that never touched a tracked account) the debt
 *    is bookkeeping between two people and nothing else is written — until the
 *    user records it in an account after all (`linkDebtToAccount`, spec §6.4),
 *    which writes the same transactions after the fact — and a recording in
 *    the wrong account is undone by `unlinkDebtFromAccount`, which deletes
 *    them again. Editing or deleting a payment keeps both sides in step;
 *    writing a debt off moves no money and creates nothing.
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
 *    and it is enforced here — under a row lock, see below. An edited payment
 *    is measured against what is owed *without* it.
 * 5. **Money is `Prisma.Decimal` end to end.** Every amount that enters is
 *    built with `new Prisma.Decimal(String(...))` so a 2-decimal input is
 *    exact, and there is no `toNumber()` anywhere in this file. Each debt keeps
 *    its own currency and nothing here converts one (`User.baseCurrency` is
 *    display-only, ledger ruling R5-3): a linked account must already hold the
 *    debt's currency (`LinkedAccountCurrencyMismatchError` otherwise), and a
 *    debt created with an account simply takes that account's currency. The
 *    only FX involved is the USD/VND snapshot every Transaction carries.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — including the raw locking
 * `SELECT` below. Every single-row lookup goes through the composite `userId_id`
 * key, so another user's debt, payment or account id is a P2025, never a usable
 * reference. The user's timezone and locale arrive the same way, as a
 * `DebtLinkContext` the action layer builds from the session user — this
 * module makes no assumption about whose request it is serving.
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
 * `lib/server/services/account-lock.ts` does it for accounts. Every payment
 * writer — record, edit, delete — takes this lock, so under it the payment rows
 * of one debt cannot change.
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
 * ## Lock order: accounts, then the debt row, then transaction rows
 *
 * A linked write takes up to three kinds of lock, and always in this order:
 *
 * 1. the account(s) — `lockAccountsForUpdate`, one sorted statement, taken
 *    *explicitly before* the debt lock, and the locked row handed to
 *    `insertTransactionInTx` so it does not lock the account a second time
 *    (re-locking a held row returns at once but still costs a round trip);
 * 2. the Debt row — `lockDebtRow`;
 * 3. the linked Transaction row — `lockAndVerifyTransactionRow`.
 *
 * It is the order `createTransaction` (account), `updateTransaction`
 * (accounts, then the transaction row) and `deleteTransaction` already use, and
 * the paths with no account keep today's single debt lock. No path anywhere
 * holds a debt lock while waiting for an account, or a transaction-row lock
 * while waiting for a debt, so no two of them can wait on each other in a
 * cycle: a linked payment racing an edit of another transaction in the same
 * account queues on that account; a payment moved from account A to B racing a
 * transaction moved from B to A both lock {A, B} in the same sorted statement;
 * a write-off (debt lock only) never waits on an account. Locking the debt
 * first and letting `insertTransactionInTx` take the account second would hold
 * the debt while waiting on an account — harmless today, but one future path
 * that went the other way round would deadlock against it.
 *
 * Which account to lock for an edit or a delete is read from a copy taken
 * before the transaction opens, so under the locks the payment and its linked
 * transaction are re-verified against that copy; a row that changed in
 * between is a `ConcurrentModificationError`, exactly as `updateTransaction`
 * treats its own stale copy.
 *
 * FX is fetched *before* any transaction opens, and only when a linked
 * transaction will be written with a new snapshot: an interactive transaction
 * holds a pooled connection and its locks for its whole duration under Prisma's
 * 5s default timeout, so a provider call in there would stall every other
 * writer on the same account and debt (the reasoning `account-lock.ts` sets out
 * at length). Inside the transactions there is database work and nothing else.
 */

/**
 * What a write needs to know about the user that only the session has, passed
 * by the action layer from `resolveProfileDefaults(user)`.
 */
export interface DebtLinkContext {
  /** The user's IANA zone. A payment or money-moved *date* becomes the linked
   *  transaction's instant (`calendarDateToEntryInstant`: now for today, else 12:00 that day) in this zone, so it lands on the
   *  same calendar day the user picked whichever zone later reads it. */
  timezone: string
  /** The language of the default transaction note, rendered once at write
   *  time and stored — never re-rendered on read. */
  locale: Locale
}

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
 * Thrown when a written-off debt would receive a payment or an edit — of the
 * debt itself or of a payment already recorded against it.
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
 * Thrown when "Record in an account" (`linkDebtToAccount`) is asked of a debt
 * whose opening is already recorded in one.
 *
 * Its own error rather than a quiet no-op: a second opening transaction would
 * count the same lent or borrowed money twice, and answering "done" would hide
 * that the request did nothing — the user (a stale tab, a double-click) is told
 * the debt is already in an account, which is the true state.
 */
export class DebtAlreadyLinkedError extends Error {
  constructor() {
    super('This debt is already recorded in an account.')
    this.name = 'DebtAlreadyLinkedError'
  }
}

/**
 * Thrown when "Remove from account" (`unlinkDebtFromAccount`) is asked of a
 * debt whose opening is not recorded in one — a stale tab, a double-click, or
 * another unlink that committed first. The mirror of `DebtAlreadyLinkedError`:
 * the true state is reported rather than a "done" for a request that did
 * nothing.
 */
export class DebtNotLinkedError extends Error {
  constructor() {
    super('This debt is not recorded in an account.')
    this.name = 'DebtNotLinkedError'
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
 * and test already pins down — a foreign id is a P2025 — holds for the locking
 * path too, and for a payment that vanished between its pre-read and the lock.
 */
function prismaNotFound(model: 'Debt' | 'Debt payment', id: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. ${model} ${id} was not found for this user.`,
    { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
  )
}

/**
 * Takes an exclusive lock on one Debt row, tenant-scoped in the SQL itself.
 *
 * Must be called inside `prisma.$transaction`: the lock is held until that
 * transaction commits or rolls back, and taking it on the bare client would
 * release it immediately and prove nothing (`account-lock.ts` makes the same
 * point about accounts). Shared by every payment writer and `writeOffDebt` so
 * that "the same lock" is literally the same statement, which is what makes
 * their races resolve deterministically either way round.
 *
 * Exactly one debt row is ever locked here, so there is no ordering among debt
 * rows to get wrong; its place relative to accounts and transaction rows is
 * the lock order in the module comment.
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
  if (locked.length === 0) throw prismaNotFound('Debt', debtId)
}

/** Spec §4's mapping: the movement the account sees when the debt opens… */
const OPENING_TYPE = { RECEIVABLE: 'CASH_OUT', PAYABLE: 'CASH_IN' } as const
/** …and when a repayment is made against it — always the opposite direction. */
const PAYMENT_TYPE = { RECEIVABLE: 'CASH_IN', PAYABLE: 'CASH_OUT' } as const

/** The default note's label for each movement (`debts.linkedNote.*`). */
const OPENING_NOTE = { RECEIVABLE: 'lend', PAYABLE: 'borrow' } as const
const PAYMENT_NOTE = { RECEIVABLE: 'collect', PAYABLE: 'repay' } as const

const LINKED_NOTE_MESSAGES = {
  vi: { debts: viDebtMessages },
  en: { debts: enDebtMessages },
} as const

/**
 * A linked transaction's note when the user gave none: "Cho mượn – An",
 * "Repaid by An", … in the user's locale, rendered once here and stored.
 *
 * `createTranslator` is the same engine `getTranslations` runs, minus the
 * request scope this service does not have; `person` is substituted as a
 * value, never parsed as ICU syntax, so a name with braces or quotes is safe.
 */
function linkedNote(
  locale: Locale,
  kind: 'lend' | 'borrow' | 'collect' | 'repay',
  person: string,
): string {
  const t = createTranslator({ locale, messages: LINKED_NOTE_MESSAGES[locale] })
  return t(`debts.linkedNote.${kind}`, { person })
}

/** A calendar date (`yyyy-MM-dd`) as a linked transaction's instant: the
 *  current instant for today in the user's zone (so it counts at once), else
 *  12:00 in that zone (so it never crosses a day boundary). */
function linkedInstant(calendarDate: string, timezone: string): Date {
  return calendarDateToEntryInstant(calendarDate, timezone)
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
 *
 * Money-source linking widened it: the debt carries `openingTransactionId`
 * and each payment its `transactionId` (null when nothing was recorded in an
 * account), and both bring the *account* of their linked transaction — the
 * account a payment form pre-selects (spec §6.2) and an edit form starts from.
 * Only the account's id, name and status (`LINKED_ACCOUNT`): the rest of the
 * transaction is the Transactions page's to show, and the name and status let an
 * edit form keep an account archived since the payment shown rather than
 * silently offering "don't record" in its place.
 */
const LINKED_ACCOUNT = {
  accountId: true,
  account: { select: { name: true, status: true } },
} satisfies Prisma.TransactionSelect

export type DebtRow = Prisma.DebtGetPayload<{
  include: {
    payments: { include: { transaction: { select: typeof LINKED_ACCOUNT } } }
    openingTransaction: { select: typeof LINKED_ACCOUNT }
  }
}>

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
 *  debt without its payments or with them in a different order — or without
 *  the linked accounts `DebtRow` promises.
 *
 *  Reads only. The writes return the plain `Debt` row they committed, as the
 *  loan writes do (final review F6): loading the payments and their accounts
 *  inside a write's own transaction costs extra statements while its locks
 *  are held, and no caller reads them — the actions ignore the result and the
 *  page reads through `listDebts` / `getDebtsWithOutstanding`. */
const WITH_PAYMENTS = {
  payments: {
    orderBy: PAYMENT_ORDER,
    include: { transaction: { select: LINKED_ACCOUNT } },
  },
  openingTransaction: { select: LINKED_ACCOUNT },
} satisfies Prisma.DebtInclude

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
 * Records a new debt — with an account, together with the money that moved.
 *
 * Fields are listed explicitly rather than spread, so the authenticated
 * `userId` can never be overridden regardless of Zod's stripping behaviour and
 * a client-supplied `status` is ignored rather than obeyed — a new debt is
 * ACTIVE, and only `writeOffDebt` changes that.
 *
 * Without `accountId` ("don't record in an account") this is the single
 * insert it always was: no FX lookup, no transaction, the currency the user
 * chose. With one, the debt and its opening transaction (spec §4: CASH_OUT for
 * a RECEIVABLE, CASH_IN for a PAYABLE, `originalAmount`, dated (see `linkedInstant`) on
 * `movedOn` in the user's zone) commit together or not at all, and the debt
 * takes the account's currency — the form's currency choice only applies when
 * no account is involved. The transaction's note is the user's notes when
 * given, else the localized "Cho mượn – {person}" / "Mượn – {person}" label.
 *
 * Only the account is locked (by `insertTransactionInTx`): the debt row is
 * being created inside this transaction, so no one else can see it, let alone
 * lock it, before it commits.
 *
 * Returns the committed `Debt` row as written — its relations are the read
 * path's to load (see `WITH_PAYMENTS`).
 */
export async function createDebt(
  userId: string,
  input: CreateDebtInput,
  context: DebtLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<Debt> {
  const parsed = createDebtSchema.parse(input)
  const data = {
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
    dueDate: dueDateCarrier(parsed.dueDate),
    notes: parsed.notes ?? null,
  }

  const { accountId, movedOn } = parsed
  if (accountId === undefined) {
    return prisma.debt.create({ data: { ...data, currency: parsed.currency } })
  }
  // `createDebtSchema` refuses an account without a money-moved date, so this
  // is a caller bug that skipped the parse, not a user error.
  if (movedOn === undefined) {
    throw new RangeError('createDebt: movedOn is required when accountId is set')
  }

  // Before the transaction opens: never a provider call under a row lock, and
  // an outage leaves no debt behind rather than one without its transaction.
  const fx = await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)

  return prisma.$transaction(async (tx) => {
    const opening = await insertTransactionInTx(
      tx,
      userId,
      {
        accountId,
        type: OPENING_TYPE[parsed.direction],
        amount: data.originalAmount,
        date: linkedInstant(movedOn, context.timezone),
        note:
          parsed.notes ?? linkedNote(context.locale, OPENING_NOTE[parsed.direction], parsed.person),
      },
      fx,
    )
    return tx.debt.create({
      // `opening.currency` was copied from the locked account row, so the
      // debt and its opening transaction cannot disagree about the currency.
      data: { ...data, currency: opening.currency, openingTransactionId: opening.id },
    })
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
 *
 * Returns the updated `Debt` row as written (see `WITH_PAYMENTS`).
 */
export async function updateDebt(
  userId: string,
  debtId: string,
  input: UpdateDebtInput,
): Promise<Debt> {
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
  })
}

/**
 * Locks the debt (after any accounts — see the lock order), re-reads it through
 * the typed client and refuses a written-off one.
 *
 * The raw SELECT in `lockDebtRow` is only the lock — `$queryRaw` gives no
 * guarantee about how a DECIMAL column arrives in JS, and money must never
 * travel through a float — so the row every decision is made on comes from
 * Prisma's typed client. Under the lock, so a write-off that committed first is
 * visible here and no payment can be recorded, edited or removed on an
 * already-closed debt.
 */
async function lockActiveDebt(
  tx: Prisma.TransactionClient,
  userId: string,
  debtId: string,
): Promise<Debt> {
  await lockDebtRow(tx, userId, debtId)
  const debt = await tx.debt.findUniqueOrThrow({ where: { userId_id: { userId, id: debtId } } })
  if (debt.status !== 'ACTIVE') throw new DebtNotActiveError()
  return debt
}

/**
 * What is still owed on a locked debt, leaving out `exceptPaymentId` — the
 * payment being edited, which must not count against its own new amount.
 *
 * Summed under the debt lock: this is the authoritative figure, not the one a
 * caller may have read a moment ago.
 */
async function outstandingUnderLock(
  tx: Prisma.TransactionClient,
  userId: string,
  debt: Debt,
  exceptPaymentId?: string,
): Promise<Prisma.Decimal> {
  const paid =
    (
      await tx.debtPayment.aggregate({
        where: {
          userId,
          debtId: debt.id,
          ...(exceptPaymentId === undefined ? {} : { id: { not: exceptPaymentId } }),
        },
        _sum: { amount: true },
      })
    )._sum.amount ?? new Prisma.Decimal(0)
  return deriveDebtOutstanding(debt.originalAmount, paid)
}

/**
 * Records a repayment against a debt — with an account, together with the
 * money that moved.
 *
 * The whole read-check-write happens inside one interactive transaction that
 * takes an exclusive row lock on the Debt row, for the reasons set out in the
 * module comment: without it two concurrent payments would both read the
 * same outstanding amount, both pass the check, and together take the debt past
 * settled.
 *
 * With `accountId`, the linked transaction (spec §4: CASH_IN when a RECEIVABLE
 * is repaid to the user, CASH_OUT when the user repays a PAYABLE) is written in
 * the same transaction, dated (see `linkedInstant`) on the payment day in the user's zone, with
 * the user's note or the localized "Thu nợ – {person}" / "Trả nợ – {person}"
 * label. The account is locked *before* the debt (the module's lock order) and
 * must hold the debt's currency. Every check — account, debt status,
 * over-payment — runs before anything is written, so a refusal leaves no orphan
 * transaction behind. Without an account it is the single `DebtPayment` insert
 * it always was, with no FX lookup.
 */
export async function recordDebtPayment(
  userId: string,
  debtId: string,
  input: RecordDebtPaymentInput,
  context: DebtLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<DebtPayment> {
  const parsed = recordDebtPaymentSchema.parse(input)
  const amount = new Prisma.Decimal(String(parsed.amount))
  const date = calendarDateToUtcCarrier(parsed.date)
  const { accountId } = parsed
  // FX only when money moves, and before the transaction opens.
  const fx =
    accountId === undefined ? null : await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)

  return prisma.$transaction(async (tx) => {
    // 1. The account first, so this path holds nothing while it queues behind
    //    another writer on the same account (P2025 for another user's,
    //    `ArchivedAccountError` for an archived one).
    const [account] =
      accountId === undefined ? [] : await lockAccountsForUpdate(tx, userId, [accountId])

    // 2. The debt: exclusive row lock, tenant-scoped (P2025 for an id that is
    //    not this user's), then the status check under it.
    const debt = await lockActiveDebt(tx, userId, debtId)

    // 3. `gt`, so a payment of exactly what is left is accepted — settling a
    //    debt is the most common last payment there is.
    const outstanding = await outstandingUnderLock(tx, userId, debt)
    if (amount.gt(outstanding)) throw new DebtOverpaymentError(outstanding)

    // 4. The money, when it moved through an account. The account lock is
    //    already ours, so its locked row goes to the core, which does not lock
    //    it again.
    const transaction =
      accountId !== undefined && account !== undefined && fx !== null
        ? await insertTransactionInTx(
            tx,
            userId,
            {
              accountId,
              type: PAYMENT_TYPE[debt.direction],
              amount,
              date: linkedInstant(parsed.date, context.timezone),
              note:
                parsed.note ??
                linkedNote(context.locale, PAYMENT_NOTE[debt.direction], debt.person),
              expectedCurrency: debt.currency,
            },
            fx,
            account,
          )
        : null

    return tx.debtPayment.create({
      data: {
        userId,
        debtId,
        amount,
        date,
        note: parsed.note ?? null,
        transactionId: transaction?.id ?? null,
      },
    })
  })
}

/**
 * Re-reads a payment under its debt's lock and confirms it is still linked the
 * way the pre-transaction copy said.
 *
 * Every payment writer holds the debt lock, so from here the payment row
 * cannot change — but it may already have changed between the pre-read and
 * the lock, and the accounts this request locked were chosen from that pre-read.
 * A payment that vanished is a P2025; one whose link changed (another edit
 * added or removed its account) is a `ConcurrentModificationError`, as
 * `updateTransaction` treats its own stale copy.
 */
async function verifyPaymentUnderLock(
  tx: Prisma.TransactionClient,
  userId: string,
  expected: DebtPayment,
): Promise<void> {
  const current = await tx.debtPayment.findUnique({
    where: { userId_id: { userId, id: expected.id } },
  })
  if (!current) throw prismaNotFound('Debt payment', expected.id)
  if (current.transactionId !== expected.transactionId) throw new ConcurrentModificationError()
}

/**
 * Corrects a recorded payment — its amount, its date, its note, and which
 * account (if any) the money moved through — keeping the linked transaction in
 * step (spec §6.2).
 *
 * The rules are the ones the other writers already follow:
 *
 * - **Over-payment** is measured against what is owed *without* this payment,
 *   so correcting 300,000 to 400,000 on a debt with 400,000 left before it is
 *   accepted; `DebtOverpaymentError.outstanding` is then what would have fit.
 * - **The linked transaction follows the payment.** Account → same or another
 *   account: the same transaction row is updated (amount, date per `linkedInstant`,
 *   note, account). Account → none: the link is cleared and the transaction
 *   deleted (in that order — the link is `ON DELETE RESTRICT`). None → account:
 *   a transaction is created, exactly as `recordDebtPayment` would. The new
 *   account must hold the debt's currency.
 * - **FX follows ruling R-6** (`updateTransaction`): a new snapshot is taken
 *   only when the transaction's economic content changes — a new transaction,
 *   another account, another amount, another instant — and fetched before the
 *   transaction opens; a note-only edit keeps the snapshot exactly and needs no
 *   rate at all.
 * - **Notes**: the user's note when given; without one, the default label the
 *   transaction was created with is kept (rendered once, never re-rendered in
 *   the current locale), and only a new transaction — or a payment whose own
 *   note was just cleared — gets the label rendered now.
 * - **Frozen history**: a payment of a written-off debt cannot be edited.
 *
 * Concurrency: the payment and its linked transaction are read once outside
 * the transaction (to choose the accounts to lock and to decide the FX
 * question), then accounts → debt → transaction row are locked in the module's
 * order and both rows re-verified against that copy.
 */
export async function updateDebtPayment(
  userId: string,
  paymentId: string,
  input: RecordDebtPaymentInput,
  context: DebtLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<DebtPayment> {
  const parsed = recordDebtPaymentSchema.parse(input)
  // The schema refuses zero, so `insertTransactionInTx`'s RangeError and the
  // amount CHECKs are unreachable from here.
  const amount = new Prisma.Decimal(String(parsed.amount))
  const date = calendarDateToUtcCarrier(parsed.date)
  const nextAccountId = parsed.accountId

  // Ownership-scoped and first: another user's payment id is a P2025 here,
  // before any FX call or lock is taken for it.
  const { transaction: linked, ...existing } = await prisma.debtPayment.findUniqueOrThrow({
    where: { userId_id: { userId, id: paymentId } },
    include: { transaction: true },
  })
  // An unchanged date keeps the instant the transaction already has. Without
  // this, a note-only edit of a payment made today would restamp it with the
  // current time, which reads as an economic change and needs a fresh FX rate.
  const instant =
    linked !== null &&
    instantToLocalDateTime(linked.date, context.timezone).slice(0, 10) === parsed.date
      ? linked.date
      : linkedInstant(parsed.date, context.timezone)

  const economicChange =
    nextAccountId !== undefined &&
    (linked === null ||
      linked.accountId !== nextAccountId ||
      // Compared as Decimal: 200000 and the stored "200000.00" are one amount.
      !amount.equals(linked.amount) ||
      instant.getTime() !== linked.date.getTime())
  const fx = economicChange ? await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride) : null

  return prisma.$transaction(async (tx) => {
    // 1. Accounts: the one the linked transaction leaves and the one it joins,
    //    in one sorted statement (`lockAccountsForUpdate` de-duplicates), so an
    //    archived account can neither lose nor gain the movement.
    const accountIds = [linked?.accountId, nextAccountId].filter(
      (id): id is string => id !== undefined,
    )
    const accounts = await lockAccountsForUpdate(tx, userId, accountIds)

    // 2. The debt, then the payment re-verified under its lock.
    const debt = await lockActiveDebt(tx, userId, existing.debtId)
    await verifyPaymentUnderLock(tx, userId, existing)

    // 3. The linked transaction row, last, against its pre-read copy: the
    //    Transactions page may have moved or edited it since.
    if (linked) await lockAndVerifyTransactionRow(tx, userId, linked.id, linked)

    const outstanding = await outstandingUnderLock(tx, userId, debt, paymentId)
    if (amount.gt(outstanding)) throw new DebtOverpaymentError(outstanding)

    // The user's note when given. Without one, a transaction whose payment had
    // no note either keeps the label it got when it was created — rendered
    // once, in the locale of that moment, never again in the editing session's
    // (as `updateLoanPayment` does) — and anything else (a new transaction, or
    // a payment whose own note was just cleared) gets the label rendered now.
    // The pre-read copies are safe here: an edit of this payment since then
    // also rewrote its linked transaction, which the row check above refuses.
    const note =
      parsed.note ??
      (existing.note === null && linked?.note != null
        ? linked.note
        : linkedNote(context.locale, PAYMENT_NOTE[debt.direction], debt.person))
    // The locked row of the account the money now moves through —
    // `lockAccountsForUpdate` resolved every id it was given or threw.
    const target = accounts.find((account) => account.id === nextAccountId)
    let transactionId: string | null = null
    if (nextAccountId !== undefined && linked === null) {
      // `economicChange` is true for a new link, so `fx` is set.
      if (fx === null) throw new RangeError('updateDebtPayment: a new link needs an FX snapshot')
      const created = await insertTransactionInTx(
        tx,
        userId,
        {
          accountId: nextAccountId,
          type: PAYMENT_TYPE[debt.direction],
          amount,
          date: instant,
          note,
          expectedCurrency: debt.currency,
        },
        fx,
        target,
      )
      transactionId = created.id
    } else if (nextAccountId !== undefined && linked !== null) {
      if (target?.currency !== debt.currency) throw new LinkedAccountCurrencyMismatchError()
      await tx.transaction.update({
        where: { userId_id: { userId, id: linked.id } },
        data: {
          accountId: nextAccountId,
          amount,
          currency: target.currency,
          date: instant,
          note,
          ...(fx
            ? {
                vndPerUsdAtEntry: fx.rateDecimal,
                fxRateFetchedAt: fx.fetchedAt,
                fxRateEffectiveAt: fx.effectiveDate,
                fxRateSource: fx.source,
              }
            : {}),
        },
      })
      transactionId = linked.id
    }

    const updated = await tx.debtPayment.update({
      where: { userId_id: { userId, id: paymentId } },
      data: { amount, date, note: parsed.note ?? null, transactionId },
    })
    // Account → none: only now that the payment no longer references it can
    // the transaction go (`ON DELETE RESTRICT`).
    if (nextAccountId === undefined && linked !== null) {
      await tx.transaction.delete({ where: { userId_id: { userId, id: linked.id } } })
    }
    return updated
  })
}

/**
 * Removes a recorded payment and, when it was recorded in an account, the
 * transaction that moved its money (spec §6.2) — both or neither.
 *
 * Same locks and re-verification as `updateDebtPayment` (the linked account,
 * then the debt, then the transaction row), so an archived account's frozen
 * history is respected exactly as `deleteTransaction` respects it, and a
 * payment of a written-off debt cannot be removed. The payment row goes first:
 * it references the transaction, and that link is `ON DELETE RESTRICT`.
 */
export async function deleteDebtPayment(userId: string, paymentId: string): Promise<void> {
  const { transaction: linked, ...existing } = await prisma.debtPayment.findUniqueOrThrow({
    where: { userId_id: { userId, id: paymentId } },
    include: { transaction: true },
  })

  await prisma.$transaction(async (tx) => {
    if (linked) await lockAccountsForUpdate(tx, userId, [linked.accountId])
    await lockActiveDebt(tx, userId, existing.debtId)
    await verifyPaymentUnderLock(tx, userId, existing)
    if (linked) await lockAndVerifyTransactionRow(tx, userId, linked.id, linked)

    await tx.debtPayment.delete({ where: { userId_id: { userId, id: paymentId } } })
    if (linked) await tx.transaction.delete({ where: { userId_id: { userId, id: linked.id } } })
  })
}

/**
 * Records that a debt will not be repaid (or has been forgiven).
 *
 * The row is kept, its payments are kept, and the outstanding amount is *not*
 * zeroed: what happened stays readable, and the page shows the debt as written
 * off from then on. Only its meaning changes — a written-off debt is excluded
 * from Net Worth and the dashboard's totals (Group 4 onwards) and can receive
 * no further payments or edits. No money moves either: nothing here touches a
 * transaction, and those its opening or its payments recorded in an account
 * stay exactly where they are (spec 2026-10-12 §4).
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
 *
 * Returns the `Debt` row as it stands under the lock (see `WITH_PAYMENTS`).
 */
export async function writeOffDebt(userId: string, debtId: string): Promise<Debt> {
  return prisma.$transaction(async (tx) => {
    await lockDebtRow(tx, userId, debtId)

    const debt = await tx.debt.findUniqueOrThrow({ where: { userId_id: { userId, id: debtId } } })
    if (debt.status === 'WRITTEN_OFF') return debt

    return tx.debt.update({
      where: { userId_id: { userId, id: debtId } },
      data: { status: 'WRITTEN_OFF' },
    })
  })
}

/**
 * "Record in an account" (spec 2026-10-12 §2 Q3, §6.4): a debt recorded without
 * an account — it predates the app, or "don't record" was chosen — gets the
 * transactions recording it with an account would have written, after the
 * fact, so the account's derived balance stops disagreeing with the agreement.
 * Nothing is ever linked automatically; this runs only when the user asks.
 *
 * What it writes, through the shared core and in one database transaction:
 *
 * - **the opening** (spec §4: CASH_OUT for a RECEIVABLE, CASH_IN for a
 *   PAYABLE, `originalAmount`), dated on `openedOn` in the user's zone
 *   (`calendarDateToEntryInstant`: now for today, else 12:00 that day), with the
 *   debt's notes or the "Cho mượn – {person}" / "Mượn – {person}" label;
 * - with `includePayments`, **one transaction per payment that has none yet**
 *   (CASH_IN when a RECEIVABLE was repaid, CASH_OUT when a PAYABLE was), each
 *   dated on its own payment day, with its own note or the "Thu nợ – {person}" /
 *   "Trả nợ – {person}" label. A payment already recorded in an account keeps
 *   its transaction untouched — linking never moves money twice.
 *
 * Refusals, all before the first write: a debt already linked
 * (`DebtAlreadyLinkedError` — checked once before the FX lookup, so a stale
 * tab costs no rate request, and again under the lock, where a concurrent link
 * that committed first is visible), an account in another currency
 * (`LinkedAccountCurrencyMismatchError`), an archived account, another user's
 * debt or account (P2025), and no usable rate. Any later failure rolls the whole
 * operation back.
 *
 * A written-off debt can be linked too — writing it off records that the rest
 * will not come back, not that no money ever moved — so the debt row is locked
 * with `lockDebtRow` itself, without `lockActiveDebt`'s status check, and its
 * status is left as it is. Lock order is the module's: the account, then the
 * debt; the payments are read under the debt lock, which every payment writer
 * takes, so the set linked here is exactly the set that exists at commit.
 *
 * One FX snapshot, fetched before the transaction opens, is shared by every
 * transaction written: they are all entered now, whatever day they are dated.
 * The transaction's timeout is sized for the number of payments to record
 * (`linkTransactionOptions`), since one link may write dozens of rows. Returns
 * the committed `Debt` row as written (see `WITH_PAYMENTS`).
 */
export async function linkDebtToAccount(
  userId: string,
  debtId: string,
  input: LinkDebtToAccountInput,
  context: DebtLinkContext,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<Debt> {
  const parsed = linkDebtToAccountSchema.parse(input)
  const { accountId } = parsed

  // Ownership-scoped and first: another user's debt id is a P2025 here, and a
  // debt that is already linked is refused, before any FX call or lock. The
  // count of payments still to record sizes the transaction below.
  const existing = await prisma.debt.findUniqueOrThrow({
    where: { userId_id: { userId, id: debtId } },
    select: {
      openingTransactionId: true,
      _count: { select: { payments: { where: { transactionId: null } } } },
    },
  })
  if (existing.openingTransactionId !== null) throw new DebtAlreadyLinkedError()
  // Sized for the payments to record: Prisma's 5 s default would expire on a long
  // history in production (`linkTransactionOptions`).
  const transactionOptions = linkTransactionOptions(
    parsed.includePayments ? existing._count.payments : 0,
  )

  // One "now" for the whole operation, so an opening and a payment both dated
  // today land on the same instant rather than a few milliseconds apart.
  const now = new Date()
  const instantOf = (calendarDate: string) =>
    calendarDateToEntryInstant(calendarDate, context.timezone, now)
  const openedAt = instantOf(parsed.openedOn)
  const fx = await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)

  return prisma.$transaction(async (tx) => {
    // 1. The account first (P2025 for another user's, `ArchivedAccountError`
    //    for an archived one), so nothing is held while it queues.
    const [account] = await lockAccountsForUpdate(tx, userId, [accountId])

    // 2. The debt, whatever its status, re-read under the lock.
    await lockDebtRow(tx, userId, debtId)
    const debt = await tx.debt.findUniqueOrThrow({ where: { userId_id: { userId, id: debtId } } })
    if (debt.openingTransactionId !== null) throw new DebtAlreadyLinkedError()
    if (account.currency !== debt.currency) throw new LinkedAccountCurrencyMismatchError()

    const linkedInput = (
      type: 'CASH_IN' | 'CASH_OUT',
      amount: Prisma.Decimal,
      date: Date,
      note: string,
    ) => ({ accountId, type, amount, date, note, expectedCurrency: debt.currency })

    // 3. The opening. `originalAmount` is > 0 (`Debt_originalAmount_positive`),
    //    so the core's zero-amount refusal is unreachable.
    const opening = await insertTransactionInTx(
      tx,
      userId,
      linkedInput(
        OPENING_TYPE[debt.direction],
        debt.originalAmount,
        openedAt,
        debt.notes ?? linkedNote(context.locale, OPENING_NOTE[debt.direction], debt.person),
      ),
      fx,
      account,
    )

    // 4. The payments with no transaction yet, oldest first, each on its own
    //    day (`DebtPayment_amount_positive`: never zero either).
    if (parsed.includePayments) {
      const unlinked = await tx.debtPayment.findMany({
        where: { userId, debtId, transactionId: null },
        orderBy: PAYMENT_ORDER,
      })
      for (const payment of unlinked) {
        const created = await insertTransactionInTx(
          tx,
          userId,
          linkedInput(
            PAYMENT_TYPE[debt.direction],
            payment.amount,
            instantOf(formatCalendarDate(payment.date)),
            payment.note ?? linkedNote(context.locale, PAYMENT_NOTE[debt.direction], debt.person),
          ),
          fx,
          account,
        )
        await tx.debtPayment.update({
          where: { userId_id: { userId, id: payment.id } },
          data: { transactionId: created.id },
        })
      }
    }

    return tx.debt.update({
      where: { userId_id: { userId, id: debtId } },
      data: { openingTransactionId: opening.id },
    })
  }, transactionOptions)
}

/**
 * "Bỏ ghi vào tài khoản / Remove from account" (final review F1): the undo of
 * recording a debt in an account — by "Record in an account", or by an account
 * chosen when the debt was created. Without it a wrong pick (the picker starts
 * on the most recently used account) would be permanent: the Transactions page
 * refuses to touch a linked row (Q4), and no other write here changes or
 * removes the opening.
 *
 * Deletes the opening transaction and clears `openingTransactionId`; with
 * `includePayments`, also every payment's transaction, whichever account it
 * moved through, clearing each payment's link. The debt and every payment stay
 * — what is owed is made of them, not of the transactions — and the debt can
 * then be recorded again (`linkDebtToAccount`) in the right account. The
 * balances of the accounts involved move back by exactly what those
 * transactions moved, because balances are derived from the rows that remain.
 *
 * Refusals, all before the first write: another user's debt (P2025), a debt
 * with no recorded opening (`DebtNotLinkedError` — read once before the
 * transaction and again under the lock, where a concurrent unlink that
 * committed first is visible), and an archived account among those the money
 * would leave (`ArchivedAccountError`, the rule `deleteDebtPayment` follows: an
 * archived account's balance is frozen, so none of its history is removed). A
 * written-off debt can be unlinked — writing it off did not decide which
 * account the money moved through — so the debt row is locked with
 * `lockDebtRow`, without `lockActiveDebt`'s status check, and its status stays.
 *
 * Concurrency, in the module's lock order:
 *
 * 1. Every account whose balance changes, in one sorted statement. Which ones
 *    is read before the transaction opens (the one statement below), because an
 *    account may not be locked after the debt.
 * 2. The debt row. Every payment writer and `linkDebtToAccount` take it, so
 *    from here the opening, the payments and their links cannot change: the
 *    rows to remove are read again under it, and those are what is removed.
 * 3. Those transaction rows, in one sorted statement
 *    (`lockTransactionRowsInAccounts`), each confirmed to sit in an account
 *    locked in step 1. One that does not — a payment recorded or moved into
 *    another account between the pre-read and the lock — is a
 *    `ConcurrentModificationError` and nothing is written. A payment edit or
 *    delete that read its payment as linked before this commits finds the link
 *    gone under the debt lock and is refused the same way
 *    (`verifyPaymentUnderLock`).
 *
 * The links are cleared before the transactions are deleted — they are
 * `ON DELETE RESTRICT` — and every write is one statement whatever the number
 * of payments, so the work does not grow with the history; the transaction is
 * still opened with the link's options (`linkTransactionOptions`), so a long
 * history gets the same allowance and the same wait for a connection.
 */
export async function unlinkDebtFromAccount(
  userId: string,
  debtId: string,
  input: UnlinkFromAccountInput,
): Promise<Debt> {
  const { includePayments } = unlinkFromAccountSchema.parse(input)

  // One statement before the transaction opens, scoped by `userId`: whether the
  // debt is this user's (no row at all: P2025), whether its opening is
  // recorded, and the account of every transaction this request removes — one
  // row per transaction, so the count beyond the opening sizes the transaction.
  const linkedRows = await prisma.$queryRaw<
    Array<{ openingTransactionId: string | null; accountId: string | null }>
  >`
    SELECT d."openingTransactionId", t."accountId"
      FROM "Debt" d
      LEFT JOIN "Transaction" t
        ON t."userId" = d."userId"
       AND (t."id" = d."openingTransactionId"${
         includePayments
           ? Prisma.sql`
            OR t."id" IN (SELECT p."transactionId" FROM "DebtPayment" p
                           WHERE p."userId" = d."userId" AND p."debtId" = d."id")`
           : Prisma.empty
       })
     WHERE d."userId" = ${userId} AND d."id" = ${debtId}`
  if (linkedRows.length === 0) throw prismaNotFound('Debt', debtId)
  if (linkedRows[0].openingTransactionId === null) throw new DebtNotLinkedError()
  const accountIds = [...new Set(linkedRows.flatMap((row) => row.accountId ?? []))]
  const transactionOptions = linkTransactionOptions(linkedRows.length - 1)

  return prisma.$transaction(async (tx) => {
    // 1. The accounts (`ArchivedAccountError` for an archived one).
    await lockAccountsForUpdate(tx, userId, accountIds)

    // 2. The debt, whatever its status, and what is linked to it — read under
    //    its lock.
    await lockDebtRow(tx, userId, debtId)
    const { openingTransactionId } = await tx.debt.findUniqueOrThrow({
      where: { userId_id: { userId, id: debtId } },
      select: { openingTransactionId: true },
    })
    if (openingTransactionId === null) throw new DebtNotLinkedError()
    const paymentTransactionIds = includePayments
      ? (
          await tx.debtPayment.findMany({
            where: { userId, debtId, transactionId: { not: null } },
            select: { transactionId: true },
          })
        ).flatMap((payment) => payment.transactionId ?? [])
      : []
    const transactionIds = [openingTransactionId, ...paymentTransactionIds]

    // 3. The rows themselves, each still in an account locked above.
    await lockTransactionRowsInAccounts(tx, userId, transactionIds, accountIds)

    // The links first (`ON DELETE RESTRICT`), then the transactions.
    if (paymentTransactionIds.length > 0) {
      await tx.debtPayment.updateMany({
        where: { userId, debtId, transactionId: { in: paymentTransactionIds } },
        data: { transactionId: null },
      })
    }
    const debt = await tx.debt.update({
      where: { userId_id: { userId, id: debtId } },
      data: { openingTransactionId: null },
    })
    await tx.transaction.deleteMany({ where: { userId, id: { in: transactionIds } } })
    return debt
  }, transactionOptions)
}
