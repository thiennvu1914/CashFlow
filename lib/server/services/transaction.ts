import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import type { TransactionType } from '@prisma/client'
import { createTransactionSchema, type CreateTransactionInput } from '@/lib/validation/transaction'
import { getUsableCurrentRate } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { ArchivedAccountError, lockAccountsForUpdate } from './account-lock'

/**
 * Transaction service (spec §4.4, §6.3).
 *
 * Four invariants live here and are never delegated to the UI:
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
 * 4. **The check and the write are atomic.** Every mutation below opens one
 *    interactive transaction, takes `SELECT … FOR UPDATE` on every account it
 *    touches (`lockAccountsForUpdate`), and writes through that same
 *    transaction — so invariant 3 cannot be lost to a concurrent archive. The
 *    FX lookup deliberately happens *before* the transaction: see the design
 *    notes in `account-lock.ts`.
 *
 * `userId` always arrives as an argument (server actions pass
 * `requireUser().id`) and scopes every query — there is no ambient user here.
 */

/** The FX snapshot pair, fixed for every transaction: the account's own currency
 *  does not change which rate is recorded, only how it is later applied. */
const SNAPSHOT_PAIR = { base: 'USD', quote: 'VND' } as const

// `ArchivedAccountError` now lives with the locking code that raises it;
// re-exported here so every existing importer (the transfer service, the
// financial-account service, both action error maps) is unaffected.
export { ArchivedAccountError }

/**
 * Thrown when a transaction changed underneath a write between the read that
 * decided what to do and the locked write that would do it.
 *
 * Both mutating paths read the row *before* opening their transaction — they
 * have to, because the FX lookup must not happen while a row lock is held — and
 * both then act on what that copy said. `updateTransaction` derives
 * `economicChange`, and therefore whether the FX snapshot is replaced, from it;
 * `deleteTransaction` derives *which account to lock* from it. If the row moved
 * in between, the decision was made against data that no longer exists:
 * applying it would silently discard the other edit, or — worse for the delete
 * — would freeze-check the account the row has just left while removing money
 * from the one it has just joined. The honest answer is to refuse and let the
 * user reload; the action layer maps this to `CONFLICT`.
 */
export class ConcurrentModificationError extends Error {
  constructor() {
    super('This transaction changed after it was read.')
    this.name = 'ConcurrentModificationError'
  }
}

/** What both mutating paths must still be true about the row they read before
 *  opening their transaction. */
interface ExpectedTransactionRow {
  accountId: string
  updatedAt: Date
}

/**
 * Re-reads the transaction row under an exclusive lock and confirms it is still
 * the row the caller's pre-transaction copy described.
 *
 * Called *after* `lockAccountsForUpdate`, never before: accounts are locked
 * first and the transaction row second, everywhere, so two writers can never
 * take the same two locks in opposite orders and deadlock.
 *
 * `accountId` is the invariant-critical field — it decides which account's
 * freeze applies — and `updatedAt` catches every other concurrent edit.
 * `updatedAt` is Prisma's `@updatedAt` at millisecond precision, so two writes
 * inside the same millisecond compare equal; that is accepted, because the
 * account locks already make the write itself safe and this check exists to
 * protect the *decision*, not to be a cryptographic version tag.
 */
async function lockAndVerifyTransactionRow(
  tx: Prisma.TransactionClient,
  userId: string,
  transactionId: string,
  expected: ExpectedTransactionRow,
): Promise<void> {
  const [current] = await tx.$queryRaw<Array<{ accountId: string; updatedAt: Date }>>`
    SELECT "accountId", "updatedAt" FROM "Transaction"
    WHERE "userId" = ${userId} AND "id" = ${transactionId}
    FOR UPDATE`
  if (!current) {
    throw new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found.',
      { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
    )
  }
  if (
    current.accountId !== expected.accountId ||
    current.updatedAt.getTime() !== expected.updatedAt.getTime()
  ) {
    throw new ConcurrentModificationError()
  }
}

/**
 * Thrown when an edit tries to move a transaction to an account in a
 * different currency.
 *
 * `currency` follows the account, and `amount` is a bare magnitude with no
 * currency of its own — so silently re-deriving the currency on a move would
 * turn "1000 VND" into "1000 USD" and multiply the row's real value by about
 * twenty-five thousand. There is no honest conversion to do either: the
 * amount the user actually spent in the new currency is information only they
 * have. So the move is refused, and the correct path is to delete the row and
 * re-enter it against the new account.
 */
export class CurrencyMismatchError extends Error {
  constructor() {
    super('Move the transaction to an account in the same currency, or delete and re-enter it.')
    this.name = 'CurrencyMismatchError'
  }
}

export class InvalidCategoryError extends Error {
  constructor(reason: string) {
    super(`Invalid category: ${reason}`)
    this.name = 'InvalidCategoryError'
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
async function resolveCategoryId(
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
 *    `vndPerUsdAtEntry`/`fxRateFetchedAt`/`fxRateEffectiveAt` — is data the UI never shows and
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

/**
 * Every transaction an export or report needs — export/report data source;
 * unbounded by design; `listTransactions` is the bounded UI list.
 *
 * The two differ on purpose and must not be merged. A page renders a screenful
 * and is capped at `MAX_TRANSACTION_LIST_LIMIT` so a decade-old ledger cannot
 * be pulled into a React tree; a spreadsheet is the user's own complete data
 * and a cap there is not a safeguard but silent data loss — a workbook that
 * stops at row 200 looks exactly like a workbook of a user with 200
 * transactions. So there is deliberately no `take` here, and no option to add
 * one.
 *
 * The projection is wider than the UI list's for the same reason: an export
 * shows the FX snapshot (`vndPerUsdAtEntry` and the two timestamps that say
 * which day's rate it was and when it was fetched) so a converted column can be
 * reconciled against the rate that actually applied, and it carries the
 * account's own `currency` so a native amount can be formatted correctly.
 *
 * `range` is the same half-open `[startUtc, endUtc)` window every other query
 * in the app uses — `endUtc` is the first instant of the *next* period and is
 * therefore excluded. Omit it for the whole history.
 *
 * Ordered oldest first: a spreadsheet is read forwards through time. The
 * `createdAt`/`id` tie-breaks make that order total, so two exports of
 * unchanged data are byte-comparable.
 */
export async function listTransactionsForExport(
  userId: string,
  range?: { startUtc: Date; endUtc: Date },
) {
  return prisma.transaction.findMany({
    where: {
      userId,
      // `lt`, never `lte`: `endUtc` belongs to the next period.
      ...(range ? { date: { gte: range.startUtc, lt: range.endUtc } } : {}),
    },
    select: {
      id: true,
      date: true,
      type: true,
      amount: true,
      currency: true,
      note: true,
      vndPerUsdAtEntry: true,
      fxRateFetchedAt: true,
      fxRateEffectiveAt: true,
      fxRateSource: true,
      account: { select: { name: true, currency: true } },
      category: { select: { name: true } },
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

export async function createTransaction(
  userId: string,
  input: CreateTransactionInput,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
) {
  const parsed = createTransactionSchema.parse(input)
  // Before the transaction opens, deliberately, and for two reasons: an
  // FxUnavailableError here leaves no row behind rather than a row with a
  // missing or invented snapshot, and a provider HTTP call must never happen
  // while a row lock is held (see `account-lock.ts`).
  const fx = await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride)

  return prisma.$transaction(async (tx) => {
    // The lock is what makes the ACTIVE check binding: a concurrent archive
    // either commits before this and turns the check into an
    // `ArchivedAccountError`, or waits until this insert has committed.
    const [account] = await lockAccountsForUpdate(tx, userId, [parsed.accountId])
    const categoryId = await resolveCategoryId(tx, userId, parsed.type, parsed.categoryId)

    return tx.transaction.create({
      data: {
        userId,
        accountId: parsed.accountId,
        categoryId,
        type: parsed.type,
        amount: parsed.amount,
        currency: account.currency,
        date: parsed.date,
        note: parsed.note ?? null,
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
  })
}

/**
 * Edits a transaction, re-snapshotting FX only when the economic content changed
 * (ruling R-6).
 *
 * The snapshot records the usable current rate at the moment the transaction's
 * economic content was last recorded — not the moment the row was first
 * inserted. So if any of `accountId`, `type`, `amount` or `date` differs from
 * the stored row, all four FX fields are written anew (and `currency` is
 * re-derived from the possibly-new account); if only `note` and/or `categoryId`
 * change, the existing snapshot is preserved exactly. As with create, the FX
 * call happens before the write: an economic edit while FX is unavailable fails
 * and leaves the row untouched, so a corrected amount is never paired with a
 * borrowed or fabricated rate.
 *
 * An edit that keeps the row's existing category is allowed even when that
 * category has since been archived — archiving hides a category from new
 * entries, it does not freeze the history already filed under it.
 *
 * The one account change that is *not* allowed is a move across currencies:
 * see `CurrencyMismatchError`.
 *
 * Concurrency: the row is read once outside the transaction (to decide
 * `economicChange`, and so the FX call can happen with no lock held), then
 * re-read `FOR UPDATE` inside it alongside both accounts. A row whose
 * `updatedAt` moved in between is a `ConcurrentModificationError` — see the
 * design notes in `account-lock.ts`.
 */
export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: CreateTransactionInput,
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
) {
  const parsed = createTransactionSchema.parse(input)
  // Ownership-scoped and first: another user's transaction id is a P2025 here,
  // before any FX call or lock is taken for it.
  const existing = await prisma.transaction.findUniqueOrThrow({
    where: { userId_id: { userId, id: transactionId } },
  })

  const economicChange =
    parsed.accountId !== existing.accountId ||
    parsed.type !== existing.type ||
    // Compared as Decimal, never as a float: 1000 and the stored "1000.00" are
    // the same amount, and `Number(existing.amount)` would be a lossy detour.
    !new Prisma.Decimal(parsed.amount).equals(existing.amount) ||
    parsed.date.getTime() !== existing.date.getTime()

  const fx = economicChange ? await getUsableCurrentRate(SNAPSHOT_PAIR, providerOverride) : null

  return prisma.$transaction(async (tx) => {
    // Both ends are locked and checked: an archived account may neither lose
    // activity nor gain it, so a row can be neither edited out of one nor moved
    // into one. `lockAccountRows` sorts and de-duplicates, so passing the same
    // id twice (an edit that keeps the account) is one lock, not a self-wait.
    const accounts = await lockAccountsForUpdate(tx, userId, [existing.accountId, parsed.accountId])
    const account = accounts.find((row) => row.id === parsed.accountId)
    // Unreachable: `lockAccountsForUpdate` throws unless every requested id
    // resolved, and `parsed.accountId` is one of them.
    if (!account)
      throw new Prisma.PrismaClientKnownRequestError('Account not found', {
        code: 'P2025',
        clientVersion: Prisma.prismaVersion.client,
      })

    // The transaction row itself is locked and re-read: the accounts' locks say
    // nothing about this row, and `economicChange` above was computed from a
    // copy taken before the transaction opened.
    await lockAndVerifyTransactionRow(tx, userId, transactionId, existing)

    // `amount` carries no currency of its own, so moving a row to an account in
    // another currency would re-label the same number as a different amount of
    // money. Refused outright — see `CurrencyMismatchError`.
    if (account.currency !== existing.currency) throw new CurrencyMismatchError()
    // The row's current category is passed so keeping it does not require it to
    // still be ACTIVE — see `resolveCategoryId`.
    const categoryId = await resolveCategoryId(
      tx,
      userId,
      parsed.type,
      parsed.categoryId,
      existing.categoryId,
    )

    return tx.transaction.update({
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
              // Same rule as the create path: the row's own Decimal, not the
              // provider-boundary number.
              vndPerUsdAtEntry: fx.rateDecimal,
              fxRateFetchedAt: fx.fetchedAt,
              fxRateEffectiveAt: fx.effectiveDate,
              fxRateSource: fx.source,
            }
          : {}),
      },
    })
  })
}

/**
 * Removes a transaction.
 *
 * An archived account's balance is zero by construction; removing one of its
 * transactions would silently change history it can no longer show, so the
 * owning account must be ACTIVE and is locked while that is checked.
 *
 * The row is then re-verified under that lock. Which account to lock is read
 * from a copy taken *before* the transaction opened, and that copy can be
 * stale: if the row is moved to another account in between, locking the old
 * account proves nothing about the new one — the delete would check the freeze
 * on the account the row has just left while removing money from the one it has
 * just joined, which is precisely how a delete slips past an archived account.
 * A moved (or otherwise changed) row is a `ConcurrentModificationError`.
 */
export async function deleteTransaction(userId: string, transactionId: string) {
  const existing = await prisma.transaction.findUniqueOrThrow({
    where: { userId_id: { userId, id: transactionId } },
  })
  await prisma.$transaction(async (tx) => {
    // Accounts first, then the transaction row — the same order as
    // `updateTransaction`, so the two can never deadlock against each other.
    await lockAccountsForUpdate(tx, userId, [existing.accountId])
    await lockAndVerifyTransactionRow(tx, userId, transactionId, existing)
    await tx.transaction.delete({ where: { userId_id: { userId, id: transactionId } } })
  })
}
