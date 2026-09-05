import { prisma } from '@/lib/prisma'
import {
  createFinancialAccountSchema,
  updateFinancialAccountSchema,
  type CreateFinancialAccountInput,
  type UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'
import type { Prisma } from '@prisma/client'
import { getAccountBalance, AccountNotFoundError } from './balance'
// `account-lock.ts` owns the locking read and the `ArchivedAccountError` it
// raises, and imports nothing from this module, so there is no cycle. One error
// type for "this account is archived" keeps the code the UI sees identical
// whether the frozen thing was a transaction, a transfer, or the account row.
import { lockAccountRows, lockAccountsForUpdate } from './account-lock'

/**
 * Thrown when a create/update targets an `accountTypeId` that either does not
 * belong to `userId` or is not ACTIVE. The composite `(userId, accountTypeId)`
 * foreign key also enforces ownership at the database level, but this check
 * runs first so the archived-type case (a valid FK, just the wrong status)
 * gets a clear error instead of surfacing as an opaque DB constraint failure.
 */
export class InvalidAccountTypeError extends Error {
  constructor() {
    super('Account type does not belong to the user or is not active')
    this.name = 'InvalidAccountTypeError'
  }
}

/**
 * Thrown when an update tries to change `currency` or `initialBalance` on an
 * account that already has activity. Both are inputs to every derived balance
 * this app computes, and there is no stored balance to correct afterwards:
 * changing either would silently rewrite the meaning of history the user has
 * already recorded. Name, description and account type stay editable.
 */
export class AccountLockedError extends Error {
  constructor() {
    super('Currency and opening balance cannot be changed once the account has activity.')
    this.name = 'AccountLockedError'
  }
}

/**
 * True once anything has been recorded against the account.
 *
 * Both kinds of activity count: a transaction filed against the account, and a
 * transfer touching it at *either* end. A transfer that only arrives is just as
 * much history as one that departs — re-basing the opening balance or the
 * currency underneath it would change the meaning of money that has already
 * moved.
 */
export async function accountHasActivity(
  userId: string,
  accountId: string,
  // `updateFinancialAccount` passes its own transaction client so the activity
  // check runs under the account's row lock rather than beside it.
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const [transactionCount, transferCount] = await Promise.all([
    db.transaction.count({ where: { userId, accountId } }),
    db.transfer.count({
      where: { userId, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] },
    }),
  ])
  return transactionCount > 0 || transferCount > 0
}

/**
 * Batched form of `accountHasActivity` for a page rendering many accounts at
 * once — one query over Transaction plus two over Transfer (one per leg),
 * rather than N round trips through `accountHasActivity`. Returns the subset
 * of `accountIds` that have any activity at all.
 */
export async function accountsWithActivity(
  userId: string,
  accountIds: string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set()

  const [transactions, transfersOut, transfersIn] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, accountId: { in: accountIds } },
      select: { accountId: true },
      distinct: ['accountId'],
    }),
    prisma.transfer.findMany({
      where: { userId, fromAccountId: { in: accountIds } },
      select: { fromAccountId: true },
      distinct: ['fromAccountId'],
    }),
    prisma.transfer.findMany({
      where: { userId, toAccountId: { in: accountIds } },
      select: { toAccountId: true },
      distinct: ['toAccountId'],
    }),
  ])

  const result = new Set<string>()
  for (const row of transactions) result.add(row.accountId)
  for (const row of transfersOut) result.add(row.fromAccountId)
  for (const row of transfersIn) result.add(row.toAccountId)
  return result
}

/**
 * Thrown by `archiveFinancialAccount` when the account's derived balance
 * (Task 13's `getAccountBalance`) is not exactly zero. An account frozen
 * mid-balance would either strand money with no owner-visible location or
 * silently vanish from every report — archiving is only ever a no-op on the
 * ledger, never a way to make a balance disappear.
 */
export class AccountHasNonZeroBalanceError extends Error {
  constructor() {
    super(
      'This account must have a zero balance before it can be archived. Transfer or adjust the balance first.',
    )
    this.name = 'AccountHasNonZeroBalanceError'
  }
}

/**
 * Archives a FinancialAccount once its derived balance is exactly zero (spec
 * §4.3). Idempotent: archiving an already-ARCHIVED account returns it
 * unchanged rather than re-deriving a balance that is frozen by construction
 * — the transaction/transfer services (Tasks 9/12) already refuse any new
 * activity against an archived account, so its balance cannot have moved
 * since it was archived.
 *
 * The ownership-scoped lookup happens first and on its own: another user's
 * account id must fail here as `AccountNotFoundError`, before any balance is
 * computed for it.
 *
 * **The balance check and the write are atomic.** The account row is locked
 * with `SELECT … FOR UPDATE` and the balance is then derived *through the same
 * transaction*, so a transaction or transfer being written to this account
 * either commits first — and the balance check sees it, refusing the archive —
 * or waits until the archive has committed and is then refused itself by
 * `lockAccountsForUpdate`. Neither order can produce an archived account
 * holding money. The `UPDATE` keeps its compare-and-set (`status: 'ACTIVE'` in
 * the `where`) as a second line: with the lock held it can no longer fail, and
 * if it ever did, a P2025 is what the action layer already maps to NOT_FOUND.
 * See `account-lock.ts` for the full locking design.
 */
export async function archiveFinancialAccount(userId: string, accountId: string) {
  return prisma.$transaction(async (tx) => {
    // `requireActive: false`: archiving an already-archived account is a no-op
    // for this function, not an `ArchivedAccountError`, so the status decision
    // is made here rather than by the lock helper.
    const [locked] = await lockAccountRows(tx, userId, [accountId], {
      requireActive: false,
      notFound: (id) => new AccountNotFoundError(id),
    })

    // Idempotent, and safe without re-deriving a balance: the transaction and
    // transfer services refuse every kind of new activity against an archived
    // account, so its balance cannot have moved since it was archived. The
    // locked row carries only the columns the lock needs, so the full row is
    // re-read (still inside the transaction) for the caller.
    if (locked.status === 'ARCHIVED') {
      return tx.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId, id: accountId } },
      })
    }

    const balance = await getAccountBalance(userId, accountId, undefined, tx)
    if (!balance.isZero()) throw new AccountHasNonZeroBalanceError()

    return tx.financialAccount.update({
      where: { userId_id: { userId, id: accountId }, status: 'ACTIVE' },
      data: { status: 'ARCHIVED' },
    })
  })
}

async function assertActiveAccountType(
  userId: string,
  accountTypeId: string,
  db: Prisma.TransactionClient = prisma,
) {
  const accountType = await db.accountType.findUnique({
    where: { userId_id: { userId, id: accountTypeId } },
  })
  if (!accountType || accountType.status !== 'ACTIVE') {
    throw new InvalidAccountTypeError()
  }
}

export async function listActiveFinancialAccounts(userId: string) {
  return prisma.financialAccount.findMany({
    where: { userId, status: 'ACTIVE' },
    include: { accountType: true },
    orderBy: { createdAt: 'asc' },
  })
}

export async function listAllFinancialAccounts(userId: string) {
  return prisma.financialAccount.findMany({
    where: { userId },
    include: { accountType: true },
    orderBy: { createdAt: 'asc' },
  })
}

export async function createFinancialAccount(userId: string, input: CreateFinancialAccountInput) {
  const parsed = createFinancialAccountSchema.parse(input)
  await assertActiveAccountType(userId, parsed.accountTypeId)
  // Fields are listed explicitly (not spread) so the authenticated `userId`
  // can never be overridden, regardless of Zod's stripping behaviour.
  return prisma.financialAccount.create({
    data: {
      userId,
      name: parsed.name,
      accountTypeId: parsed.accountTypeId,
      initialBalance: parsed.initialBalance,
      currency: parsed.currency,
      description: parsed.description,
    },
  })
}

/**
 * Edits an existing FinancialAccount.
 *
 * An ARCHIVED account is frozen outright — not merely locked on its money
 * fields. Archiving is only permitted at a zero balance, and the transaction
 * and transfer services refuse every kind of new activity against an archived
 * account; allowing `initialBalance` or `currency` to be edited afterwards
 * would put money back into an account the rest of the app has already
 * stopped tracking. The freeze covers `name` and `description` too: reopening
 * an account is not in Phase 2's scope, so there is no state in which an
 * archived row is meant to change at all.
 *
 * Atomic: the account row is locked before its status and activity are read,
 * and the write goes through the same transaction — so an archive or a first
 * transaction landing concurrently cannot slip between the checks and the
 * `UPDATE`.
 */
export async function updateFinancialAccount(
  userId: string,
  accountId: string,
  input: UpdateFinancialAccountInput,
) {
  const parsed = updateFinancialAccountSchema.parse(input)

  return prisma.$transaction(async (tx) => {
    // Ownership-scoped and first: another user's id is a P2025 here, before any
    // status or activity is read for it. The ACTIVE requirement is the lock
    // helper's own — an archived account is frozen outright.
    await lockAccountsForUpdate(tx, userId, [accountId])

    if (parsed.accountTypeId !== undefined) {
      await assertActiveAccountType(userId, parsed.accountTypeId, tx)
    }

    // The lock is on the *attempt*, not on a difference in value: an update
    // that carries either field at all is refused once activity exists, so no
    // caller can rely on "it happened to be the same" and no balance is ever
    // recomputed against a changed foundation. The count query only runs when
    // one of the two locked fields is actually present.
    if (parsed.currency !== undefined || parsed.initialBalance !== undefined) {
      if (await accountHasActivity(userId, accountId, tx)) throw new AccountLockedError()
    }

    // Rebuilt field-by-field (never `data: parsed`) so an undefined key is
    // omitted from the update rather than explicitly writing `undefined` over
    // an existing value — Zod's `.optional()` fields are absent-or-present, not
    // null-or-present, and Prisma treats an explicit `undefined` the same as
    // "don't touch this field", but rebuilding keeps the intent explicit here
    // rather than relying on that Prisma behaviour.
    const data: Prisma.FinancialAccountUncheckedUpdateInput = {}
    if (parsed.name !== undefined) data.name = parsed.name
    if (parsed.accountTypeId !== undefined) data.accountTypeId = parsed.accountTypeId
    if (parsed.initialBalance !== undefined) data.initialBalance = parsed.initialBalance
    if (parsed.currency !== undefined) data.currency = parsed.currency
    if (parsed.description !== undefined) data.description = parsed.description

    // Compare-and-set on the same `status: 'ACTIVE'` the lock above read: with
    // the row locked this can no longer fail, and if it ever did, Prisma raises
    // P2025 rather than editing a frozen row.
    return tx.financialAccount.update({
      where: { userId_id: { userId, id: accountId }, status: 'ACTIVE' },
      data,
    })
  })
}
