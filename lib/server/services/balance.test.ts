import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import type { TransactionType } from '@prisma/client'
import { getAccountBalance, getAccountBalances, AccountNotFoundError } from './balance'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every user created here is deleted
 * again in `afterEach`, so repeated runs stay identical.
 */
describe('balance service', () => {
  const createdUserIds: string[] = []

  async function setupUserAccount(
    initialBalance: number,
    currency: 'VND' | 'USD' = 'VND',
    createdAt?: Date,
  ) {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `test-${randomUUID()}@example.com`,
        name: 'Test',
        emailVerified: false,
      },
    })
    createdUserIds.push(user.id)
    const accountType = await prisma.accountType.create({ data: { userId: user.id, name: 'Cash' } })
    const account = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'Test Account',
        accountTypeId: accountType.id,
        initialBalance,
        currency,
        ...(createdAt ? { createdAt } : {}),
      },
    })
    return { userId: user.id, accountId: account.id }
  }

  /**
   * Inserted directly via Prisma, bypassing the transaction service: this file
   * is only interested in balance math, and going through the real service
   * would drag the FX policy into a balance test. The `fx*` values here are
   * fixtures, not something the app produced.
   */
  function makeTx(
    userId: string,
    accountId: string,
    type: TransactionType,
    amount: number,
    date: Date = new Date(),
  ) {
    return prisma.transaction.create({
      data: {
        userId,
        accountId,
        type,
        amount,
        currency: 'VND',
        date,
        vndPerUsdAtEntry: 25000,
        fxRateTimestamp: new Date(),
        fxRateSource: 'fixture',
      },
    })
  }

  afterEach(async () => {
    const userIds = createdUserIds.splice(0)
    if (userIds.length === 0) return
    try {
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
  })

  describe('getAccountBalance', () => {
    it('starts at initialBalance with no activity', async () => {
      const s = await setupUserAccount(100000)
      expect((await getAccountBalance(s.userId, s.accountId)).toNumber()).toBe(100000)
    })

    it('applies the correct sign for every transaction type', async () => {
      const s = await setupUserAccount(0)
      await makeTx(s.userId, s.accountId, 'INCOME', 1000)
      await makeTx(s.userId, s.accountId, 'EXPENSE', 200)
      await makeTx(s.userId, s.accountId, 'CASH_IN', 500)
      await makeTx(s.userId, s.accountId, 'CASH_OUT', 100)
      await makeTx(s.userId, s.accountId, 'ADJUSTMENT_INCREASE', 50)
      await makeTx(s.userId, s.accountId, 'ADJUSTMENT_DECREASE', 30)
      // 0 + 1000 - 200 + 500 - 100 + 50 - 30 = 1220
      expect((await getAccountBalance(s.userId, s.accountId)).toNumber()).toBe(1220)
    })

    it('returns zero for any asOfDate before the account existed', async () => {
      const s = await setupUserAccount(5_000_000, 'VND', new Date('2026-06-01T00:00:00Z'))
      const before = await getAccountBalance(
        s.userId,
        s.accountId,
        new Date('2026-03-01T00:00:00Z'),
      )
      expect(before.toNumber()).toBe(0)
      const after = await getAccountBalance(s.userId, s.accountId, new Date('2026-07-01T00:00:00Z'))
      expect(after.toNumber()).toBe(5_000_000)
    })

    it('excludes a transaction dated after asOfDate', async () => {
      const s = await setupUserAccount(0, 'VND', new Date('2025-12-01T00:00:00Z'))
      await makeTx(s.userId, s.accountId, 'INCOME', 1000, new Date('2026-01-01T00:00:00Z'))
      await makeTx(s.userId, s.accountId, 'INCOME', 500, new Date('2026-06-01T00:00:00Z'))

      const asOf = await getAccountBalance(s.userId, s.accountId, new Date('2026-03-01T00:00:00Z'))
      expect(asOf.toNumber()).toBe(1000)
    })

    it('rejects a lookup for another user account', async () => {
      const owner = await setupUserAccount(100)
      const intruder = await setupUserAccount(0)
      await expect(getAccountBalance(intruder.userId, owner.accountId)).rejects.toThrow(
        AccountNotFoundError,
      )
    })

    it('uses exact Decimal arithmetic, not lossy float math', async () => {
      const s = await setupUserAccount(0.1)
      await makeTx(s.userId, s.accountId, 'INCOME', 0.2)
      const balance = await getAccountBalance(s.userId, s.accountId)
      expect(balance.toString()).toBe('0.3')
    })

    it('computes the same math regardless of account currency', async () => {
      const s = await setupUserAccount(0.1, 'USD')
      await makeTx(s.userId, s.accountId, 'INCOME', 0.2)
      const balance = await getAccountBalance(s.userId, s.accountId)
      expect(balance.toString()).toBe('0.3')
    })
  })

  describe('getAccountBalances', () => {
    it('matches single-account results for two accounts, and maps a later-created account to zero', async () => {
      const user = await prisma.user.create({
        data: {
          id: randomUUID(),
          email: `test-${randomUUID()}@example.com`,
          name: 'Test',
          emailVerified: false,
        },
      })
      createdUserIds.push(user.id)
      const accountType = await prisma.accountType.create({
        data: { userId: user.id, name: 'Cash' },
      })
      const account1 = await prisma.financialAccount.create({
        data: {
          userId: user.id,
          name: 'A1',
          accountTypeId: accountType.id,
          initialBalance: 100,
          currency: 'VND',
          createdAt: new Date('2026-03-01T00:00:00Z'),
        },
      })
      const asOfDate = new Date('2026-05-01T00:00:00Z')
      const account2 = await prisma.financialAccount.create({
        data: {
          userId: user.id,
          name: 'A2',
          accountTypeId: accountType.id,
          initialBalance: 50,
          currency: 'VND',
          createdAt: new Date('2026-06-01T00:00:00Z'), // created after asOfDate
        },
      })
      await makeTx(user.id, account1.id, 'INCOME', 25, new Date('2026-04-01T00:00:00Z'))

      const single1 = await getAccountBalance(user.id, account1.id, asOfDate)
      const single2 = await getAccountBalance(user.id, account2.id, asOfDate)

      const batched = await getAccountBalances(user.id, [account1.id, account2.id], asOfDate)

      expect(batched.get(account1.id)?.toNumber()).toBe(single1.toNumber())
      expect(batched.get(account1.id)?.toNumber()).toBe(125)
      expect(batched.get(account2.id)?.toNumber()).toBe(single2.toNumber())
      expect(batched.get(account2.id)?.toNumber()).toBe(0)
    })

    it('rejects when one of the ids belongs to another user, with no partial result', async () => {
      const owner = await setupUserAccount(100)
      const intruder = await setupUserAccount(0)
      const ownAccount = await prisma.financialAccount.create({
        data: {
          userId: intruder.userId,
          name: 'Mine',
          accountTypeId: (
            await prisma.accountType.create({ data: { userId: intruder.userId, name: 'Cash2' } })
          ).id,
          initialBalance: 0,
          currency: 'VND',
        },
      })

      await expect(
        getAccountBalances(intruder.userId, [ownAccount.id, owner.accountId]),
      ).rejects.toThrow(AccountNotFoundError)
    })
  })
})
