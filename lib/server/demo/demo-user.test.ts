import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { DEMO_EMAIL, DEMO_TIMEZONE } from './constants'
import { clearDemoUser, seedDemoUser } from './demo-user'
import { DemoGuardError } from './guards'
import { deleteOwnedRows } from './owned-rows'

/**
 * The demo seed and reset against a real database.
 *
 * Four properties are what this suite exists to hold:
 *
 * 1. **The reset is scoped to one user.** A second, ordinary user with rows in
 *    every model the delete order touches is present throughout, and its row
 *    counts are compared before and after. Dropping the `userId` filter from
 *    any step of `deleteOwnedRows` fails here.
 * 2. **`isDemo` is the last word.** Flipping the flag off makes the reset abort
 *    with nothing deleted, even though the email still matches.
 * 3. **Seed is idempotent.** seed → clear → seed lands on the same counts, so a
 *    second run cannot double the dashboard's figures.
 * 4. **The production guard is real.** Both operations refuse a production
 *    environment before touching the database.
 *
 * FX comes from a fixed provider, passed through the same `providerOverride`
 * `createTransaction` already accepts for tests: the suite must not reach the
 * network, and an outage must not be able to turn a seeding failure into a red
 * test about something else.
 */

/** The one source string this suite can leave in the shared FX cache. */
const DEMO_TEST_FX_SOURCE = 'demo-test'

const fixedFxProvider: ExchangeRateProvider = {
  getLatestRate: async () => ({
    rate: 26_000,
    effectiveDate: new Date(),
    fetchedAt: new Date(Date.now() - 60_000),
    source: DEMO_TEST_FX_SOURCE,
  }),
  getHistoricalRate: async () => null,
}

const seedOptions = { providerOverride: fixedFxProvider }

/** A second, entirely ordinary user, with a row in every model the reset walks. */
let otherUserId: string

async function countOwnedRows(userId: string): Promise<Record<string, number>> {
  const where = { userId }
  const [
    reminderOccurrence,
    recurringReminder,
    savingsGoal,
    transaction,
    transfer,
    debtPayment,
    debt,
    loanPayment,
    loan,
    financialAccount,
    accountType,
    budget,
    category,
  ] = await Promise.all([
    prisma.reminderOccurrence.count({ where }),
    prisma.recurringReminder.count({ where }),
    prisma.savingsGoal.count({ where }),
    prisma.transaction.count({ where }),
    prisma.transfer.count({ where }),
    prisma.debtPayment.count({ where }),
    prisma.debt.count({ where }),
    prisma.loanPayment.count({ where }),
    prisma.loan.count({ where }),
    prisma.financialAccount.count({ where }),
    prisma.accountType.count({ where }),
    prisma.budget.count({ where }),
    prisma.category.count({ where }),
  ])
  return {
    reminderOccurrence,
    recurringReminder,
    savingsGoal,
    transaction,
    transfer,
    debtPayment,
    debt,
    loanPayment,
    loan,
    financialAccount,
    accountType,
    budget,
    category,
  }
}

/**
 * Builds the neighbour. Rows go in with plain Prisma calls rather than through
 * the services: this user is scenery, and the only thing asserted about it is
 * that its row counts never move — which no service invariant contributes to.
 * Its transaction carries its own FX snapshot for the same reason.
 */
async function createOtherUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `demo-neighbour-${randomUUID()}@example.com`,
      name: 'Not The Demo User',
      emailVerified: false,
      timezone: DEMO_TIMEZONE,
    },
  })
  const userId = user.id
  const accountType = await prisma.accountType.create({ data: { userId, name: 'Cash' } })
  const category = await prisma.category.create({
    data: { userId, name: 'Groceries', type: 'EXPENSE' },
  })
  const account = await prisma.financialAccount.create({
    data: {
      userId,
      name: 'Neighbour Wallet',
      accountTypeId: accountType.id,
      initialBalance: new Prisma.Decimal('1000000'),
      currency: 'VND',
    },
  })
  await prisma.transaction.create({
    data: {
      userId,
      accountId: account.id,
      categoryId: category.id,
      type: 'EXPENSE',
      amount: new Prisma.Decimal('125000'),
      currency: 'VND',
      date: new Date('2026-01-15T03:00:00.000Z'),
      vndPerUsdAtEntry: new Prisma.Decimal('25000'),
      fxRateFetchedAt: new Date('2026-01-15T02:00:00.000Z'),
      fxRateEffectiveAt: new Date('2026-01-15T00:00:00.000Z'),
      fxRateSource: 'demo-neighbour',
    },
  })
  await prisma.budget.create({
    data: {
      userId,
      year: 2026,
      month: 1,
      scope: 'CATEGORY',
      categoryId: category.id,
      amount: new Prisma.Decimal('500000'),
      currency: 'VND',
    },
  })
  await prisma.savingsGoal.create({
    data: {
      userId,
      name: 'Neighbour Goal',
      targetAmount: new Prisma.Decimal('2000000'),
      currentProgress: new Prisma.Decimal('250000'),
      currency: 'VND',
    },
  })
  await prisma.debt.create({
    data: {
      userId,
      direction: 'PAYABLE',
      person: 'Someone Else',
      originalAmount: new Prisma.Decimal('300000'),
      currency: 'VND',
    },
  })
  return userId
}

/** Removes everything this file can create, demo user row included. */
async function removeDemoUserEntirely(): Promise<void> {
  const demo = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } })
  if (!demo) return
  await deleteOwnedRows(prisma, [demo.id])
  await prisma.session.deleteMany({ where: { userId: demo.id } })
  await prisma.account.deleteMany({ where: { userId: demo.id } })
  await prisma.user.delete({ where: { id: demo.id } })
}

beforeAll(async () => {
  await removeDemoUserEntirely()
  otherUserId = await createOtherUser()
})

afterAll(async () => {
  await removeDemoUserEntirely()
  await deleteOwnedRows(prisma, [otherUserId])
  await prisma.user.delete({ where: { id: otherUserId } })
  // The cached rate this suite's provider left behind. Scoped to its own
  // source so a neighbouring suite's USD/VND row is not collateral damage.
  await prisma.exchangeRate.deleteMany({ where: { source: DEMO_TEST_FX_SOURCE } })
})

describe('the production guard', () => {
  it('refuses to seed in a production environment without the override', async () => {
    await expect(seedDemoUser({ ...seedOptions, env: { NODE_ENV: 'production' } })).rejects.toThrow(
      DemoGuardError,
    )
  })

  it('refuses to clear in a production environment without the override', async () => {
    await expect(clearDemoUser({ env: { NODE_ENV: 'production' } })).rejects.toThrow(DemoGuardError)
  })
})

describe('seedDemoUser', () => {
  it('registers the demo user, flags it, and fills every module', async () => {
    const neighbourBefore = await countOwnedRows(otherUserId)

    const result = await seedDemoUser(seedOptions)

    expect(result.created).toBe(true)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    expect(user.isDemo).toBe(true)
    expect(user.timezone).toBe(DEMO_TIMEZONE)
    expect(user.id).toBe(result.userId)

    // The fixture's own report, and the database's answer, must agree.
    expect(result.counts.accounts).toBe(4)
    expect(result.counts.transactions).toBe(40)
    expect(result.counts.transfers).toBe(3)
    expect(result.counts.budgets).toBe(3)
    expect(result.counts.savingsGoals).toBe(2)
    expect(result.counts.debts).toBe(1)
    expect(result.counts.debtPayments).toBe(2)
    expect(result.counts.loans).toBe(1)
    expect(result.counts.loanPayments).toBe(3)
    expect(result.counts.reminders).toBe(4)

    const stored = await countOwnedRows(result.userId)
    expect(stored.financialAccount).toBe(4)
    expect(stored.transaction).toBe(40)
    expect(stored.transfer).toBe(3)
    expect(stored.budget).toBe(3)
    expect(stored.savingsGoal).toBe(2)
    expect(stored.debt).toBe(1)
    expect(stored.debtPayment).toBe(2)
    expect(stored.loan).toBe(1)
    expect(stored.loanPayment).toBe(3)
    expect(stored.recurringReminder).toBe(4)

    // Every transaction carries a real snapshot from the policy, never a
    // fabricated one: same source the provider reported, and no nulls.
    const snapshots = await prisma.transaction.findMany({
      where: { userId: result.userId },
      select: { vndPerUsdAtEntry: true, fxRateSource: true, date: true },
    })
    expect(snapshots).toHaveLength(40)
    expect(snapshots.every((row) => row.fxRateSource === DEMO_TEST_FX_SOURCE)).toBe(true)
    expect(snapshots.every((row) => row.vndPerUsdAtEntry.equals(new Prisma.Decimal(26000)))).toBe(
      true,
    )
    // No future-dated demo activity — the fixture clamps the current month.
    expect(snapshots.every((row) => row.date.getTime() <= Date.now())).toBe(true)

    // The one cross-currency transfer records the rate actually applied,
    // derived from the same policy rather than a constant.
    const crossCurrency = await prisma.transfer.findMany({
      where: { userId: result.userId, exchangeRateUsed: { not: null } },
    })
    expect(crossCurrency).toHaveLength(1)
    expect(crossCurrency[0].exchangeRateUsed?.equals(new Prisma.Decimal(26000))).toBe(true)

    expect(await countOwnedRows(otherUserId)).toEqual(neighbourBefore)
  })

  it('is idempotent across seed → clear → seed', async () => {
    const afterFirstSeed = await countOwnedRows(
      (await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })).id,
    )

    const cleared = await clearDemoUser()
    expect(cleared.found).toBe(true)

    const second = await seedDemoUser(seedOptions)
    expect(second.created).toBe(false)
    expect(await countOwnedRows(second.userId)).toEqual(afterFirstSeed)
  })
})

describe('clearDemoUser', () => {
  it('deletes only the demo user rows', async () => {
    const demo = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })
    const neighbourBefore = await countOwnedRows(otherUserId)
    expect(Object.values(await countOwnedRows(demo.id)).some((n) => n > 0)).toBe(true)

    const result = await clearDemoUser()

    expect(result.found).toBe(true)
    expect(result.userId).toBe(demo.id)
    expect(await countOwnedRows(demo.id)).toEqual({
      reminderOccurrence: 0,
      recurringReminder: 0,
      savingsGoal: 0,
      transaction: 0,
      transfer: 0,
      debtPayment: 0,
      debt: 0,
      loanPayment: 0,
      loan: 0,
      financialAccount: 0,
      accountType: 0,
      budget: 0,
      category: 0,
    })
    expect(await countOwnedRows(otherUserId)).toEqual(neighbourBefore)

    // The account itself survives a reset — that is what lets `demo:seed` refill
    // it without registering again.
    expect(await prisma.user.findUnique({ where: { email: DEMO_EMAIL } })).not.toBeNull()
  })

  it('is a clean no-op when no user holds the demo email', async () => {
    await removeDemoUserEntirely()
    const result = await clearDemoUser()
    expect(result).toEqual({ found: false, userId: null, deleted: {} })
  })

  it('aborts, deleting nothing, when the target user is not flagged isDemo', async () => {
    const seeded = await seedDemoUser(seedOptions)
    const before = await countOwnedRows(seeded.userId)
    await prisma.user.update({ where: { id: seeded.userId }, data: { isDemo: false } })

    try {
      await expect(clearDemoUser()).rejects.toThrow(/not flagged isDemo/)
      expect(await countOwnedRows(seeded.userId)).toEqual(before)
    } finally {
      await prisma.user.update({ where: { id: seeded.userId }, data: { isDemo: true } })
    }
  })

  it('refuses to seed over a real account holding the demo email', async () => {
    await removeDemoUserEntirely()
    const impostor = await prisma.user.create({
      data: { id: randomUUID(), email: DEMO_EMAIL, name: 'A Real Person', emailVerified: true },
    })
    try {
      await expect(seedDemoUser(seedOptions)).rejects.toThrow(/not flagged isDemo/)
      // Nothing was created for it, and nothing was deleted from it.
      expect(Object.values(await countOwnedRows(impostor.id)).every((n) => n === 0)).toBe(true)
      const untouched = await prisma.user.findUniqueOrThrow({ where: { id: impostor.id } })
      expect(untouched.isDemo).toBe(false)
    } finally {
      await prisma.user.delete({ where: { id: impostor.id } })
    }
  })
})
