import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { BALANCE_SIGN } from '@/lib/money/transaction-sign'

/**
 * Either the global client or an interactive transaction's client. Both
 * functions below take one so a caller that has already locked the accounts
 * (`archiveFinancialAccount`) can derive the balance *inside* that transaction
 * — reading committed rows through the bare client would look past its own
 * locks and defeat the point of taking them.
 */
type BalanceDb = Prisma.TransactionClient | PrismaClient

/**
 * Thrown when a requested account id does not resolve to an ACTIVE-or-not,
 * owned-by-`userId` `FinancialAccount` — either it belongs to another user or
 * it does not exist. `getAccountBalances` throws this for the whole batch
 * (no partial result) the moment any one requested id fails to resolve, so a
 * caller can never receive balances for some accounts while silently missing
 * others.
 */
export class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Financial account ${accountId} was not found for this user`)
    this.name = 'AccountNotFoundError'
  }
}

/**
 * Derives an account's balance from its committed activity — never a stored
 * number.
 *
 * balance = initialBalance + Σ sign(type) × amount, over every Transaction
 * dated on or before `asOfDate` (or all of them, when `asOfDate` is omitted).
 * `sign(type)` comes from `BALANCE_SIGN` (`lib/money/transaction-sign.ts`), the
 * single source shared with the transaction list's `+`/`−` display — this
 * function never redefines it. An account whose `createdAt` is after
 * `asOfDate` did not exist yet at that point in time, so its balance as of
 * that date is zero, not its (not-yet-true) initialBalance.
 *
 * This is the phase's final, complete formula:
 * `initialBalance + Σ sign(type) × amount + Σ transfers in − Σ transfers out`.
 * A transfer never touches income/expense — its two legs are added and
 * subtracted directly, in each account's own currency, with no FX conversion
 * happening here.
 *
 * All arithmetic is done on `Prisma.Decimal` — `Number()` never touches a
 * value that feeds the calculation.
 */
export async function getAccountBalance(
  userId: string,
  accountId: string,
  asOfDate?: Date,
  db: BalanceDb = prisma,
): Promise<Prisma.Decimal> {
  const balances = await getAccountBalances(userId, [accountId], asOfDate, db)
  // getAccountBalances throws AccountNotFoundError before returning if
  // `accountId` doesn't resolve, so this is always present here.
  return balances.get(accountId) as Prisma.Decimal
}

/**
 * Batched form of `getAccountBalance` — the Accounts page uses this so
 * rendering N accounts costs a constant number of queries, not N.
 *
 * Every requested id must resolve to an account owned by `userId`; if any
 * does not, the whole call rejects with `AccountNotFoundError` and no map is
 * returned — never a partial result covering only the ids that resolved.
 *
 * Constant query count regardless of how many ids are requested: one
 * ownership `findMany`, one `groupBy` over Transaction, and two `groupBy`s
 * over Transfer (one per direction — `toAccountId`/`toAmount` for money
 * arriving, `fromAccountId`/`fromAmount` for money leaving). A transfer's two
 * legs are applied to their own account only, in that account's own
 * currency — there is no FX conversion in this function; `Transfer` already
 * carries whatever `exchangeRateUsed` was recorded for the audit trail, and
 * that never feeds this arithmetic.
 */
export async function getAccountBalances(
  userId: string,
  accountIds: string[],
  asOfDate?: Date,
  db: BalanceDb = prisma,
): Promise<Map<string, Prisma.Decimal>> {
  if (accountIds.length === 0) return new Map()

  const accounts = await db.financialAccount.findMany({
    where: { userId, id: { in: accountIds } },
  })
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  for (const id of accountIds) {
    if (!accountsById.has(id)) throw new AccountNotFoundError(id)
  }

  // Same `date <= asOfDate` cutoff as transactions: a transfer dated after
  // `asOfDate` did not happen yet as of that point in time.
  const dateFilter = asOfDate ? { date: { lte: asOfDate } } : {}
  const [transactionSums, transfersInSums, transfersOutSums] = await Promise.all([
    db.transaction.groupBy({
      by: ['accountId', 'type'],
      where: { userId, accountId: { in: accountIds }, ...dateFilter },
      _sum: { amount: true },
    }),
    db.transfer.groupBy({
      by: ['toAccountId'],
      where: { userId, toAccountId: { in: accountIds }, ...dateFilter },
      _sum: { toAmount: true },
    }),
    db.transfer.groupBy({
      by: ['fromAccountId'],
      where: { userId, fromAccountId: { in: accountIds }, ...dateFilter },
      _sum: { fromAmount: true },
    }),
  ])

  const sumsByAccount = new Map<string, Prisma.Decimal>()
  for (const row of transactionSums) {
    const signed = (row._sum.amount ?? new Prisma.Decimal(0)).mul(BALANCE_SIGN[row.type])
    const running = sumsByAccount.get(row.accountId) ?? new Prisma.Decimal(0)
    sumsByAccount.set(row.accountId, running.add(signed))
  }

  const transfersInByAccount = new Map<string, Prisma.Decimal>()
  for (const row of transfersInSums) {
    transfersInByAccount.set(row.toAccountId, row._sum.toAmount ?? new Prisma.Decimal(0))
  }
  const transfersOutByAccount = new Map<string, Prisma.Decimal>()
  for (const row of transfersOutSums) {
    transfersOutByAccount.set(row.fromAccountId, row._sum.fromAmount ?? new Prisma.Decimal(0))
  }

  const result = new Map<string, Prisma.Decimal>()
  for (const id of accountIds) {
    const account = accountsById.get(id)
    if (!account) throw new AccountNotFoundError(id) // unreachable, checked above
    if (asOfDate && asOfDate < account.createdAt) {
      result.set(id, new Prisma.Decimal(0))
      continue
    }
    const activity = sumsByAccount.get(id) ?? new Prisma.Decimal(0)
    const transfersIn = transfersInByAccount.get(id) ?? new Prisma.Decimal(0)
    const transfersOut = transfersOutByAccount.get(id) ?? new Prisma.Decimal(0)
    result.set(id, account.initialBalance.add(activity).add(transfersIn).sub(transfersOut))
  }
  return result
}

/**
 * **The one definition of a "current balance" in this app.**
 *
 *     current balance = derived balance as of the current instant
 *
 * Future-dated activity — next month's rent, a post-dated cheque, a transfer
 * booked for Monday — stays stored and stays visible in the transaction and
 * transfer lists, but it does not move a current balance until its timestamp is
 * reached. It is not money the user holds yet.
 *
 * Every surface that shows a user a "current balance" goes through this one
 * function so the figures cannot disagree with each other: the **Accounts
 * page**, the **dashboard's current position** (`getCurrentPosition`, and with
 * it the Total Account Balance card, the Net Worth card and the Account Balance
 * Distribution chart), and the **Excel export's** Accounts and Summary sheets.
 * The Account Balance Over Time chart samples its current point at `now` too,
 * so it lands on the same number.
 *
 * `now` is a parameter, not a call to the clock inside the loop: a page or route
 * that renders several figures from one request takes ONE `new Date()` and
 * threads it through, so no two figures on a page are computed against a clock
 * that ticked between two awaits.
 *
 * This is a thin, deliberate wrapper — `getAccountBalances(userId, ids, now)` —
 * and adds no arithmetic of its own. Use `getAccountBalances` directly only for
 * a genuinely *historical* as-of read (the balance-history chart) or for the
 * *booked* total, every entry included regardless of date, which is what
 * `archiveFinancialAccount` checks alongside this one.
 */
export async function getCurrentAccountBalances(
  userId: string,
  accountIds: string[],
  now: Date = new Date(),
  db: BalanceDb = prisma,
): Promise<Map<string, Prisma.Decimal>> {
  return getAccountBalances(userId, accountIds, now, db)
}

/** Single-account form of `getCurrentAccountBalances`; same semantic. */
export async function getCurrentAccountBalance(
  userId: string,
  accountId: string,
  now: Date = new Date(),
  db: BalanceDb = prisma,
): Promise<Prisma.Decimal> {
  const balances = await getCurrentAccountBalances(userId, [accountId], now, db)
  // `getCurrentAccountBalances` throws `AccountNotFoundError` before returning
  // if `accountId` doesn't resolve, so this is always present here.
  return balances.get(accountId) as Prisma.Decimal
}
