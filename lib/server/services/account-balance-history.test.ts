import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import type { Currency, TransactionType } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { getAccountBalanceOverTime } from './account-balance-history'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * Every case pins `now` to a fixed instant. The service's month windows are
 * derived from it, so the whole suite is immune to the wall clock: the same
 * assertions hold on the first of a month, on New Year's Eve, and in CI.
 *
 * The service is *historical*, so the rate for each point must come from that
 * point's own day. Two things prove nothing substitutes today's rate: a
 * throwing `fetch` spy in `beforeEach` (any live lookup fails the test that
 * caused it), and a provider whose `getLatestRate` throws and counts its
 * calls — the current-rate policy is never reachable without going through it.
 * The USD/VND `ExchangeRate` rows are global, so `afterEach` clears them along
 * with the user's own rows.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

const HCMC = 'Asia/Ho_Chi_Minh'

/** Fixed "current instant": 2026-09-15 17:00 local in `HCMC`. */
const NOW = new Date('2026-09-15T10:00:00.000Z')

/** Old enough that no fixture account post-dates any window under test. */
const CREATED = new Date('2026-01-01T00:00:00.000Z')

/** `endUtc − 1 ms` for the two complete months preceding `NOW`, in `HCMC`. */
const JULY_AS_OF = new Date('2026-07-31T16:59:59.999Z')
const AUGUST_AS_OF = new Date('2026-08-31T16:59:59.999Z')

/** The UTC days those as-of instants fall on — the FX cache's natural key. */
const JULY_RATE_DAY = new Date(Date.UTC(2026, 6, 31))
const AUGUST_RATE_DAY = new Date(Date.UTC(2026, 7, 31))
const SEPTEMBER_RATE_DAY = new Date(Date.UTC(2026, 8, 15))

/**
 * A provider that fails the test if anything reaches it, and records the
 * attempt so a case can assert the *absence* of a lookup rather than relying on
 * the throw. `getLatestRate` is the only door to the current-rate policy, so a
 * zero count there is proof no point was converted at today's rate.
 */
function makeForbiddenProvider() {
  const calls = { latest: 0, historical: 0 }
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => {
      calls.latest += 1
      throw new Error('the current-rate path must never be used for history')
    },
    getHistoricalRate: async () => {
      calls.historical += 1
      throw new Error('provider must not be called')
    },
  }
  return { provider, calls }
}

/** A provider with no historical data at all — every uncached day is a gap. */
function makeNoHistoryProvider() {
  const calls = { latest: 0, historical: 0 }
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => {
      calls.latest += 1
      throw new Error('the current-rate path must never be used for history')
    },
    getHistoricalRate: async () => {
      calls.historical += 1
      return null
    },
  }
  return { provider, calls }
}

describe('getAccountBalanceOverTime', () => {
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
    return { userId: user.id, accountTypeId: accountType.id }
  }

  function makeAccount(input: {
    userId: string
    accountTypeId: string
    name: string
    currency: Currency
    initialBalance: string
    createdAt?: Date
    status?: 'ACTIVE' | 'ARCHIVED'
  }) {
    return prisma.financialAccount.create({
      data: {
        userId: input.userId,
        name: input.name,
        accountTypeId: input.accountTypeId,
        initialBalance: new Prisma.Decimal(input.initialBalance),
        currency: input.currency,
        createdAt: input.createdAt ?? CREATED,
        status: input.status ?? 'ACTIVE',
      },
    })
  }

  /** The UTC start of the day containing `date` — the `fxRateEffectiveAt` convention. */
  function utcDayStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  }

  function makeTx(input: {
    userId: string
    accountId: string
    type: TransactionType
    amount: string
    currency?: Currency
    date: Date
  }) {
    return prisma.transaction.create({
      data: {
        userId: input.userId,
        accountId: input.accountId,
        categoryId: null,
        type: input.type,
        amount: new Prisma.Decimal(input.amount),
        currency: input.currency ?? 'VND',
        date: input.date,
        vndPerUsdAtEntry: new Prisma.Decimal('25000'),
        fxRateFetchedAt: new Date(),
        fxRateEffectiveAt: utcDayStart(input.date),
        fxRateSource: 'fixture',
      },
    })
  }

  /** A USD/VND rate already in the cache for one UTC day, as a past fetch left it. */
  function seedRate(effectiveDate: Date, rate: string) {
    return prisma.exchangeRate.create({
      data: {
        base: PAIR.base,
        quote: PAIR.quote,
        rate: new Prisma.Decimal(rate),
        effectiveDate,
        fetchedAt: new Date('2026-09-01T00:00:00.000Z'),
        source: 'seeded',
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
      await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
      if (userIds.length > 0) {
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.transfer.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.financialAccount.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.accountType.deleteMany({ where: { userId: { in: userIds } } })
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    // Asserted after cleanup so a network leak fails the run without also
    // leaving rows behind for the next test.
    expect(fetchCalls).toBe(0)
  })

  it('returns one point per month, oldest first, for a VND-only user without consulting FX', async () => {
    const s = await setup()
    await makeAccount({ ...s, name: 'Wallet', currency: 'VND', initialBalance: '1000000' })
    const { provider, calls } = makeForbiddenProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 3, provider, NOW)

    expect(points.map((point) => point.month)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(points.map((point) => point.balance?.toString())).toEqual([
      '1000000',
      '1000000',
      '1000000',
    ])
    // The last instant of each completed local month, and `now` itself for the
    // month in progress — never a future instant.
    expect(points[0].asOf.toISOString()).toBe(JULY_AS_OF.toISOString())
    expect(points[1].asOf.toISOString()).toBe(AUGUST_AS_OF.toISOString())
    expect(points[2].asOf.getTime()).toBe(NOW.getTime())
    // Not merely "the throw never fired": no rate lookup of either kind was
    // even attempted for a user whose accounts are all in the display currency.
    expect(calls).toEqual({ latest: 0, historical: 0 })
  })

  it('counts an account as zero before it existed and at its balance from that month on', async () => {
    const s = await setup()
    // Two months before `NOW` on the *user's* wall clock: 2026-07-15 00:00 in
    // Ho Chi Minh City, which is 2026-07-14T17:00Z.
    const createdAt = fromZonedTime('2026-07-15T00:00:00', HCMC)
    await makeAccount({
      ...s,
      name: 'New Account',
      currency: 'VND',
      initialBalance: '1000000',
      createdAt,
    })
    const { provider } = makeForbiddenProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 6, provider, NOW)

    expect(points.map((point) => point.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ])
    expect(points.map((point) => point.balance?.toString())).toEqual([
      '0',
      '0',
      '0',
      '1000000',
      '1000000',
      '1000000',
    ])
  })

  it("converts each point at its own day's historical rate, not at one shared rate", async () => {
    const s = await setup()
    await makeAccount({ ...s, name: 'Dollars', currency: 'USD', initialBalance: '100' })
    // Two genuinely different days, one of them at a rate a double cannot hold
    // exactly — if either point borrowed the other's rate, or the arithmetic
    // ever passed through a float, these strings would not come back.
    await seedRate(AUGUST_RATE_DAY, '26025.123457')
    await seedRate(SEPTEMBER_RATE_DAY, '25000')
    const { provider, calls } = makeForbiddenProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 2, provider, NOW)

    expect(points.map((point) => point.month)).toEqual(['2026-08', '2026-09'])
    expect(points[0].balance?.toString()).toBe('2602512.3457')
    expect(points[1].balance?.toString()).toBe('2500000')
    // Both days were cached, so the provider was never needed — and the
    // current-rate door was never opened either.
    expect(calls).toEqual({ latest: 0, historical: 0 })
  })

  it('renders a gap for the one month whose historical rate is unavailable', async () => {
    const s = await setup()
    await makeAccount({ ...s, name: 'Dollars', currency: 'USD', initialBalance: '100' })
    // August is deliberately absent from the cache and the provider has no
    // history, so that point — and only that point — has no honest number.
    await seedRate(JULY_RATE_DAY, '24000')
    await seedRate(SEPTEMBER_RATE_DAY, '25000')
    const { provider, calls } = makeNoHistoryProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 3, provider, NOW)

    expect(points.map((point) => point.month)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(points[0].balance?.toString()).toBe('2400000')
    expect(points[1].balance).toBeNull()
    expect(points[2].balance?.toString()).toBe('2500000')
    // Exactly one day reached the provider — the two cached days did not — and
    // the missing one did not fall back to the current rate.
    expect(calls).toEqual({ latest: 0, historical: 1 })
    const rows = await prisma.exchangeRate.findMany({
      where: { base: PAIR.base, quote: PAIR.quote },
    })
    expect(rows.map((row) => row.effectiveDate.getTime()).sort()).toEqual(
      [JULY_RATE_DAY.getTime(), SEPTEMBER_RATE_DAY.getTime()].sort(),
    )
  })

  it("excludes a transaction dated after a point's asOf", async () => {
    const s = await setup()
    const account = await makeAccount({
      ...s,
      name: 'Wallet',
      currency: 'VND',
      initialBalance: '1000000',
    })
    // 2026-09-01T00:00Z is after August's as-of instant (2026-08-31T16:59:59.999Z,
    // i.e. local midnight ending August) and before `NOW`.
    await makeTx({
      userId: s.userId,
      accountId: account.id,
      type: 'CASH_IN',
      amount: '500000',
      date: new Date('2026-09-01T00:00:00.000Z'),
    })
    const { provider } = makeForbiddenProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 2, provider, NOW)

    expect(points.map((point) => point.balance?.toString())).toEqual(['1000000', '1500000'])
  })

  it("uses `now` as the current month's asOf, so a transaction a minute later is excluded", async () => {
    const s = await setup()
    const account = await makeAccount({
      ...s,
      name: 'Wallet',
      currency: 'VND',
      initialBalance: '1000000',
    })
    const justAfterNow = new Date(NOW.getTime() + 60_000)
    await makeTx({
      userId: s.userId,
      accountId: account.id,
      type: 'CASH_IN',
      amount: '500000',
      date: justAfterNow,
    })
    const { provider } = makeForbiddenProvider()

    const asOfNow = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 1, provider, NOW)
    // The same month, asked two minutes later: the row is now in the past.
    const asOfLater = await getAccountBalanceOverTime(
      s.userId,
      HCMC,
      'VND',
      1,
      provider,
      new Date(NOW.getTime() + 120_000),
    )

    expect(asOfNow[0].month).toBe('2026-09')
    expect(asOfNow[0].asOf.getTime()).toBe(NOW.getTime())
    expect(asOfNow[0].balance?.toString()).toBe('1000000')
    expect(asOfLater[0].balance?.toString()).toBe('1500000')
  })

  it("converts a VND account into a USD display currency at the day's rate", async () => {
    const s = await setup()
    await makeAccount({ ...s, name: 'Wallet', currency: 'VND', initialBalance: '2500000' })
    await seedRate(SEPTEMBER_RATE_DAY, '25000')
    const { provider, calls } = makeForbiddenProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'USD', 1, provider, NOW)

    expect(points[0].balance?.toString()).toBe('100')
    expect(calls).toEqual({ latest: 0, historical: 0 })
  })

  it('includes an archived account, which still held money in earlier months', async () => {
    const s = await setup()
    // An account can only be archived at a zero balance, so it contributes
    // nothing today — but its earlier months are real history and dropping them
    // would make the chart's past silently change every time a user tidies up.
    const account = await makeAccount({
      ...s,
      name: 'Closed Wallet',
      currency: 'VND',
      initialBalance: '1000000',
      status: 'ARCHIVED',
    })
    await makeTx({
      userId: s.userId,
      accountId: account.id,
      type: 'CASH_OUT',
      amount: '1000000',
      date: new Date('2026-09-10T03:00:00.000Z'),
    })
    const { provider } = makeForbiddenProvider()

    const points = await getAccountBalanceOverTime(s.userId, HCMC, 'VND', 3, provider, NOW)

    expect(points.map((point) => point.balance?.toString())).toEqual(['1000000', '1000000', '0'])
  })
})
