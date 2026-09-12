import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBalanceTimeline } from './balance-timeline'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import type { TransactionType } from '@prisma/client'
import {
  getAccountBalance,
  getAccountBalances,
  getAccountBalancesForAccounts,
  AccountNotFoundError,
} from './balance'

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
        fxRateFetchedAt: new Date(),
        fxRateEffectiveAt: new Date(),
        fxRateSource: 'fixture',
      },
    })
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    if (userIds.length === 0) return
    try {
      await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
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

  describe('batched balance timeline', () => {
    it('matches cumulative numeric sums across buckets with mixed types and full-width money', async () => {
      const s = await setupUserAccount(0.01, 'VND', new Date('2026-01-01T00:00:00Z'))
      const dates = [new Date('2026-02-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z')]
      const types = [
        'INCOME',
        'EXPENSE',
        'CASH_IN',
        'CASH_OUT',
        'ADJUSTMENT_INCREASE',
        'ADJUSTMENT_DECREASE',
      ] as const
      await prisma.transaction.createMany({
        data: dates.flatMap((date) =>
          types.map((type) => ({
            userId: s.userId,
            accountId: s.accountId,
            type,
            amount: '9999999999999999.99',
            currency: 'VND',
            date,
            vndPerUsdAtEntry: 25000,
            fxRateFetchedAt: date,
            fxRateEffectiveAt: date,
            fxRateSource: 'fixture',
          })),
        ),
      })
      await makeTx(s.userId, s.accountId, 'INCOME', 0.02, dates[1])
      const accounts = await prisma.financialAccount.findMany({ where: { userId: s.userId } })
      const result = await getBalanceTimeline(s.userId, accounts, dates)
      for (let index = 0; index < dates.length; index++) {
        expect(result.balances[index]).toEqual(
          await getAccountBalancesForAccounts(s.userId, accounts, dates[index]),
        )
      }
      expect(result.balances[1].get(s.accountId)?.toString()).toBe('0.03')
    })

    it.each([
      'INCOME',
      'EXPENSE',
      'CASH_IN',
      'CASH_OUT',
      'ADJUSTMENT_INCREASE',
      'ADJUSTMENT_DECREASE',
    ] as const)(
      'matches the existing balance loader for %s at inclusive boundaries',
      async (type) => {
        const at = new Date('2026-05-01T00:00:00Z')
        const s = await setupUserAccount(0.1, 'VND', new Date('2026-01-01T00:00:00Z'))
        await makeTx(s.userId, s.accountId, type, 0.2, at)
        await makeTx(s.userId, s.accountId, type, 99, new Date(at.getTime() + 1))
        const accounts = await prisma.financialAccount.findMany({ where: { userId: s.userId } })
        const dates = [new Date('2025-12-31T00:00:00Z'), new Date(at.getTime() - 1), at]
        const timeline = await getBalanceTimeline(s.userId, accounts, dates)
        for (let index = 0; index < dates.length; index++) {
          const reference = await getAccountBalancesForAccounts(s.userId, accounts, dates[index])
          expect(timeline.balances[index]).toEqual(reference)
        }
        expect(timeline.hasFutureEntries).toBe(true)
        expect(timeline.accountsWithActivity).toEqual(new Set([s.accountId]))
      },
    )

    it('matches initial balances, archived history, both transfer directions and native cross-currency legs', async () => {
      const created = new Date('2026-01-01T00:00:00Z')
      const s = await setupUserAccount(1000000.12, 'VND', created)
      const accountType = await prisma.accountType.create({
        data: { userId: s.userId, name: 'Bank' },
      })
      const other = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          accountTypeId: accountType.id,
          name: 'Other',
          currency: 'VND',
          initialBalance: 0,
          createdAt: created,
        },
      })
      const usd = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          accountTypeId: accountType.id,
          name: 'USD',
          currency: 'USD',
          initialBalance: 0.1,
          createdAt: created,
        },
      })
      const dates = [
        new Date('2026-04-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
      ]
      await prisma.transfer.create({
        data: {
          userId: s.userId,
          fromAccountId: s.accountId,
          toAccountId: other.id,
          fromAmount: 100,
          toAmount: 100,
          date: dates[1],
        },
      })
      await prisma.transfer.create({
        data: {
          userId: s.userId,
          fromAccountId: s.accountId,
          toAccountId: usd.id,
          fromAmount: 250000,
          toAmount: 10,
          exchangeRateUsed: '0.00004',
          date: dates[2],
        },
      })
      await makeTx(s.userId, other.id, 'EXPENSE', 100, dates[2])
      await prisma.financialAccount.update({
        where: { id: other.id },
        data: { status: 'ARCHIVED' },
      })
      const accounts = await prisma.financialAccount.findMany({ where: { userId: s.userId } })
      const timeline = await getBalanceTimeline(s.userId, accounts, dates)
      for (let index = 0; index < dates.length; index++) {
        expect(timeline.balances[index]).toEqual(
          await getAccountBalancesForAccounts(s.userId, accounts, dates[index]),
        )
      }
      expect(
        timeline.balances[1].get(s.accountId)!.add(timeline.balances[1].get(other.id)!),
      ).toEqual(new Prisma.Decimal('1000000.12'))
      expect(timeline.balances[2].get(usd.id)?.toString()).toBe('10.1')
      expect(timeline.hasFutureEntries).toBe(false)
    })

    it('uses one SQL call for one or many accounts/cutoffs and refuses foreign rows before SQL', async () => {
      const owner = await setupUserAccount(100, 'VND', new Date('2026-01-01T00:00:00Z'))
      const intruder = await setupUserAccount(1)
      await makeTx(intruder.userId, intruder.accountId, 'INCOME', 999)
      const rows = await prisma.financialAccount.findMany({ where: { userId: owner.userId } })
      const type = await prisma.accountType.findFirstOrThrow({ where: { userId: owner.userId } })
      await prisma.financialAccount.createMany({
        data: Array.from({ length: 99 }, (_, i) => ({
          userId: owner.userId,
          accountTypeId: type.id,
          name: `Account ${i}`,
          initialBalance: 1,
          currency: 'VND',
          createdAt: rows[0].createdAt,
        })),
      })
      const many = await prisma.financialAccount.findMany({ where: { userId: owner.userId } })
      const query = vi.spyOn(prisma, '$queryRaw')
      const date = new Date('2026-09-01T00:00:00Z')
      const single = await getBalanceTimeline(owner.userId, rows, [date])
      expect(query).toHaveBeenCalledTimes(1)
      expect(single.balances[0].get(owner.accountId)?.toString()).toBe('100')
      query.mockClear()
      const multiple = await getBalanceTimeline(owner.userId, many, [
        new Date('2026-01-01T00:00:00Z'),
        date,
      ])
      expect(query).toHaveBeenCalledTimes(1)
      expect(multiple.balances[1].size).toBe(100)
      query.mockClear()
      await expect(getBalanceTimeline(intruder.userId, rows, [date])).rejects.toThrow(
        AccountNotFoundError,
      )
      expect(query).not.toHaveBeenCalled()
      // A valid user with an injected SQL-looking id cannot escape the bound
      // tenant predicate, even when given otherwise owned-looking input rows.
      const injected = `x' OR 1=1 --`
      const isolated = await getBalanceTimeline(
        injected,
        [{ ...rows[0], userId: injected, initialBalance: new Prisma.Decimal(0) }],
        [date],
      )
      expect(isolated.balances[0].get(rows[0].id)?.isZero()).toBe(true)
    })

    it('retains future/zero activity locks and skips SQL for empty inputs', async () => {
      const s = await setupUserAccount(20, 'VND', new Date('2026-01-01T00:00:00Z'))
      const now = new Date('2026-09-01T00:00:00Z')
      await makeTx(s.userId, s.accountId, 'INCOME', 0, new Date(now.getTime() + 1))
      const accounts = await prisma.financialAccount.findMany({ where: { userId: s.userId } })
      const timeline = await getBalanceTimeline(s.userId, accounts, [now])
      expect(timeline.balances[0].get(s.accountId)?.toString()).toBe('20')
      expect(timeline.accountsWithActivity.has(s.accountId)).toBe(true)
      expect(timeline.hasFutureEntries).toBe(true)
      const query = vi.spyOn(prisma, '$queryRaw')
      expect((await getBalanceTimeline(s.userId, [], [now])).balances).toEqual([new Map()])
      expect((await getBalanceTimeline(s.userId, accounts, [])).balances).toEqual([])
      await expect(getBalanceTimeline(s.userId, accounts, [now, now])).rejects.toThrow(/increasing/)
      expect(query).not.toHaveBeenCalled()
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

  /**
   * The pass-down entry point (Phase 8, Task 4 — pre-flight finding B-4).
   *
   * `getAccountBalanceOverTime` resolves the account set once and samples it at
   * six cutoffs, so it hands the rows in rather than making each sample re-read
   * them. Two things have to hold for that to be safe: the arithmetic must be
   * the *same* arithmetic (including the "did not exist yet" rule, which is the
   * only part that reads a row rather than an aggregate), and ownership must
   * still be enforced — a caller must not be able to widen what it can read by
   * handing over someone else's row.
   */
  describe('getAccountBalancesForAccounts', () => {
    it('returns exactly what the querying entry point returns, including the not-yet-created zero', async () => {
      const owner = await setupUserAccount(100, 'VND', new Date('2026-03-01T00:00:00Z'))
      const accountType = await prisma.accountType.create({
        data: { userId: owner.userId, name: 'Bank' },
      })
      const later = await prisma.financialAccount.create({
        data: {
          userId: owner.userId,
          name: 'Opened in June',
          accountTypeId: accountType.id,
          initialBalance: 50,
          currency: 'VND',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      })
      await makeTx(owner.userId, owner.accountId, 'INCOME', 25, new Date('2026-04-01T00:00:00Z'))
      const asOfDate = new Date('2026-05-01T00:00:00Z')
      const ids = [owner.accountId, later.id]

      const byId = await getAccountBalances(owner.userId, ids, asOfDate)
      const rows = await prisma.financialAccount.findMany({
        where: { userId: owner.userId, id: { in: ids } },
      })
      const byRow = await getAccountBalancesForAccounts(owner.userId, rows, asOfDate)

      expect([...byRow.entries()].map(([id, value]) => [id, value.toString()]).sort()).toEqual(
        [...byId.entries()].map(([id, value]) => [id, value.toString()]).sort(),
      )
      expect(byRow.get(owner.accountId)?.toString()).toBe('125')
      // Created after the cutoff, so zero rather than its opening balance —
      // the rule that needs the row itself and not an aggregate.
      expect(byRow.get(later.id)?.toString()).toBe('0')
    })

    it("refuses another user's row exactly as it refuses an unknown id", async () => {
      const owner = await setupUserAccount(100)
      const intruder = await setupUserAccount(0)
      const foreign = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId: owner.userId, id: owner.accountId } },
      })

      await expect(getAccountBalancesForAccounts(intruder.userId, [foreign])).rejects.toThrow(
        AccountNotFoundError,
      )
      // And nothing of the intruder's own comes back alongside it: the batch
      // fails whole, the same as the querying path.
      const own = await prisma.financialAccount.findUniqueOrThrow({
        where: { userId_id: { userId: intruder.userId, id: intruder.accountId } },
      })
      await expect(getAccountBalancesForAccounts(intruder.userId, [own, foreign])).rejects.toThrow(
        AccountNotFoundError,
      )
    })
  })

  describe('transfer terms (Task 13)', () => {
    it('applies transfers in and out without affecting income/expense', async () => {
      const setupA = await setupUserAccount(1000)
      const userId = setupA.userId
      const accountType = await prisma.accountType.create({ data: { userId, name: 'Bank' } })
      const accountB = await prisma.financialAccount.create({
        data: {
          userId,
          name: 'B',
          accountTypeId: accountType.id,
          initialBalance: 0,
          currency: 'VND',
        },
      })
      await prisma.transfer.create({
        data: {
          userId,
          fromAccountId: setupA.accountId,
          toAccountId: accountB.id,
          fromAmount: 300,
          toAmount: 300,
          date: new Date(),
        },
      })
      expect((await getAccountBalance(userId, setupA.accountId)).toNumber()).toBe(700)
      expect((await getAccountBalance(userId, accountB.id)).toNumber()).toBe(300)
    })

    it('matches the batched result for two accounts after a transfer, and conserves total money', async () => {
      const s = await setupUserAccount(1000) // account A, initialBalance 1000
      const accountType = await prisma.accountType.create({
        data: { userId: s.userId, name: 'Bank' },
      })
      const accountB = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'B',
          accountTypeId: accountType.id,
          initialBalance: 0,
          currency: 'VND',
        },
      })
      await prisma.transfer.create({
        data: {
          userId: s.userId,
          fromAccountId: s.accountId,
          toAccountId: accountB.id,
          fromAmount: 300,
          toAmount: 300,
          date: new Date(),
        },
      })

      const singleA = await getAccountBalance(s.userId, s.accountId)
      const singleB = await getAccountBalance(s.userId, accountB.id)
      const batched = await getAccountBalances(s.userId, [s.accountId, accountB.id])

      expect(batched.get(s.accountId)?.toNumber()).toBe(singleA.toNumber())
      expect(batched.get(accountB.id)?.toNumber()).toBe(singleB.toNumber())
      // 1000 (A) + 0 (B) before the transfer, and still 1000 total after: a
      // transfer moves money between the caller's own accounts, it never
      // creates or destroys it.
      const total = (batched.get(s.accountId) as Prisma.Decimal).add(
        batched.get(accountB.id) as Prisma.Decimal,
      )
      expect(total.toNumber()).toBe(1000)
    })

    it('excludes a transfer dated after asOfDate', async () => {
      const s = await setupUserAccount(1000, 'VND', new Date('2025-12-01T00:00:00Z'))
      const accountType = await prisma.accountType.create({
        data: { userId: s.userId, name: 'Bank' },
      })
      const accountB = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'B',
          accountTypeId: accountType.id,
          initialBalance: 0,
          currency: 'VND',
          createdAt: new Date('2025-12-01T00:00:00Z'),
        },
      })
      await prisma.transfer.create({
        data: {
          userId: s.userId,
          fromAccountId: s.accountId,
          toAccountId: accountB.id,
          fromAmount: 300,
          toAmount: 300,
          date: new Date('2026-06-01T00:00:00Z'),
        },
      })

      const asOfDate = new Date('2026-03-01T00:00:00Z')
      expect((await getAccountBalance(s.userId, s.accountId, asOfDate)).toNumber()).toBe(1000)
      expect((await getAccountBalance(s.userId, accountB.id, asOfDate)).toNumber()).toBe(0)
    })

    it('applies each leg of a cross-currency transfer to its own account only, with no FX conversion in the balance math', async () => {
      const s = await setupUserAccount(500_000, 'VND') // account A, VND
      const accountType = await prisma.accountType.create({
        data: { userId: s.userId, name: 'Bank' },
      })
      const accountB = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'B',
          accountTypeId: accountType.id,
          initialBalance: 0,
          currency: 'USD',
        },
      })
      await prisma.transfer.create({
        data: {
          userId: s.userId,
          fromAccountId: s.accountId,
          toAccountId: accountB.id,
          fromAmount: 250_000,
          toAmount: 10,
          exchangeRateUsed: 0.00004,
          date: new Date(),
        },
      })

      expect((await getAccountBalance(s.userId, s.accountId)).toNumber()).toBe(250_000)
      expect((await getAccountBalance(s.userId, accountB.id)).toNumber()).toBe(10)
    })

    it('is inclusive of asOfDate exactly at the account createdAt, and zero one millisecond before', async () => {
      const createdAt = new Date('2026-06-01T00:00:00.000Z')
      const s = await setupUserAccount(1000, 'VND', createdAt)

      const atCreation = await getAccountBalance(s.userId, s.accountId, createdAt)
      expect(atCreation.toNumber()).toBe(1000)

      const justBefore = await getAccountBalance(
        s.userId,
        s.accountId,
        new Date(createdAt.getTime() - 1),
      )
      expect(justBefore.toNumber()).toBe(0)
    })
  })
})
