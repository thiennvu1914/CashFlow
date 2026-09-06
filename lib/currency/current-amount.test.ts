import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { convertToCurrentAmount } from './current-amount'
import { FxUnavailableError } from './current-rate-policy'
import type { ExchangeRateProvider } from './provider'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every case injects a provider and
 * `afterEach` clears the shared USD/VND rows (they are global, not user-scoped,
 * so leaving one behind would pin the next test's rate). A throwing `fetch`
 * spy makes any accidental live lookup fail the test that caused it.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

/** Every `source` string this file can write into the shared FX cache. */
const FAKE_SOURCES = ['fake', 'fallback-fake']

function workingProvider(rate = 25000, source = 'fake'): ExchangeRateProvider {
  return {
    getLatestRate: async () => ({ rate, effectiveDate: new Date(), fetchedAt: new Date(), source }),
    getHistoricalRate: async () => null,
  }
}

/** Stands in for a live provider outage: the only path into the fallback. */
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

describe('convertToCurrentAmount', () => {
  let fetchSpy: MockInstance
  let warnSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    // Silenced so the fallback cases keep the suite's output pristine.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await prisma.exchangeRate.deleteMany({ where: { source: { in: FAKE_SOURCES } } })
    await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
  })

  it('returns the same amount when currencies match, without calling the provider', async () => {
    let called = false
    const spyProvider: ExchangeRateProvider = {
      getLatestRate: async () => {
        called = true
        throw new Error('should not be called')
      },
      getHistoricalRate: async () => null,
    }
    const amount = new Prisma.Decimal('100000.55')

    const result = await convertToCurrentAmount(amount, 'VND', 'VND', spyProvider)

    // The very same instance: a pass-through recomputes nothing.
    expect(result).toBe(amount)
    expect(called).toBe(false)
    // Not even the cache is consulted, so a same-currency figure still renders
    // while FX is down.
    expect(await prisma.exchangeRate.count()).toBe(0)
  })

  it('converts USD to VND using the current rate', async () => {
    const result = await convertToCurrentAmount(100, 'USD', 'VND', workingProvider())

    expect(result).toBeInstanceOf(Prisma.Decimal)
    expect(result.toString()).toBe('2500000')
  })

  it('converts VND to USD using the current rate', async () => {
    const result = await convertToCurrentAmount(100000, 'VND', 'USD', workingProvider())

    expect(result.toString()).toBe('4')
  })

  it('accepts a number, a string or a Decimal amount and always answers with a Decimal', async () => {
    const provider = workingProvider()

    const fromNumber = await convertToCurrentAmount(100, 'USD', 'VND', provider)
    const fromString = await convertToCurrentAmount('100', 'USD', 'VND', provider)
    const fromDecimal = await convertToCurrentAmount(
      new Prisma.Decimal('100'),
      'USD',
      'VND',
      provider,
    )

    for (const result of [fromNumber, fromString, fromDecimal]) {
      expect(result).toBeInstanceOf(Prisma.Decimal)
      expect(result.toString()).toBe('2500000')
    }

    // A string is the safest money input: it cannot have been through a float
    // already, so digits a double could not hold survive intact. The cache is
    // cleared first — today's row was pinned by the calls above, exactly as the
    // calendar pins it in production.
    await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })
    const precise = await convertToCurrentAmount('0.1', 'USD', 'VND', workingProvider(25000.5))
    expect(precise.toString()).toBe('2500.05')
  })

  it('degrades to a recent last-known-good rate when the provider is down, using its exact Decimal', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await prisma.exchangeRate.create({
      data: {
        base: PAIR.base,
        quote: PAIR.quote,
        rate: new Prisma.Decimal('24000'),
        effectiveDate: twoHoursAgo,
        fetchedAt: twoHoursAgo,
        source: 'fallback-fake',
      },
    })

    const result = await convertToCurrentAmount(100, 'USD', 'VND', failingProvider)

    expect(result.toString()).toBe('2400000')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it("converts at the fallback row's exact Decimal, to the last digit a double would drop", async () => {
    // 18 significant digits — the full width of `Decimal(18, 6)`. Through a
    // double the rate would already read 123456789012.12346, and the answer
    // would be 12345678901212.346 instead of 12345678901212.3456.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await prisma.exchangeRate.create({
      data: {
        base: PAIR.base,
        quote: PAIR.quote,
        rate: new Prisma.Decimal('123456789012.123456'),
        effectiveDate: twoHoursAgo,
        fetchedAt: twoHoursAgo,
        source: 'fallback-fake',
      },
    })

    const result = await convertToCurrentAmount(100, 'USD', 'VND', failingProvider)

    expect(result.toString()).toBe('12345678901212.3456')
  })

  it('throws FxUnavailableError when the provider is down and no recent rate exists', async () => {
    await expect(convertToCurrentAmount(100, 'USD', 'VND', failingProvider)).rejects.toThrow(
      FxUnavailableError,
    )
  })

  it('refuses a currency pair it has no rate for, before consulting any rate source', async () => {
    let called = false
    const spyProvider: ExchangeRateProvider = {
      getLatestRate: async () => {
        called = true
        throw new Error('should not be called')
      },
      getHistoricalRate: async () => null,
    }

    await expect(
      convertToCurrentAmount(100, 'EUR' as unknown as 'USD', 'VND', spyProvider),
    ).rejects.toThrow(/EUR/)
    expect(called).toBe(false)
  })

  it('never reaches the network on any path', async () => {
    await convertToCurrentAmount(100, 'USD', 'VND', workingProvider())
    await prisma.exchangeRate.deleteMany({ where: { base: PAIR.base, quote: PAIR.quote } })

    await expect(convertToCurrentAmount(100, 'USD', 'VND', failingProvider)).rejects.toThrow(
      FxUnavailableError,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
