import { Prisma } from '@prisma/client'
import type { TransactionType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { BALANCE_SIGN } from '@/lib/money/transaction-sign'
import { AccountNotFoundError, type OwnedAccount } from './balance'

interface MovementBucket {
  accountId: string
  kind: TransactionType | 'TRANSFER_IN' | 'TRANSFER_OUT'
  bucket: number
  amount: Prisma.Decimal
}

/** One request's balances at ascending, inclusive UTC cutoffs. No stored balance. */
export interface BalanceTimeline {
  balances: Map<string, Prisma.Decimal>[]
  /** Includes future activity: even a zero-value transaction locks an account. */
  accountsWithActivity: Set<string>
  hasFutureEntries: boolean
}

/**
 * One SQL command for any number of accounts and sample dates. PostgreSQL
 * groups each movement into the first cutoff that includes it; the last bucket
 * holds future entries. The returned payload is bounded by accounts × cutoffs
 * × transaction types, not by ledger length. Initial balances and type signs
 * are applied with the same Decimal operations as the single-cutoff loader.
 *
 * Prisma groupBy cannot group by these calculated cutoff buckets. A bound
 * CASE expression and UNION ALL batch the three existing ledger aggregates
 * without fetching every ledger row or issuing three queries per month.
 * Every branch has its own userId and account-id filters. Column/table names
 * are fixed SQL; user ids, account ids and UTC cutoffs are bound parameters.
 * SUM stays PostgreSQL numeric and is returned as Prisma.Decimal.
 */
export async function getBalanceTimeline(
  userId: string,
  accounts: OwnedAccount[],
  cutoffs: Date[],
): Promise<BalanceTimeline> {
  for (const account of accounts) {
    if (account.userId !== userId) throw new AccountNotFoundError(account.id)
  }
  for (let index = 0; index < cutoffs.length; index++) {
    if (
      !Number.isFinite(cutoffs[index].getTime()) ||
      (index > 0 && cutoffs[index] <= cutoffs[index - 1])
    ) {
      throw new Error('Balance cutoffs must be valid, strictly increasing instants')
    }
  }
  const result: BalanceTimeline = {
    balances: cutoffs.map(() => new Map()),
    accountsWithActivity: new Set(),
    hasFutureEntries: false,
  }
  if (accounts.length === 0 || cutoffs.length === 0) return result

  const ids = Prisma.join(accounts.map((account) => account.id))
  const bucket = Prisma.sql`CASE ${Prisma.join(
    cutoffs.map(
      (cutoff, index) => Prisma.sql`WHEN "date" <= ${cutoff}::timestamp THEN ${index}::int`,
    ),
    ' ',
  )} ELSE ${cutoffs.length}::int END`
  const rows = await prisma.$queryRaw<MovementBucket[]>(Prisma.sql`
    SELECT "accountId", "kind", "bucket",
      SUM("amount") OVER (
        PARTITION BY "accountId", "kind" ORDER BY "bucket"
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS "amount"
    FROM (
    SELECT "accountId", "type"::text AS "kind", ${bucket} AS "bucket", SUM("amount") AS "amount"
    FROM "Transaction"
    WHERE "userId" = ${userId} AND "accountId" IN (${ids})
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT "toAccountId" AS "accountId", 'TRANSFER_IN' AS "kind", ${bucket} AS "bucket", SUM("toAmount") AS "amount"
    FROM "Transfer"
    WHERE "userId" = ${userId} AND "toAccountId" IN (${ids})
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT "fromAccountId" AS "accountId", 'TRANSFER_OUT' AS "kind", ${bucket} AS "bucket", SUM("fromAmount") AS "amount"
    FROM "Transfer"
    WHERE "userId" = ${userId} AND "fromAccountId" IN (${ids})
    GROUP BY 1, 2, 3
    ) AS "movements"
  `)

  const buckets = cutoffs.map(() => [] as MovementBucket[])
  for (const row of rows) {
    result.accountsWithActivity.add(row.accountId)
    if (row.bucket === cutoffs.length) {
      result.hasFutureEntries = true
      continue
    }
    buckets[row.bucket].push(row)
  }
  // PostgreSQL accumulates each kind exactly as numeric before Decimal sees it.
  // Keep transfer legs separate to preserve the existing formula's operation
  // order: initial + signed transactions + incoming - outgoing.
  const running = new Map<string, Map<MovementBucket['kind'], Prisma.Decimal>>()
  for (let index = 0; index < cutoffs.length; index++) {
    for (const row of buckets[index]) {
      const kinds = running.get(row.accountId) ?? new Map()
      kinds.set(row.kind, row.amount)
      running.set(row.accountId, kinds)
    }
    for (const account of accounts) {
      const kinds = running.get(account.id)
      let activity = new Prisma.Decimal(0)
      for (const [kind, amount] of kinds ?? []) {
        if (kind !== 'TRANSFER_IN' && kind !== 'TRANSFER_OUT') {
          activity = activity.add(amount.mul(BALANCE_SIGN[kind]))
        }
      }
      result.balances[index].set(
        account.id,
        account.createdAt > cutoffs[index]
          ? new Prisma.Decimal(0)
          : account.initialBalance
              .add(activity)
              .add(kinds?.get('TRANSFER_IN') ?? new Prisma.Decimal(0))
              .sub(kinds?.get('TRANSFER_OUT') ?? new Prisma.Decimal(0)),
      )
    }
  }
  return result
}
