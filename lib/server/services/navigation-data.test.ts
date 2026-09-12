import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDashboardData } from './dashboard'
import { getAccountOverview } from './account-overview'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { getCalendarMonth } from '@/lib/datetime/calendar-month'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { getCurrentPosition } from './position'
import { getAccountBalanceOverTime } from './account-balance-history'
import { getActivitySummary, getCashFlowTrend } from './activity'
import { getBudgetProgressForMonth } from './budget'
import { listSavingsGoals } from './savings-goal'
import { listDashboardOccurrences, listUpcomingOccurrences, listReminders } from './reminder'
import { listCategories } from './category'
import { listTransactions } from './transaction'
import {
  listActiveFinancialAccounts,
  listAllFinancialAccounts,
  accountsWithActivity,
} from './financial-account'
import { listAccountTypes } from './account-type'
import { getAccountBalancesForAccounts } from './balance'

const now = new Date('2026-09-15T10:00:00Z')
const zone = 'Asia/Ho_Chi_Minh'
const userIds: string[] = []
const limits = { months: 6, transactions: 8, occurrences: { overdue: 2, upcoming: 5 } }
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('No network in navigation tests')
  })
})

async function fixture() {
  const userId = randomUUID()
  userIds.push(userId)
  await prisma.user.create({
    data: { id: userId, name: 'Fixture', email: `${userId}@example.com` },
  })
  const type = await prisma.accountType.create({ data: { userId, name: 'Fixture' } })
  const account = await prisma.financialAccount.create({
    data: {
      userId,
      name: 'Fixture',
      accountTypeId: type.id,
      currency: 'VND',
      initialBalance: 1000,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  })
  const category = await prisma.category.create({
    data: { userId, name: 'Fixture', type: 'EXPENSE' },
  })
  await prisma.transaction.create({
    data: {
      userId,
      accountId: account.id,
      categoryId: category.id,
      type: 'EXPENSE',
      amount: 100,
      currency: 'VND',
      date: now,
      vndPerUsdAtEntry: 25000,
      fxRateFetchedAt: now,
      fxRateEffectiveAt: now,
      fxRateSource: 'fixture',
    },
  })
  await prisma.budget.create({
    data: {
      userId,
      year: 2026,
      month: 9,
      scope: 'CATEGORY',
      categoryId: category.id,
      amount: 500,
      currency: 'VND',
    },
  })
  await prisma.recurringReminder.create({
    data: {
      userId,
      title: 'Fixture',
      type: 'EXPENSE',
      expectedAmount: 10,
      currency: 'VND',
      frequency: 'MONTHLY',
      dayOfMonth: 20,
      timezone: zone,
      startDate: new Date('2026-08-19T17:00:00Z'),
      accountId: account.id,
      categoryId: category.id,
    },
  })
  return userId
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const userId of userIds.splice(0)) {
    await prisma.reminderOccurrence.deleteMany({ where: { userId } })
    await prisma.recurringReminder.deleteMany({ where: { userId } })
    await prisma.budget.deleteMany({ where: { userId } })
    await prisma.transaction.deleteMany({ where: { userId } })
    await prisma.financialAccount.deleteMany({ where: { userId } })
    await prisma.category.deleteMany({ where: { userId } })
    await prisma.accountType.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
})

// Counts SQL commands at the PostgreSQL driver, including relation reads and
// transaction control. Never prints SQL parameters or fixture contents.
async function measure<T>(run: () => Promise<T>) {
  const query = vi.spyOn(pg.Client.prototype, 'query')
  try {
    const result = await run()
    return { result, calls: query.mock.calls.length }
  } finally {
    query.mockRestore()
  }
}

it('preserves every Dashboard widget while reducing measured SQL commands', async () => {
  const userId = await fixture()
  const measured = await measure(async () => {
    const position = await getCurrentPosition(userId, 'VND', { now })
    const other = await Promise.all([
      getActivitySummary(userId, 'VND', getPeriodBounds(zone, 'month', now)),
      getCashFlowTrend(userId, zone, 'VND', 6, now),
      getAccountBalanceOverTime(userId, zone, 'VND', 6, undefined, now),
      listTransactions(userId, { limit: 8 }),
      getBudgetProgressForMonth(userId, zone, 2026, 9),
      listSavingsGoals(userId),
      listDashboardOccurrences(userId, zone, { overdue: 2, upcoming: 5 }, now),
    ])
    return { position, other }
  })
  const batched = await measure(() => getDashboardData(userId, zone, 'VND', now, limits))
  const expected = measured.result as { position: unknown; other: unknown[] }
  const actual = batched.result as Awaited<ReturnType<typeof getDashboardData>>
  expect(actual.position).toEqual(expected.position)
  expect([
    actual.monthly,
    actual.cashFlowTrend,
    actual.balanceOverTime,
    actual.recentTransactions,
    actual.budgets,
    actual.goals,
    actual.occurrences,
  ]).toEqual(expected.other)
  expect(actual.monthly.expense.toString()).toBe('100')
  expect(actual.position?.totalBalance.toString()).toBe('900')
  expect(batched.calls).toBeLessThanOrEqual(28)
})

it('preserves Accounts balances and metadata while reducing measured SQL commands', async () => {
  const userId = await fixture()
  const measured = await measure(async () => {
    const [accounts] = await Promise.all([
      listActiveFinancialAccounts(userId),
      listAccountTypes(userId),
      listAllFinancialAccounts(userId),
      getCurrentPosition(userId, 'VND', { now }),
    ])
    return Promise.all([
      getAccountBalancesForAccounts(userId, accounts, now),
      accountsWithActivity(
        userId,
        accounts.map((a) => a.id),
      ),
      prisma.transaction.count({ where: { userId, date: { gt: now } } }),
      prisma.transfer.count({ where: { userId, date: { gt: now } } }),
    ])
  })
  const batched = await measure(() => getAccountOverview(userId, 'VND', now))
  const actual = batched.result as Awaited<ReturnType<typeof getAccountOverview>>
  const expected = measured.result as [Map<string, unknown>, Set<string>, number, number]
  expect(actual.balances).toEqual(expected[0])
  expect(actual.locked).toEqual(expected[1])
  expect(actual.hasFutureEntries).toBe(expected[2] + expected[3] > 0)
  expect(actual.position?.totalBalance.toString()).toBe('900')
  expect(batched.calls).toBeLessThanOrEqual(7)
})

it.each(['Asia/Ho_Chi_Minh', 'America/New_York'])(
  'preserves month boundaries, categories, future entries and tenant isolation in %s',
  async (timezone) => {
    const userId = await fixture()
    await fixture() // A second tenant with independent account/category/ledger rows.
    const account = await prisma.financialAccount.findFirstOrThrow({ where: { userId } })
    const second = await prisma.financialAccount.create({
      data: {
        userId,
        accountTypeId: account.accountTypeId,
        name: 'Second',
        currency: 'VND',
        initialBalance: 25,
        createdAt: account.createdAt,
      },
    })
    const category = await prisma.category.findFirstOrThrow({ where: { userId } })
    const period = getPeriodBounds(timezone, 'month', now)
    const entries = [
      { accountId: account.id, type: 'INCOME' as const, amount: 200, date: period.startUtc },
      { accountId: second.id, type: 'EXPENSE' as const, amount: 30, date: period.startUtc },
      {
        accountId: second.id,
        type: 'EXPENSE' as const,
        amount: 40,
        date: new Date(period.startUtc.getTime() - 1),
      },
      {
        accountId: second.id,
        type: 'INCOME' as const,
        amount: 900,
        date: new Date(now.getTime() + 1),
      },
    ]
    await prisma.transaction.createMany({
      data: entries.map((entry) => ({
        ...entry,
        userId,
        categoryId: entry.type === 'EXPENSE' ? category.id : null,
        currency: 'VND',
        vndPerUsdAtEntry: 25000,
        fxRateFetchedAt: now,
        fxRateEffectiveAt: now,
        fxRateSource: 'fixture',
      })),
    })
    const actual = await getDashboardData(userId, timezone, 'VND', now, limits)
    const month = getCalendarMonth(timezone, now)
    expect(actual.monthly).toEqual(await getActivitySummary(userId, 'VND', period))
    expect(actual.monthly.expense.toString()).toBe('130')
    // Activity reports retain their existing full-period (including future) rule.
    expect(actual.monthly.income.toString()).toBe('1100')
    expect(actual.budgets).toEqual(
      await getBudgetProgressForMonth(userId, timezone, month.year, month.month),
    )
    expect(actual.cashFlowTrend).toEqual(await getCashFlowTrend(userId, timezone, 'VND', 6, now))
    const accounts = await prisma.financialAccount.findMany({ where: { userId } })
    for (const point of actual.balanceOverTime) {
      const reference = await getAccountBalancesForAccounts(userId, accounts, point.asOf)
      const total = [...reference.values()].reduce(
        (sum, balance) => sum.add(balance),
        new Prisma.Decimal(0),
      )
      expect(point.balance).toEqual(total)
    }
    // Current position excludes the future income and includes both accounts.
    expect(actual.position?.totalBalance.toString()).toBe('1055')
    expect(actual.position?.accounts).toHaveLength(2)
    expect(actual.position).toEqual(await getCurrentPosition(userId, 'VND', { now }))
  },
)

it('returns empty Dashboard widgets without borrowing another tenant data', async () => {
  await fixture()
  const userId = randomUUID()
  userIds.push(userId)
  await prisma.user.create({ data: { id: userId, name: 'Empty', email: `${userId}@example.com` } })
  const result = await getDashboardData(userId, zone, 'VND', now, limits)
  expect(result.position?.totalBalance.toString()).toBe('0')
  expect(result.position?.accounts).toEqual([])
  expect(result.monthly.income.toString()).toBe('0')
  expect(result.monthly.expense.toString()).toBe('0')
  expect(result.balanceOverTime).toHaveLength(6)
  expect(result.balanceOverTime.every((point) => point.balance?.isZero())).toBe(true)
  expect(result.budgets).toEqual([])
  expect(result.goals).toEqual([])
  expect(result.occurrences.rows).toEqual([])
})

it('rejects mismatched request-local position inputs before any SQL', async () => {
  const userId = await fixture()
  const accounts = await prisma.financialAccount.findMany({ where: { userId } })
  const balances = await getAccountBalancesForAccounts(userId, accounts, now)
  const state = { userId, asOf: now, accounts, balances }
  const query = vi.spyOn(pg.Client.prototype, 'query')
  await expect(
    getCurrentPosition('other-user', 'VND', { now, accountState: state }),
  ).rejects.toThrow('this user and cutoff')
  await expect(
    getCurrentPosition(userId, 'VND', { now: new Date(now.getTime() + 1), accountState: state }),
  ).rejects.toThrow('this user and cutoff')
  await expect(
    getCurrentPosition(userId, 'VND', { now, accountState: { ...state, balances: new Map() } }),
  ).rejects.toThrow('Missing position account balance')
  await expect(
    getCurrentPosition(userId, 'VND', {
      now,
      accountState: { ...state, accounts: [{ ...accounts[0], userId: 'other-user' }] },
    }),
  ).rejects.toThrow('was not found for this user')
  expect(query).not.toHaveBeenCalled()
})

it('measures unchanged navigation read paths and the remaining Dashboard widgets', async () => {
  const userId = await fixture()
  const counts: Record<string, number> = {}
  const widgets = {
    monthly: () => getActivitySummary(userId, 'VND', getPeriodBounds(zone, 'month', now)),
    trend: () => getCashFlowTrend(userId, zone, 'VND', 6, now),
    recent: () => listTransactions(userId, { limit: 8 }),
    budgets: () => getBudgetProgressForMonth(userId, zone, 2026, 9),
    goals: () => listSavingsGoals(userId),
    reminders: () => listDashboardOccurrences(userId, zone, limits.occurrences, now),
  }
  for (const [name, run] of Object.entries(widgets)) {
    counts[name] = (await measure<unknown>(run)).calls
  }
  const transactions = await measure(async () => {
    const [, accounts] = await Promise.all([
      listTransactions(userId),
      listActiveFinancialAccounts(userId),
      listCategories(userId),
      getActivitySummary(userId, 'VND', getPeriodBounds(zone, 'month', now)),
    ])
    return getAccountBalancesForAccounts(userId, accounts, now)
  })
  const reminders = await measure(() =>
    Promise.all([
      listUpcomingOccurrences(userId, zone, now),
      listReminders(userId),
      listCategories(userId),
      listActiveFinancialAccounts(userId),
    ]),
  )
  expect(counts).toEqual({ monthly: 3, trend: 1, recent: 3, budgets: 3, goals: 1, reminders: 11 })
  expect(transactions.calls).toBe(12)
  expect(reminders.calls).toBe(12)
})
