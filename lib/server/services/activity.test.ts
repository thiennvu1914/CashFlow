import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import type { Currency, TransactionType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  getActivitySummary,
  getCashFlowTrend,
  getExpenseByCategory,
  getMonthlyIncomeExpense,
} from './activity'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * The activity service is *historical*: every conversion comes from the rate a
 * transaction snapshotted at entry, never from the current-rate policy. A
 * throwing `fetch` spy in `beforeEach` proves that by construction — any live
 * lookup at all would fail the test that caused it — and one case additionally
 * seeds a different "today" rate to show the answers do not move. The USD/VND
 * `ExchangeRate` rows are global (not user-scoped), so `afterEach` clears them
 * along with the user's own rows.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

/** Every `source` string this file can write into the shared FX cache. */
const FAKE_SOURCES = ['seeded']

const HCMC = 'Asia/Ho_Chi_Minh'

describe('historical activity service', () => {
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  async function setup() {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `test-${randomUUID()}@example.com`,
        name: 'Test',
        emailVerified: false,
        timezone: HCMC,
      },
    })
    createdUserIds.push(user.id)
    const accountType = await prisma.accountType.create({
      data: { userId: user.id, name: 'Cash' },
    })
    const account = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'A Wallet',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      },
    })
    const secondAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'B Bank',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'VND',
      },
    })
    const usdAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'C Dollars',
        accountTypeId: accountType.id,
        initialBalance: 0,
        currency: 'USD',
      },
    })
    const foodCategory = await prisma.category.create({
      data: { userId: user.id, name: 'Food', type: 'EXPENSE' },
    })
    const transportCategory = await prisma.category.create({
      data: { userId: user.id, name: 'Transport', type: 'EXPENSE' },
    })
    const salaryCategory = await prisma.category.create({
      data: { userId: user.id, name: 'Salary', type: 'INCOME' },
    })
    return {
      userId: user.id,
      accountId: account.id,
      secondAccountId: secondAccount.id,
      usdAccountId: usdAccount.id,
      foodCategoryId: foodCategory.id,
      transportCategoryId: transportCategory.id,
      salaryCategoryId: salaryCategory.id,
    }
  }

  /** The UTC start of the day containing `date` — the `fxRateEffectiveAt` convention. */
  function utcDayStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  }

  /**
   * A transaction written straight to the database, snapshot fields and all.
   * The service under test is pure history, so the fixture supplies the FX
   * snapshot exactly as `createTransaction` would have stored it — a literal
   * rate, never one fetched at test time.
   */
  function makeTx(input: {
    userId: string
    accountId: string
    categoryId?: string | null
    type: TransactionType
    amount: string
    currency?: Currency
    date: Date
    vndPerUsdAtEntry?: string
  }) {
    return prisma.transaction.create({
      data: {
        userId: input.userId,
        accountId: input.accountId,
        categoryId: input.categoryId ?? null,
        type: input.type,
        amount: new Prisma.Decimal(input.amount),
        currency: input.currency ?? 'VND',
        date: input.date,
        vndPerUsdAtEntry: new Prisma.Decimal(input.vndPerUsdAtEntry ?? '25000'),
        fxRateFetchedAt: new Date(),
        fxRateEffectiveAt: utcDayStart(input.date),
        fxRateSource: 'fixture',
      },
    })
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
  })

  afterEach(async () => {
    const fetchCalls = fetchSpy.mock.calls.length
    vi.restoreAllMocks()
    const userIds = createdUserIds.splice(0)
    try {
      await prisma.exchangeRate.deleteMany({ where: { source: { in: FAKE_SOURCES } } })
      await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
      if (userIds.length > 0) {
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.category.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    // Asserted after cleanup so a network leak fails the run without also
    // leaving rows behind for the next test.
    expect(fetchCalls).toBe(0)
  })

  describe('getMonthlyIncomeExpense', () => {
    it('sums INCOME/EXPENSE for the given month, excluding CASH_IN/CASH_OUT/ADJUSTMENT', async () => {
      const s = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.salaryCategoryId,
        type: 'INCOME',
        amount: '10000000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '2000000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        type: 'CASH_IN',
        amount: '5000000',
        date: inMonth,
      })

      const result = await getMonthlyIncomeExpense(s.userId, HCMC, 'VND', inMonth)

      expect(result.income.toString()).toBe('10000000')
      expect(result.expense.toString()).toBe('2000000')
      expect(result.netIncome.toString()).toBe('8000000')
      expect(result.startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
      expect(result.endUtc.toISOString()).toBe('2026-03-31T17:00:00.000Z')
    })

    it('excludes every non-activity movement: CASH_IN/OUT, both ADJUSTMENTs and transfers', async () => {
      const s = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      const excluded: TransactionType[] = [
        'CASH_IN',
        'CASH_OUT',
        'ADJUSTMENT_INCREASE',
        'ADJUSTMENT_DECREASE',
      ]
      for (const type of excluded) {
        await makeTx({
          userId: s.userId,
          accountId: s.accountId,
          type,
          amount: '1000000',
          date: inMonth,
        })
      }
      // A transfer is its own entity and never income or expense (spec §4.5).
      await prisma.transfer.create({
        data: {
          userId: s.userId,
          fromAccountId: s.accountId,
          toAccountId: s.secondAccountId,
          fromAmount: new Prisma.Decimal('3000000'),
          toAmount: new Prisma.Decimal('3000000'),
          date: inMonth,
        },
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '7000',
        date: inMonth,
      })

      const result = await getMonthlyIncomeExpense(s.userId, HCMC, 'VND', inMonth)

      expect(result.income.toString()).toBe('0')
      expect(result.expense.toString()).toBe('7000')
      expect(result.netIncome.toString()).toBe('-7000')
    })

    it("restates a foreign-currency row at the rate it snapshotted, not today's", async () => {
      const s = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.usdAccountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '100',
        currency: 'USD',
        date: inMonth,
        vndPerUsdAtEntry: '25000',
      })

      const before = await getMonthlyIncomeExpense(s.userId, HCMC, 'VND', inMonth)
      expect(before.expense.toString()).toBe('2500000')

      // Today's rate moves. A report about March must not move with it —
      // that is the whole point of the per-transaction snapshot (spec §6.4).
      const today = new Date()
      await prisma.exchangeRate.create({
        data: {
          base: PAIR.base,
          quote: PAIR.quote,
          rate: new Prisma.Decimal('30000'),
          effectiveDate: utcDayStart(today),
          fetchedAt: today,
          source: 'seeded',
        },
      })

      const after = await getMonthlyIncomeExpense(s.userId, HCMC, 'VND', inMonth)
      expect(after.expense.toString()).toBe('2500000')
    })

    it('restates a VND row in USD using the same snapshot', async () => {
      const s = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.salaryCategoryId,
        type: 'INCOME',
        amount: '2500000',
        date: inMonth,
        vndPerUsdAtEntry: '25000',
      })

      const result = await getMonthlyIncomeExpense(s.userId, HCMC, 'USD', inMonth)

      expect(result.income.toString()).toBe('100')
    })

    it('groups by the local month, not the UTC month', async () => {
      const s = await setup()
      // 23:30 on 31 March in Ho Chi Minh City (UTC+7) — still March locally.
      const lastMomentOfMarch = new Date('2026-03-31T16:30:00Z')
      // 00:30 on 1 April locally, though still 31 March in UTC.
      const firstMomentOfApril = new Date('2026-03-31T17:30:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '111',
        date: lastMomentOfMarch,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '222',
        date: firstMomentOfApril,
      })

      const march = await getMonthlyIncomeExpense(
        s.userId,
        HCMC,
        'VND',
        new Date('2026-03-15T00:00:00Z'),
      )
      const april = await getMonthlyIncomeExpense(
        s.userId,
        HCMC,
        'VND',
        new Date('2026-04-15T00:00:00Z'),
      )

      expect(march.expense.toString()).toBe('111')
      expect(april.expense.toString()).toBe('222')
    })

    it("never counts another user's activity", async () => {
      const mine = await setup()
      const theirs = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: theirs.userId,
        accountId: theirs.accountId,
        categoryId: theirs.salaryCategoryId,
        type: 'INCOME',
        amount: '9000000',
        date: inMonth,
      })

      const result = await getMonthlyIncomeExpense(mine.userId, HCMC, 'VND', inMonth)

      expect(result.income.toString()).toBe('0')
      expect(result.expense.toString()).toBe('0')
    })
  })

  describe('getExpenseByCategory', () => {
    it('breaks down expenses by category name for the given month', async () => {
      const s = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '1500000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '500000',
        date: inMonth,
      })

      const result = await getExpenseByCategory(s.userId, HCMC, 'VND', inMonth)

      expect(result).toHaveLength(1)
      expect(result[0].categoryId).toBe(s.foodCategoryId)
      expect(result[0].name).toBe('Food')
      expect(result[0].total.toString()).toBe('2000000')
    })

    it('orders categories by total descending and labels an uncategorised row', async () => {
      const s = await setup()
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '300000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.transportCategoryId,
        type: 'EXPENSE',
        amount: '900000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: null,
        type: 'EXPENSE',
        amount: '600000',
        date: inMonth,
      })
      // Income never appears in an expense breakdown.
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.salaryCategoryId,
        type: 'INCOME',
        amount: '50000000',
        date: inMonth,
      })

      const result = await getExpenseByCategory(s.userId, HCMC, 'VND', inMonth)

      expect(result.map((r) => [r.name, r.total.toString()])).toEqual([
        ['Transport', '900000'],
        ['Uncategorized', '600000'],
        ['Food', '300000'],
      ])
      expect(result[1].categoryId).toBeNull()
    })
  })

  describe('getActivitySummary', () => {
    it('reports income, expense and net income per account, never an unsigned total', async () => {
      const s = await setup()
      const range = {
        startUtc: new Date('2026-02-28T17:00:00Z'),
        endUtc: new Date('2026-03-31T17:00:00Z'),
      }
      const inMonth = new Date('2026-03-15T10:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.salaryCategoryId,
        type: 'INCOME',
        amount: '5000000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '1000000',
        date: inMonth,
      })
      await makeTx({
        userId: s.userId,
        accountId: s.secondAccountId,
        categoryId: s.transportCategoryId,
        type: 'EXPENSE',
        amount: '400000',
        date: inMonth,
      })

      const summary = await getActivitySummary(s.userId, 'VND', range)

      expect(summary.startUtc).toBe(range.startUtc)
      expect(summary.endUtc).toBe(range.endUtc)
      expect(summary.income.toString()).toBe('5000000')
      expect(summary.expense.toString()).toBe('1400000')
      expect(summary.netIncome.toString()).toBe('3600000')
      expect(
        summary.byAccount.map((a) => [
          a.name,
          a.income.toString(),
          a.expense.toString(),
          a.netIncome.toString(),
        ]),
      ).toEqual([
        ['A Wallet', '5000000', '1000000', '4000000'],
        ['B Bank', '0', '400000', '-400000'],
      ])
      expect(summary.byAccount[0].accountId).toBe(s.accountId)
      // The export owns its own query (Task 7); the summary is aggregates only.
      expect('transactions' in summary).toBe(false)
    })

    it('answers zeros for a range with no activity', async () => {
      const s = await setup()

      const summary = await getActivitySummary(s.userId, 'VND', {
        startUtc: new Date('2026-01-01T00:00:00Z'),
        endUtc: new Date('2026-02-01T00:00:00Z'),
      })

      expect(summary.income.toString()).toBe('0')
      expect(summary.expense.toString()).toBe('0')
      expect(summary.netIncome.toString()).toBe('0')
      expect(summary.byCategory).toEqual([])
      expect(summary.byAccount).toEqual([])
    })

    it('treats endUtc as exclusive', async () => {
      const s = await setup()
      const boundary = new Date('2026-03-31T17:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '1000',
        date: boundary,
      })

      const summary = await getActivitySummary(s.userId, 'VND', {
        startUtc: new Date('2026-02-28T17:00:00Z'),
        endUtc: boundary,
      })

      expect(summary.expense.toString()).toBe('0')
    })
  })

  describe('getCashFlowTrend', () => {
    it('returns monthsBack local-month points oldest first, across a year boundary', async () => {
      const s = await setup()
      const now = new Date('2026-02-10T00:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '400000',
        date: new Date('2025-12-10T10:00:00Z'),
      })
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.salaryCategoryId,
        type: 'INCOME',
        amount: '1000000',
        date: new Date('2026-01-10T10:00:00Z'),
      })

      const trend = await getCashFlowTrend(s.userId, HCMC, 'VND', 6, now)

      expect(trend.map((p) => p.month)).toEqual([
        '2025-09',
        '2025-10',
        '2025-11',
        '2025-12',
        '2026-01',
        '2026-02',
      ])
      // The local month begins at 17:00Z on the last day of the previous month.
      expect(trend[0].startUtc.toISOString()).toBe('2025-08-31T17:00:00.000Z')
      expect(trend[5].endUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z')
      expect(
        trend.map((p) => [p.income.toString(), p.expense.toString(), p.netIncome.toString()]),
      ).toEqual([
        ['0', '0', '0'],
        ['0', '0', '0'],
        ['0', '0', '0'],
        ['0', '400000', '-400000'],
        ['1000000', '0', '1000000'],
        ['0', '0', '0'],
      ])
    })

    it('buckets by the local month even when UTC disagrees', async () => {
      const s = await setup()
      const now = new Date('2026-02-10T00:00:00Z')
      // 00:30 on 1 February locally, though 31 January in UTC.
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '777',
        date: new Date('2026-01-31T17:30:00Z'),
      })
      // 23:30 on 31 January locally, though still 31 January in UTC.
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '555',
        date: new Date('2026-01-31T16:30:00Z'),
      })

      const trend = await getCashFlowTrend(s.userId, HCMC, 'VND', 2, now)

      expect(trend.map((p) => [p.month, p.expense.toString()])).toEqual([
        ['2026-01', '555'],
        ['2026-02', '777'],
      ])
    })

    it('uses UTC month windows for a UTC user', async () => {
      const s = await setup()
      const now = new Date('2026-02-10T00:00:00Z')
      await makeTx({
        userId: s.userId,
        accountId: s.accountId,
        categoryId: s.foodCategoryId,
        type: 'EXPENSE',
        amount: '777',
        date: new Date('2026-01-31T17:30:00Z'),
      })

      const trend = await getCashFlowTrend(s.userId, 'UTC', 'VND', 2, now)

      expect(trend.map((p) => [p.month, p.expense.toString()])).toEqual([
        ['2026-01', '777'],
        ['2026-02', '0'],
      ])
      expect(trend[0].startUtc.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    })
  })
})
