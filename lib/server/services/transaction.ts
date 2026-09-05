import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import type { TransactionType } from '@prisma/client'
import { createTransactionSchema, type CreateTransactionInput } from '@/lib/validation/transaction'
import { getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'

/**
 * Transaction service (spec §4.4, §6.3).
 *
 * Three invariants live here and are never delegated to the UI:
 *
 * 1. **No fabricated rate.** Every FX snapshot comes from `getUsableCurrentRate`
 *    — never a constant, never 1, never `new Date()` in place of the provider's
 *    real fetch instant. The pair is always USD/VND regardless of the account's
 *    currency. If FX is unavailable the write fails; a money row is never
 *    stored against a rate we made up.
 * 2. **Currency follows the account.** `currency` is copied from the owning
 *    account on every write, so a request body can never disagree with it.
 * 3. **Archived accounts are frozen.** An archived account has a zero balance
 *    by construction (Task 15), so no row may be created in, edited in, moved
 *    into, moved out of, or deleted from one.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — there is no ambient user here.
 */

/** The FX snapshot pair, fixed for every transaction: the account's own currency
 *  does not change which rate is recorded, only how it is later applied. */
const SNAPSHOT_PAIR = { base: 'USD', quote: 'VND' } as const

export class ArchivedAccountError extends Error {
  constructor() {
    super('This account is archived and cannot receive new activity.')
    this.name = 'ArchivedAccountError'
  }
}

export class InvalidCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid category: ${reason}`)
    this.name = 'InvalidCategoryError'
  }
}

const P_AND_L_TYPES = new Set<TransactionType>(['INCOME', 'EXPENSE'])

/** Ownership-safe lookup that also enforces the ACTIVE invariant (exported so Task 12's
 *  transfer service can reuse it for both ends of a transfer). */
export async function requireActiveAccount(userId: string, accountId: string) {
  const account = await prisma.financialAccount.findUniqueOrThrow({
    where: { userId_id: { userId, id: accountId } },
  })
  if (account.status !== 'ACTIVE') throw new ArchivedAccountError()
  return account
}

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
async function resolveCategoryId(
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
  // another user's category a NotFound rather than a usable reference.
  const category = await prisma.category.findUniqueOrThrow({
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

/** How many rows the transactions list loads when no caller says otherwise. */
export const DEFAULT_TRANSACTION_LIST_LIMIT = 200

/** The most any caller may ask for. Phase 3 adds real paging; until then this
 *  is what keeps a long-lived ledger from being loaded whole into a page. */
export const MAX_TRANSACTION_LIST_LIMIT = 500

/**
 * The newest transactions for `userId`, bounded and projected.
 *
 * Two deliberate narrowings versus a plain `findMany`:
 *
 * 1. **Bounded.** An account that has been in use for a year has thousands of
 *    rows; without a limit the page fetches every one of them, serialises them
 *    all across the server/client boundary, and renders them. The limit is
 *    clamped to `MAX_TRANSACTION_LIST_LIMIT` rather than trusted, so no caller
 *    can opt out of the bound.
 * 2. **Projected.** Only the columns the list actually renders are selected.
 *    Everything a `include: { account: true }` would drag along — the joined
 *    account's `userId`, `initialBalance` and `currency`, the row's own
 *    `vndPerUsdAtEntry`/`fxRateTimestamp` — is data the UI never shows and
 *    should not be shipped to a client component.
 */
export async function listTransactions(userId: string, options?: { limit?: number }) {
  const requested = options?.limit ?? DEFAULT_TRANSACTION_LIST_LIMIT
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RangeError(`listTransactions: limit must be a positive integer, got ${requested}`)
  }
  const take = Math.min(requested, MAX_TRANSACTION_LIST_LIMIT)

  return prisma.transaction.findMany({
    where: { userId },
    select: {
      id: true,
      type: true,
      amount: true,
      currency: true,
      date: true,
      note: true,
      fxRateSource: true,
      account: { select: { name: true } },
      category: { select: { name: true } },
    },
    // `date` alone is not a total order — several transactions a day is the
    // normal case, and a paged or re-rendered list must not shuffle. `createdAt`
    // breaks the tie by entry order, and `id` breaks a same-millisecond tie so
    // the sort is fully deterministic.
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
}

export async function createTransaction(
  userId: string,
  input: CreateTransactionInput,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
) {
  const parsed = createTransactionSchema.parse(input)
  const account = await requireActiveAccount(userId, parsed.accountId)
  const categoryId = await resolveCategoryId(userId, parsed.type, parsed.categoryId)
  // Before the write, deliberately: an FxUnavailableError here leaves no row
  // behind, rather than a row with a missing or invented snapshot.
  const fx = await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)

  return prisma.transaction.create({
    data: {
      userId,
      accountId: parsed.accountId,
      categoryId,
      type: parsed.type,
      amount: parsed.amount,
      currency: account.currency,
      date: parsed.date,
      note: parsed.note ?? null,
      vndPerUsdAtEntry: fx.rate,
      fxRateTimestamp: fx.fetchedAt,
      fxRateSource: fx.source,
    },
  })
}

/**
 * Edits a transaction, re-snapshotting FX only when the economic content changed
 * (ruling R-6).
 *
 * The snapshot records the usable current rate at the moment the transaction's
 * economic content was last recorded — not the moment the row was first
 * inserted. So if any of `accountId`, `type`, `amount` or `date` differs from
 * the stored row, all three FX fields are written anew (and `currency` is
 * re-derived from the possibly-new account); if only `note` and/or `categoryId`
 * change, the existing snapshot is preserved exactly. As with create, the FX
 * call happens before the write: an economic edit while FX is unavailable fails
 * and leaves the row untouched, so a corrected amount is never paired with a
 * borrowed or fabricated rate.
 *
 * An edit that keeps the row's existing category is allowed even when that
 * category has since been archived — archiving hides a category from new
 * entries, it does not freeze the history already filed under it.
 */
export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: CreateTransactionInput,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
) {
  const parsed = createTransactionSchema.parse(input)
  const existing = await prisma.transaction.findUniqueOrThrow({
    where: { userId_id: { userId, id: transactionId } },
  })
  // Both ends are checked: an archived account may neither lose activity nor
  // gain it, so a row can be neither edited out of one nor moved into one.
  await requireActiveAccount(userId, existing.accountId)
  const account = await requireActiveAccount(userId, parsed.accountId)
  // The row's current category is passed so keeping it does not require it to
  // still be ACTIVE — see `resolveCategoryId`.
  const categoryId = await resolveCategoryId(
    userId,
    parsed.type,
    parsed.categoryId,
    existing.categoryId,
  )

  const economicChange =
    parsed.accountId !== existing.accountId ||
    parsed.type !== existing.type ||
    // Compared as Decimal, never as a float: 1000 and the stored "1000.00" are
    // the same amount, and `Number(existing.amount)` would be a lossy detour.
    !new Prisma.Decimal(parsed.amount).equals(existing.amount) ||
    parsed.date.getTime() !== existing.date.getTime()

  const fx = economicChange ? await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride) : null

  return prisma.transaction.update({
    where: { userId_id: { userId, id: transactionId } },
    data: {
      accountId: parsed.accountId,
      categoryId,
      type: parsed.type,
      amount: parsed.amount,
      currency: account.currency,
      date: parsed.date,
      note: parsed.note ?? null,
      ...(fx
        ? {
            vndPerUsdAtEntry: fx.rate,
            fxRateTimestamp: fx.fetchedAt,
            fxRateSource: fx.source,
          }
        : {}),
    },
  })
}

export async function deleteTransaction(userId: string, transactionId: string) {
  const existing = await prisma.transaction.findUniqueOrThrow({
    where: { userId_id: { userId, id: transactionId } },
  })
  // An archived account's balance is zero by construction; removing one of its
  // transactions would silently change history it can no longer show.
  await requireActiveAccount(userId, existing.accountId)
  await prisma.transaction.delete({ where: { userId_id: { userId, id: transactionId } } })
}
