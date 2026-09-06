import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { FxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import {
  getAccountDistribution,
  getCurrentPosition,
  getNetWorth,
  getTotalAccountBalance,
} from './position'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database.
 *
 * Every case injects a provider and `beforeEach` replaces `fetch` with a
 * throwing spy, so no test here can reach the network: an accidental live
 * lookup fails the test that caused it rather than passing quietly. The
 * USD/VND `ExchangeRate` rows are global (not user-scoped), so `afterEach`
 * clears them along with the user's own rows.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

/** Every `source` string this file can write into the shared FX cache. */
const FAKE_SOURCES = ['fake', 'seeded']

/**
 * A counting fake: the position service must consult the current-rate policy
 * at most once per call, no matter how many accounts need converting.
 */
function countingProvider(rate = 25000, source = 'fake') {
  let calls = 0
  const provider: ExchangeRateProvider = {
    getLatestRate: async () => {
      calls += 1
      return { rate, effectiveDate: new Date(), fetchedAt: new Date(), source }
    },
    getHistoricalRate: async () => null,
  }
  return { provider, callCount: () => calls }
}

/** Stands in for a live provider outage — the only way into the fallback path. */
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

describe('current position service', () => {
  const createdUserIds: string[] = []
  let fetchSpy: MockInstance

  async function setup() {
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
    const vndAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'VND',
        accountTypeId: accountType.id,
        initialBalance: 1_000_000,
        currency: 'VND',
      },
    })
    const usdAccount = await prisma.financialAccount.create({
      data: {
        userId: user.id,
        name: 'USD',
        accountTypeId: accountType.id,
        initialBalance: 100,
        currency: 'USD',
      },
    })
    return {
      userId: user.id,
      accountTypeId: accountType.id,
      vndAccountId: vndAccount.id,
      usdAccountId: usdAccount.id,
    }
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    // The fallback path warns by design; silenced to keep the output pristine.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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

  describe('getCurrentPosition', () => {
    it('sums same-currency accounts without touching FX at all', async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })
      const second = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'VND 2',
          accountTypeId: s.accountTypeId,
          initialBalance: 250_000,
          currency: 'VND',
        },
      })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', provider)

      expect(position.totalBalance.toString()).toBe('1250000')
      // No account needs converting, so the policy is never consulted and the
      // dashboard still renders during a provider outage.
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
      expect(position.accounts.map((a) => a.id).sort()).toEqual([s.vndAccountId, second.id].sort())
      expect(await prisma.exchangeRate.count()).toBe(0)
    })

    it('converts every foreign-currency balance before summing (the raw-native regression)', async () => {
      const s = await setup()
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', provider)

      // 1,000,000 VND + (100 USD x 25,000) = 3,500,000 VND. A bug that summed
      // raw native numbers would answer 1,000,100.
      expect(position.totalBalance.toString()).toBe('3500000')
      const usd = position.accounts.find((a) => a.id === s.usdAccountId)
      expect(usd?.nativeBalance.toString()).toBe('100')
      expect(usd?.displayBalance.toString()).toBe('2500000')
      const vnd = position.accounts.find((a) => a.id === s.vndAccountId)
      expect(vnd?.nativeBalance.toString()).toBe('1000000')
      expect(vnd?.displayBalance.toString()).toBe('1000000')
      expect(position.fx?.isFallback).toBe(false)
    })

    it('converts VND into USD when USD is the display currency', async () => {
      const s = await setup()
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'USD', provider)

      const vnd = position.accounts.find((a) => a.id === s.vndAccountId)
      // 1,000,000 VND / 25,000 = 40 USD — division, not multiplication.
      expect(vnd?.nativeBalance.toString()).toBe('1000000')
      expect(vnd?.displayBalance.toString()).toBe('40')
      expect(position.totalBalance.toString()).toBe('140')
    })

    it('consults the current-rate policy exactly once however many accounts need converting', async () => {
      const s = await setup()
      await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'USD 2',
          accountTypeId: s.accountTypeId,
          initialBalance: 200,
          currency: 'USD',
        },
      })
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', provider)

      // 1,000,000 + 100 x 25,000 + 200 x 25,000
      expect(position.totalBalance.toString()).toBe('8500000')
      expect(callCount()).toBe(1)
    })

    it('degrades to a recent last-known-good rate and says so', async () => {
      const s = await setup()
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await prisma.exchangeRate.create({
        data: {
          base: PAIR.base,
          quote: PAIR.quote,
          rate: new Prisma.Decimal('24000'),
          effectiveDate: twoHoursAgo,
          fetchedAt: twoHoursAgo,
          source: 'seeded',
        },
      })

      const position = await getCurrentPosition(s.userId, 'VND', failingProvider)

      // 1,000,000 + 100 x 24,000
      expect(position.totalBalance.toString()).toBe('3400000')
      expect(position.fx?.isFallback).toBe(true)
      expect(position.fx?.source).toBe('cache-fallback:seeded')
    })

    it('propagates FxUnavailableError when a conversion is needed and no rate exists', async () => {
      const s = await setup()

      await expect(getCurrentPosition(s.userId, 'VND', failingProvider)).rejects.toThrow(
        FxUnavailableError,
      )
    })

    it('still answers during an FX outage when no conversion is needed', async () => {
      const s = await setup()
      await prisma.financialAccount.delete({
        where: { userId_id: { userId: s.userId, id: s.usdAccountId } },
      })

      const position = await getCurrentPosition(s.userId, 'VND', failingProvider)

      expect(position.totalBalance.toString()).toBe('1000000')
      expect(position.fx).toBeNull()
    })

    it('excludes archived accounts from the position', async () => {
      const s = await setup()
      const archived = await prisma.financialAccount.create({
        data: {
          userId: s.userId,
          name: 'Closed',
          accountTypeId: s.accountTypeId,
          initialBalance: 0,
          currency: 'VND',
        },
      })
      // Set directly rather than through `archiveFinancialAccount`: this proves
      // the position service itself filters on status.
      await prisma.financialAccount.update({
        where: { userId_id: { userId: s.userId, id: archived.id } },
        data: { status: 'ARCHIVED' },
      })
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', provider)

      expect(position.accounts.some((a) => a.id === archived.id)).toBe(false)
      expect(position.totalBalance.toString()).toBe('3500000')
    })

    it("never sees another user's accounts", async () => {
      const mine = await setup()
      const theirs = await setup()

      const position = await getCurrentPosition(mine.userId, 'VND', countingProvider().provider)

      expect(position.accounts.map((a) => a.id).sort()).toEqual(
        [mine.vndAccountId, mine.usdAccountId].sort(),
      )
      expect(position.accounts.some((a) => a.id === theirs.vndAccountId)).toBe(false)
    })

    it('answers zero with no accounts and no FX call', async () => {
      const user = await prisma.user.create({
        data: {
          id: randomUUID(),
          email: `test-${randomUUID()}@example.com`,
          name: 'Test',
          emailVerified: false,
        },
      })
      createdUserIds.push(user.id)
      const { provider, callCount } = countingProvider()

      const position = await getCurrentPosition(user.id, 'VND', provider)

      expect(position.totalBalance.toString()).toBe('0')
      expect(position.accounts).toEqual([])
      expect(position.fx).toBeNull()
      expect(callCount()).toBe(0)
    })

    it('counts transaction activity, not just opening balances', async () => {
      const s = await setup()
      await prisma.transaction.create({
        data: {
          userId: s.userId,
          accountId: s.vndAccountId,
          type: 'CASH_IN',
          amount: new Prisma.Decimal('500000'),
          currency: 'VND',
          date: new Date('2026-03-15T10:00:00Z'),
          vndPerUsdAtEntry: new Prisma.Decimal('25000'),
          fxRateFetchedAt: new Date(),
          fxRateEffectiveAt: new Date('2026-03-15T00:00:00Z'),
          fxRateSource: 'fixture',
        },
      })
      const { provider } = countingProvider()

      const position = await getCurrentPosition(s.userId, 'VND', provider)

      // 1,500,000 VND + 100 USD x 25,000
      expect(position.totalBalance.toString()).toBe('4000000')
    })
  })

  describe('getNetWorth', () => {
    it('equals total account balance until Phase 6 extends it', async () => {
      const s = await setup()

      const netWorth = await getNetWorth(s.userId, 'VND', countingProvider().provider)
      const total = await getTotalAccountBalance(s.userId, 'VND', countingProvider().provider)

      expect(netWorth.toString()).toBe('3500000')
      expect(netWorth.toString()).toBe(total.toString())
    })
  })

  describe('getAccountDistribution', () => {
    it('returns per-account Decimals converted into the display currency', async () => {
      const s = await setup()

      const distribution = await getAccountDistribution(
        s.userId,
        'VND',
        countingProvider().provider,
      )

      const vnd = distribution.find((d) => d.name === 'VND')
      const usd = distribution.find((d) => d.name === 'USD')
      expect(vnd?.displayBalance.toString()).toBe('1000000')
      // The regression the plan describes: 100, not 2,500,000, would be the
      // number a native-comparison bug charted here.
      expect(usd?.displayBalance.toString()).toBe('2500000')
      expect(usd?.nativeBalance.toString()).toBe('100')
      expect(usd?.currency).toBe('USD')
      for (const entry of distribution) {
        expect(entry.displayBalance).toBeInstanceOf(Prisma.Decimal)
        expect(entry.nativeBalance).toBeInstanceOf(Prisma.Decimal)
      }
    })
  })
})
