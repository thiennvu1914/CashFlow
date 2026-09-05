import { prisma } from '@/lib/prisma'
import {
  createFinancialAccountSchema,
  updateFinancialAccountSchema,
  type CreateFinancialAccountInput,
  type UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'
import type { Prisma } from '@prisma/client'

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
export async function accountHasActivity(userId: string, accountId: string): Promise<boolean> {
  const [transactionCount, transferCount] = await Promise.all([
    prisma.transaction.count({ where: { userId, accountId } }),
    prisma.transfer.count({
      where: { userId, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] },
    }),
  ])
  return transactionCount > 0 || transferCount > 0
}

async function assertActiveAccountType(userId: string, accountTypeId: string) {
  const accountType = await prisma.accountType.findUnique({
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

export async function updateFinancialAccount(
  userId: string,
  accountId: string,
  input: UpdateFinancialAccountInput,
) {
  const parsed = updateFinancialAccountSchema.parse(input)
  if (parsed.accountTypeId !== undefined) {
    await assertActiveAccountType(userId, parsed.accountTypeId)
  }

  // The lock is on the *attempt*, not on a difference in value: an update that
  // carries either field at all is refused once activity exists, so no caller
  // can rely on "it happened to be the same" and no balance is ever recomputed
  // against a changed foundation. The count query only runs when one of the two
  // locked fields is actually present.
  if (parsed.currency !== undefined || parsed.initialBalance !== undefined) {
    if (await accountHasActivity(userId, accountId)) throw new AccountLockedError()
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

  return prisma.financialAccount.update({
    where: { userId_id: { userId, id: accountId } },
    data,
  })
}
