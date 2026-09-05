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

  // No currency/initialBalance lock yet — Task 15 adds it once the
  // Transaction model exists and "has this account had activity" can be
  // checked for real instead of stubbed.
  return prisma.financialAccount.update({
    where: { userId_id: { userId, id: accountId } },
    data,
  })
}
