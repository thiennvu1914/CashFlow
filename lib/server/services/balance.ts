import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { BALANCE_SIGN } from '@/lib/money/transaction-sign'

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
 * This is a genuinely complete implementation for what data can exist right
 * now: Transfer does not exist yet (Task 12), so there are no transfer terms
 * to include. Task 13 extends the formula to
 * `initialBalance + Σ sign(type) × amount + Σ transfers in − Σ transfers out`
 * without changing this function's signature.
 *
 * All arithmetic is done on `Prisma.Decimal` — `Number()` never touches a
 * value that feeds the calculation.
 */
export async function getAccountBalance(
  userId: string,
  accountId: string,
  asOfDate?: Date,
): Promise<Prisma.Decimal> {
  const balances = await getAccountBalances(userId, [accountId], asOfDate)
  // getAccountBalances throws AccountNotFoundError before returning if
  // `accountId` doesn't resolve, so this is always present here.
  return balances.get(accountId) as Prisma.Decimal
}

/**
 * Batched form of `getAccountBalance`: one `groupBy` over all requested
 * accounts' transactions plus one ownership-scoped `findMany` of the accounts
 * themselves, regardless of how many ids are requested — the Accounts page
 * uses this so rendering N accounts costs a constant two queries, not N.
 *
 * Every requested id must resolve to an account owned by `userId`; if any
 * does not, the whole call rejects with `AccountNotFoundError` and no map is
 * returned — never a partial result covering only the ids that resolved.
 */
export async function getAccountBalances(
  userId: string,
  accountIds: string[],
  asOfDate?: Date,
): Promise<Map<string, Prisma.Decimal>> {
  if (accountIds.length === 0) return new Map()

  const accounts = await prisma.financialAccount.findMany({
    where: { userId, id: { in: accountIds } },
  })
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  for (const id of accountIds) {
    if (!accountsById.has(id)) throw new AccountNotFoundError(id)
  }

  const dateFilter = asOfDate ? { date: { lte: asOfDate } } : {}
  const transactionSums = await prisma.transaction.groupBy({
    by: ['accountId', 'type'],
    where: { userId, accountId: { in: accountIds }, ...dateFilter },
    _sum: { amount: true },
  })

  const sumsByAccount = new Map<string, Prisma.Decimal>()
  for (const row of transactionSums) {
    const signed = (row._sum.amount ?? new Prisma.Decimal(0)).mul(BALANCE_SIGN[row.type])
    const running = sumsByAccount.get(row.accountId) ?? new Prisma.Decimal(0)
    sumsByAccount.set(row.accountId, running.add(signed))
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
    result.set(id, account.initialBalance.add(activity))
  }
  return result
}
