import { prisma } from '@/lib/prisma'
import type { Currency, Prisma, Transaction, TransactionType } from '@prisma/client'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import { LOAN_INTEREST_CATEGORY_NAME } from '@/lib/server/defaults'
import { ArchivedAccountError, lockAccountsForUpdate, type LockedAccountRow } from './account-lock'

/**
 * The shared linking core (money-source linking spec §6.1).
 *
 * Every path that writes a Transaction row — the Transactions page through
 * `createTransaction`, and the debt, loan and reminder flows that record the
 * money movement behind their own row — inserts it through
 * `insertTransactionInTx`, so the invariants of `transaction.ts` (no fabricated
 * rate, currency follows the account, archived accounts are frozen, check and
 * write in one locked transaction) are enforced in exactly one place rather
 * than re-implemented, and slowly diverging, in each service.
 *
 * The core takes an already-open transaction client and an already-resolved FX
 * snapshot instead of opening either itself. A linked write is one step of a
 * larger atomic operation (a debt row and its opening transaction commit
 * together or not at all), so the caller owns the transaction; and the FX
 * lookup must happen *before* that transaction opens, never while a row lock
 * is held (see `account-lock.ts`), so the caller owns that too.
 *
 * Callers resolve the snapshot with `getUsableCurrentRate(SNAPSHOT_PAIR, …)`.
 */

/** The FX snapshot pair, fixed for every transaction: the account's own currency
 *  does not change which rate is recorded, only how it is later applied. */
export const SNAPSHOT_PAIR = { base: 'USD', quote: 'VND' } as const

export class InvalidCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid category: ${reason}`)
    this.name = 'InvalidCategoryError'
  }
}

/**
 * Thrown when a linked write targets an account whose currency is not the one
 * the source record is denominated in — a USD debt repaid "into" a VND wallet.
 *
 * A Transaction's `amount` carries no currency of its own (it takes the
 * account's), so writing the debt's number into that account would silently
 * re-label it as a different amount of money; and there is no honest
 * conversion to do, because the amount that actually moved in the other
 * currency is information only the user has. Cross-currency linking is out of
 * scope (spec §4), so the write is refused.
 *
 * Deliberately not `CurrencyMismatchError` from `transaction.ts`: that one
 * means "an edit tried to move a transaction across currencies", and the copy
 * it is mapped to tells the user to delete and re-enter the transaction —
 * advice that would be wrong for a debt or loan payment.
 */
export class LinkedAccountCurrencyMismatchError extends Error {
  constructor() {
    super('Choose an account in the same currency as this record.')
    this.name = 'LinkedAccountCurrencyMismatchError'
  }
}

const P_AND_L_TYPES = new Set<TransactionType>(['INCOME', 'EXPENSE'])

/**
 * Returns the categoryId to store (null for P&L-neutral types with no category
 * supplied).
 *
 * `keptCategoryId` is the categoryId the row already carries, passed only from
 * `updateTransaction`. Archiving a category must not freeze the transactions
 * filed under it: an edit that leaves the category exactly as it was skips the
 * ACTIVE check, so a note can still be corrected on an old expense. Everything
 * else still applies — moving a row to a *different* archived category is
 * refused, and the type-compatibility rule is checked either way, so an EXPENSE
 * row cannot become INCOME while keeping its (archived) EXPENSE category.
 */
export async function resolveCategoryId(
  db: Prisma.TransactionClient,
  userId: string,
  type: TransactionType,
  categoryId?: string,
  keptCategoryId?: string | null,
): Promise<string | null> {
  if (!categoryId) {
    if (P_AND_L_TYPES.has(type)) throw new InvalidCategoryError(`${type} requires a category`)
    return null
  }
  // `findUniqueOrThrow` on the composite `(userId, id)` key is what makes
  // another user's category a NotFound rather than a usable reference. Read
  // through the caller's transaction client so the check and the write that
  // depends on it are the same transaction.
  const category = await db.category.findUniqueOrThrow({
    where: { userId_id: { userId, id: categoryId } },
  })
  const isUnchanged = keptCategoryId !== undefined && categoryId === keptCategoryId
  if (!isUnchanged && category.status !== 'ACTIVE') {
    throw new InvalidCategoryError('category is archived')
  }
  if (P_AND_L_TYPES.has(type) && category.type !== type) {
    throw new InvalidCategoryError(
      `${type} requires a category of type ${type}, got ${category.type}`,
    )
  }
  return category.id
}

export interface LinkedTransactionInput {
  accountId: string
  type: TransactionType
  /** A magnitude, strictly positive: the direction comes from `type` alone. */
  amount: Prisma.Decimal
  /** The transaction's instant (a calendar date is pinned to 12:00 in the
   *  user's zone by the caller, so it never crosses a day boundary). */
  date: Date
  note: string | null
  /** Validated with the same rules as the Transactions page: required and
   *  type-matched for INCOME/EXPENSE, owned by the user, ACTIVE. */
  categoryId?: string | null
  /** The currency of the source record; when set, the account must hold it. */
  expectedCurrency?: Currency
}

/**
 * Locks the account, validates the write and inserts one Transaction carrying
 * `fx` as its snapshot. Must be called inside `prisma.$transaction`.
 *
 * Validation order is lock → currency → category → insert, and every check
 * reads through `tx`: the account lock is what makes the ACTIVE check binding
 * (a concurrent archive either commits first and turns this into an
 * `ArchivedAccountError`, or waits until this insert has committed), and
 * locking accounts before anything else keeps the global lock order — accounts
 * first, then source rows, then transaction rows — that lets new linked paths
 * run beside the old ones without deadlocking.
 *
 * Refusals: another user's (or a missing) account is Prisma's `P2025`, an
 * archived account `ArchivedAccountError`, a currency other than
 * `expectedCurrency` `LinkedAccountCurrencyMismatchError`, a bad category
 * `InvalidCategoryError` (or `P2025` for another user's), and a non-positive
 * amount — a caller bug, since every caller has validated its input already —
 * a `RangeError`.
 *
 * `lockedAccount` (final review F5) is for the callers that already hold the
 * account lock because the lock order makes them take it first — a debt or
 * loan payment, "Record in an account", a reminder's Paid. Re-locking a row the
 * transaction already holds returns at once in Postgres but still costs a
 * round trip (~100 ms in production), once per transaction written, so such a
 * caller hands in the row `lockAccountsForUpdate` returned and the core does
 * not lock again. Everything the lock would have checked is checked on that
 * row instead: it must be the input's account (another one is a caller bug, a
 * `RangeError`), ACTIVE, and in `expectedCurrency`. The row came from
 * `lockAccountsForUpdate(tx, userId, …)` on this same transaction, so it is the
 * user's and its lock is held until commit — the guarantees are unchanged.
 * `createTransaction` without a reminder passes nothing and keeps the core's
 * own lock.
 */
export async function insertTransactionInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  input: LinkedTransactionInput,
  fx: UsableRateResult,
  lockedAccount?: LockedAccountRow,
): Promise<Transaction> {
  // The column's CHECK only enforces >= 0; a zero-amount movement is a
  // meaningless row in the ledger, so it is refused before any lock is taken.
  if (!input.amount.greaterThan(0)) {
    throw new RangeError('insertTransactionInTx: amount must be greater than zero')
  }

  const account = lockedAccount ?? (await lockAccountsForUpdate(tx, userId, [input.accountId]))[0]
  if (account.id !== input.accountId) {
    throw new RangeError('insertTransactionInTx: the locked account is not the input account')
  }
  // `lockAccountsForUpdate` already refused an archived account; a row handed
  // in is held to the same rule here rather than trusted.
  if (account.status !== 'ACTIVE') throw new ArchivedAccountError()
  if (input.expectedCurrency !== undefined && account.currency !== input.expectedCurrency) {
    throw new LinkedAccountCurrencyMismatchError()
  }
  const categoryId = await resolveCategoryId(tx, userId, input.type, input.categoryId ?? undefined)

  return tx.transaction.create({
    data: {
      userId,
      accountId: input.accountId,
      categoryId,
      type: input.type,
      amount: input.amount,
      // Copied from the locked account row on every write, so no caller can
      // put a transaction in a currency its account does not hold.
      currency: account.currency,
      date: input.date,
      note: input.note,
      // `rateDecimal`, not `rate`: the snapshot is written straight from the
      // cache row's `Decimal(18, 6)`, so it never passes through a
      // JavaScript number on the cache-hit or fallback paths.
      vndPerUsdAtEntry: fx.rateDecimal,
      // Two distinct facts: when we retrieved the rate, and which UTC day
      // the rate is effective for. On the fallback path both are the
      // original cached row's own values, never "now".
      fxRateFetchedAt: fx.fetchedAt,
      fxRateEffectiveAt: fx.effectiveDate,
      fxRateSource: fx.source,
    },
  })
}

/**
 * The account a linked-money picker pre-selects (spec §4, "most recently used
 * account"): the account of the user's latest transaction by `createdAt` among
 * accounts that are still ACTIVE, else the first active account in the order
 * the pickers list them (`listActiveAccountPickerRows`), else null.
 *
 * `createdAt`, not `date`: "recently used" is when the user last chose the
 * account, not where a back-dated row sorts in the ledger. Transactions in an
 * account archived since are skipped rather than ending the search, because an
 * archived account can never be picked. No storage of its own — derived from
 * the ledger on every read.
 */
export async function getMostRecentlyUsedAccountId(userId: string): Promise<string | null> {
  const latest = await prisma.transaction.findFirst({
    where: { userId, account: { status: 'ACTIVE' } },
    select: { accountId: true },
    // `id` breaks a same-millisecond tie so the answer is deterministic.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (latest) return latest.accountId

  const firstActive = await prisma.financialAccount.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
    // Same order as `listActiveAccountPickerRows`, so the fallback is the
    // picker's first option.
    orderBy: { createdAt: 'asc' },
  })
  return firstActive?.id ?? null
}

/**
 * The id of the user's active EXPENSE category named
 * `LOAN_INTEREST_CATEGORY_NAME`, creating it when there is none.
 *
 * Every user normally has it already — new users through
 * `seedDefaultsForUser`, existing users through the `loan_interest_category`
 * data migration. This is the safety net for everyone else: a user registered
 * between that migration and the deploy of the seed change, or one who has
 * renamed, archived or deleted theirs. An archived one is not reused, because
 * a new transaction may not be filed under an archived category; a fresh
 * active one is created beside it instead.
 *
 * Runs through `tx` so the category and the interest transaction that needs it
 * commit together. Two concurrent first payments could each create one; that
 * race needs a user without the category *and* two simultaneous submissions,
 * and its worst case is a duplicate category name, not a money error, so no
 * lock is taken for it.
 */
export async function ensureLoanInterestCategoryId(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  const existing = await tx.category.findFirst({
    where: { userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE', status: 'ACTIVE' },
    select: { id: true },
    // Oldest first, so a user who also made their own same-named category
    // always gets the same one back.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (existing) return existing.id

  const created = await tx.category.create({
    data: { userId, name: LOAN_INTEREST_CATEGORY_NAME, type: 'EXPENSE', isDefault: true },
    select: { id: true },
  })
  return created.id
}

/**
 * The interactive-transaction options "Record in an account" (spec §6.4) opens
 * its one transaction with, sized for the payments it will record.
 *
 * Prisma's defaults — 5 s for the whole transaction, 2 s to get a pooled
 * connection — fit one write. A link writes the opening plus one transaction
 * per existing payment (two for a loan instalment with interest), all inside
 * one transaction, and production pays ~90–100 ms a round trip (Render
 * Singapore → Supabase Sydney): about ten round trips of fixed work, about
 * three per debt payment and about six per loan instalment (each leg locks the
 * account, checks its category and inserts; then the instalment is updated).
 * At the default, a loan with seven instalments or a debt with fourteen
 * payments would expire (P2028) — and long histories are exactly what this
 * feature exists for.
 *
 * - `timeout`: a 10 s base (ten times the fixed work) plus 1 s per payment
 *   (well over the ~0.6 s the costliest instalment takes), capped at 120 s so a
 *   link cannot hold its account and agreement locks open-endedly. The cap
 *   still covers ~110 payments at this allowance — a nine-year monthly loan —
 *   and roughly twice that at the real per-payment cost. A longer history
 *   would fail with nothing written (the actions map P2028 to `TIMEOUT`).
 * - `maxWait`: 10 s. The user is waiting on a one-off reconciliation; failing
 *   it after 2 s because the pool is momentarily busy would only make them
 *   start it again.
 *
 * `paymentCount` comes from a read before the transaction, so it can be a
 * payment or two short if some are recorded meanwhile; the allowance per
 * payment and the base absorb that.
 */
const LINK_TX_BASE_MS = 10_000
const LINK_TX_PER_PAYMENT_MS = 1_000
const LINK_TX_MAX_MS = 120_000
const LINK_TX_MAX_WAIT_MS = 10_000

export function linkTransactionOptions(paymentCount: number): {
  timeout: number
  maxWait: number
} {
  return {
    timeout: Math.min(LINK_TX_BASE_MS + paymentCount * LINK_TX_PER_PAYMENT_MS, LINK_TX_MAX_MS),
    maxWait: LINK_TX_MAX_WAIT_MS,
  }
}
