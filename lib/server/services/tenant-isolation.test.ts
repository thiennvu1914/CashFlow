import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { createTransaction, updateTransaction, deleteTransaction } from './transaction'
import { createTransfer } from './transfer'
import { getAccountBalance, getAccountBalances, AccountNotFoundError } from './balance'
import { updateFinancialAccount, archiveFinancialAccount } from './financial-account'

/**
 * Phase 2's security acceptance check (spec §4.12): a row can never reference
 * another user's data, and a service call scoped to one user can never read,
 * write, or partially affect another user's rows.
 *
 * The first `describe` bypasses every service and calls Prisma directly, to
 * prove the invariant is enforced by the database's own composite foreign
 * keys — not merely by application code that could regress. The second
 * `describe` goes through the real services, the paths actual server actions
 * use, and additionally asserts that a rejected call leaves zero rows behind
 * for either user (no partial writes, no cross-user leakage).
 *
 * Every FX-touching call injects a fake provider and `beforeEach` replaces
 * `fetch` with a throwing spy (same convention as `transaction.test.ts`), so
 * nothing here can reach the network.
 */

function isKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError
}

/**
 * Asserts a promise rejects with Prisma's own not-found error (P2025), thrown
 * by `findUniqueOrThrow` / `update` on a composite `(userId, id)` lookup that
 * does not match — the shape every cross-tenant service call below produces,
 * confirmed empirically against this codebase's actual services rather than
 * assumed from Prisma's docs.
 */
async function expectRejectsWithP2025(promise: Promise<unknown>) {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(isKnownRequestError(caught)).toBe(true)
  expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2025')
}

async function createUserWithAccount(currency: 'VND' | 'USD' = 'VND') {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `test-${randomUUID()}@example.com`,
      name: 'Test',
      emailVerified: false,
    },
  })
  const accountType = await prisma.accountType.create({
    data: { userId: user.id, name: 'Cash' },
  })
  const account = await prisma.financialAccount.create({
    data: {
      userId: user.id,
      name: 'A',
      accountTypeId: accountType.id,
      initialBalance: 0,
      currency,
    },
  })
  const expenseCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
  })
  const incomeCategory = await prisma.category.create({
    data: { userId: user.id, name: 'Salary', type: 'INCOME' },
  })
  return {
    userId: user.id,
    accountId: account.id,
    accountTypeId: accountType.id,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }
}

/** Deletes a user's rows in FK order, then the user itself. Safe to call even
 *  when some of the rows never existed (a rejected write left nothing behind). */
async function cleanup(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.transfer.deleteMany({ where: { userId } })
  await prisma.financialAccount.deleteMany({ where: { userId } })
  await prisma.accountType.deleteMany({ where: { userId } })
  await prisma.category.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
}

function fakeProvider(rate = 25000, source = 'fake'): ExchangeRateProvider {
  return {
    getLatestRate: async () => ({
      rate,
      effectiveDate: new Date(),
      fetchedAt: new Date(Date.now() - 5 * 60 * 1000),
      source,
    }),
    getHistoricalRate: async () => null,
  }
}

describe('tenant isolation at the database level', () => {
  it('rejects a Transaction whose accountId belongs to a different user, even bypassing the service layer', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      let caught: unknown
      try {
        await prisma.transaction.create({
          data: {
            userId: userA.userId,
            accountId: userB.accountId,
            type: 'INCOME',
            amount: 100000,
            currency: 'VND',
            date: new Date(),
            vndPerUsdAtEntry: 25000,
            fxRateFetchedAt: new Date(),
            fxRateEffectiveAt: new Date(),
            fxRateSource: 'test',
          },
        })
      } catch (error) {
        caught = error
      }
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it('rejects a Transfer whose toAccountId belongs to a different user', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      let caught: unknown
      try {
        await prisma.transfer.create({
          data: {
            userId: userA.userId,
            fromAccountId: userA.accountId,
            toAccountId: userB.accountId,
            fromAmount: 1000,
            toAmount: 1000,
            date: new Date(),
          },
        })
      } catch (error) {
        caught = error
      }
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it('rejects a Transaction whose categoryId belongs to a different user', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      let caught: unknown
      try {
        await prisma.transaction.create({
          data: {
            userId: userA.userId,
            accountId: userA.accountId,
            categoryId: userB.expenseCategoryId,
            type: 'EXPENSE',
            amount: 1000,
            currency: 'VND',
            date: new Date(),
            vndPerUsdAtEntry: 25000,
            fxRateFetchedAt: new Date(),
            fxRateEffectiveAt: new Date(),
            fxRateSource: 'test',
          },
        })
      } catch (error) {
        caught = error
      }
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it('rejects a FinancialAccount whose accountTypeId belongs to a different user', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      let caught: unknown
      try {
        await prisma.financialAccount.create({
          data: {
            userId: userA.userId,
            name: 'Should not exist',
            accountTypeId: userB.accountTypeId,
            initialBalance: 0,
            currency: 'VND',
          },
        })
      } catch (error) {
        caught = error
      }
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it('rejects a Transfer whose fromAccountId belongs to a different user', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      let caught: unknown
      try {
        await prisma.transfer.create({
          data: {
            userId: userA.userId,
            fromAccountId: userB.accountId,
            toAccountId: userA.accountId,
            fromAmount: 1000,
            toAmount: 1000,
            date: new Date(),
          },
        })
      } catch (error) {
        caught = error
      }
      expect(isKnownRequestError(caught)).toBe(true)
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2003')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })
})

describe('tenant isolation through the services', () => {
  let fetchSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    await prisma.exchangeRate.deleteMany({ where: { source: 'fake' } })
    await prisma.exchangeRate.deleteMany({ where: { base: 'USD', quote: 'VND' } })
    expect(fetchCalls).toBe(0)
  })

  it("createTransaction rejects another user's accountId and writes nothing for either user", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expectRejectsWithP2025(
        createTransaction(
          userA.userId,
          { accountId: userB.accountId, type: 'CASH_IN', amount: 100, date: new Date() },
          fakeProvider(),
        ),
      )

      expect(await prisma.transaction.count({ where: { userId: userA.userId } })).toBe(0)
      expect(await prisma.transaction.count({ where: { userId: userB.userId } })).toBe(0)
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("createTransaction rejects another user's categoryId and writes nothing for either user", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expectRejectsWithP2025(
        createTransaction(
          userA.userId,
          {
            accountId: userA.accountId,
            categoryId: userB.expenseCategoryId,
            type: 'EXPENSE',
            amount: 100,
            date: new Date(),
          },
          fakeProvider(),
        ),
      )

      expect(await prisma.transaction.count({ where: { userId: userA.userId } })).toBe(0)
      expect(await prisma.transaction.count({ where: { userId: userB.userId } })).toBe(0)
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("createTransfer rejects another user's toAccountId and writes nothing for either user", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expectRejectsWithP2025(
        createTransfer(userA.userId, {
          fromAccountId: userA.accountId,
          toAccountId: userB.accountId,
          fromAmount: 100,
          toAmount: 100,
          date: new Date(),
        }),
      )

      expect(await prisma.transfer.count({ where: { userId: userA.userId } })).toBe(0)
      expect(await prisma.transfer.count({ where: { userId: userB.userId } })).toBe(0)
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("getAccountBalance rejects another user's accountId with AccountNotFoundError", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expect(getAccountBalance(userA.userId, userB.accountId)).rejects.toThrow(
        AccountNotFoundError,
      )
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it('getAccountBalances rejects the whole batch when one id belongs to another user (no partial result)', async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expect(
        getAccountBalances(userA.userId, [userA.accountId, userB.accountId]),
      ).rejects.toThrow(AccountNotFoundError)
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("updateFinancialAccount rejects another user's accountId and leaves the row unchanged", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expectRejectsWithP2025(
        updateFinancialAccount(userA.userId, userB.accountId, { name: 'Hijacked' }),
      )

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId: userB.userId, id: userB.accountId } },
      })
      expect(stored.name).toBe('A')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("archiveFinancialAccount rejects another user's accountId and leaves it ACTIVE", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      await expect(archiveFinancialAccount(userA.userId, userB.accountId)).rejects.toThrow(
        AccountNotFoundError,
      )

      const stored = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId: userB.userId, id: userB.accountId } },
      })
      expect(stored.status).toBe('ACTIVE')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("deleteTransaction rejects another user's transactionId and the row still exists", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      const txOfUserB = await createTransaction(
        userB.userId,
        { accountId: userB.accountId, type: 'CASH_IN', amount: 500, date: new Date() },
        fakeProvider(),
      )

      await expectRejectsWithP2025(deleteTransaction(userA.userId, txOfUserB.id))

      expect(
        await prisma.transaction.count({
          where: { userId: userB.userId, id: txOfUserB.id },
        }),
      ).toBe(1)
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })

  it("updateTransaction rejects another user's transactionId and leaves the row unchanged", async () => {
    const userA = await createUserWithAccount()
    const userB = await createUserWithAccount()

    try {
      const txOfUserB = await createTransaction(
        userB.userId,
        { accountId: userB.accountId, type: 'CASH_IN', amount: 500, date: new Date() },
        fakeProvider(),
      )

      await expectRejectsWithP2025(
        updateTransaction(
          userA.userId,
          txOfUserB.id,
          { accountId: userB.accountId, type: 'CASH_IN', amount: 9999, date: new Date() },
          fakeProvider(25500, 'fake'),
        ),
      )

      const stored = await prisma.transaction.findUniqueOrThrow({
        where: { userId_id: { userId: userB.userId, id: txOfUserB.id } },
      })
      expect(stored.amount.toString()).toBe('500')
    } finally {
      await cleanup(userA.userId)
      await cleanup(userB.userId)
    }
  })
})
