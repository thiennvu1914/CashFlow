import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { applyVndPerUsdRate, UnsupportedCurrencyPairError } from './apply-rate'
import { historicalAmountIn } from './historical-amount'
import { getUsableCurrentRate } from './current-rate-policy'
import type { Currency, ExchangeRateProvider } from './provider'

/**
 * `historicalAmountIn` is pure: it restates a transaction using the rate that
 * transaction itself snapshotted, so the answer can never move when today's
 * rate does. These tests enforce that rather than merely describing it — a
 * throwing `fetch` spy is installed for every case, and the "stability" case
 * deliberately puts a *different* rate in both the live cache and the provider
 * before converting.
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

function dec(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

async function cleanupRatesFor(pair: typeof PAIR) {
  await prisma.exchangeRate.deleteMany({ where: { base: pair.base, quote: pair.quote } })
}

describe('historicalAmountIn', () => {
  let fetchSpy: MockInstance

  beforeEach(() => {
    // Enforcing, not observing: any network access from the historical path
    // fails the test that caused it.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupRatesFor(PAIR)
  })

  it('passes the same Decimal through unchanged when currencies match', () => {
    const vndTx = { amount: dec(100000), currency: 'VND' as const, vndPerUsdAtEntry: dec(25000) }
    const usdTx = { amount: dec('12.34'), currency: 'USD' as const, vndPerUsdAtEntry: dec(25000) }

    // The very same instance, not merely an equal one: nothing is recomputed,
    // so no precision can be lost on a pass-through.
    expect(historicalAmountIn('VND', vndTx)).toBe(vndTx.amount)
    expect(historicalAmountIn('USD', usdTx)).toBe(usdTx.amount)
    expect(historicalAmountIn('VND', vndTx).toString()).toBe('100000')
    expect(historicalAmountIn('USD', usdTx).toString()).toBe('12.34')
  })

  it('converts USD to VND by multiplying by the entry-time rate', () => {
    const tx = { amount: dec(100), currency: 'USD' as const, vndPerUsdAtEntry: dec(25000) }

    expect(historicalAmountIn('VND', tx).toString()).toBe('2500000')
  })

  it('converts VND to USD by dividing by the entry-time rate', () => {
    const tx = { amount: dec(2_500_000), currency: 'VND' as const, vndPerUsdAtEntry: dec(25000) }

    expect(historicalAmountIn('USD', tx).toString()).toBe('100')
  })

  it('never touches the network', () => {
    const tx = { amount: dec(100), currency: 'USD' as const, vndPerUsdAtEntry: dec(25000) }

    historicalAmountIn('VND', tx)
    historicalAmountIn('USD', { ...tx, currency: 'VND' as const })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("is unaffected by today's rate, in the cache or from the provider", async () => {
    const januaryTx = {
      amount: dec(2_500_000),
      currency: 'VND' as const,
      vndPerUsdAtEntry: dec(25000),
    }
    const before = historicalAmountIn('USD', januaryTx)

    // Today's live rate is now a very different number, both in the cache and
    // through the current-rate policy — a conversion that consulted live state
    // would answer 50 instead of 100.
    const today = new Date()
    await prisma.exchangeRate.create({
      data: {
        base: PAIR.base,
        quote: PAIR.quote,
        rate: 50000,
        effectiveDate: new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
        ),
        fetchedAt: today,
        source: 'fake-today',
      },
    })
    const loudProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({
        rate: 99999,
        effectiveDate: today,
        fetchedAt: today,
        source: 'fake-today',
      }),
      getHistoricalRate: async () => null,
    }
    const live = await getUsableCurrentRate(PAIR, loudProvider)
    expect(live.rate).toBe(50000)

    const after = historicalAmountIn('USD', januaryTx)

    expect(before.toString()).toBe('100')
    expect(after.toString()).toBe('100')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps full decimal precision, with no rounding of its own', () => {
    // 0.1 is the classic float trap: 0.1 * 25000.5 is 2500.0500000000002 in
    // IEEE-754 doubles.
    expect(
      historicalAmountIn('VND', {
        amount: dec('0.1'),
        currency: 'USD',
        vndPerUsdAtEntry: dec('25000.5'),
      }).toString(),
    ).toBe('2500.05')

    // A non-terminating quotient carries decimal.js's default 20 significant
    // digits — this module rounds to no display scale of its own.
    expect(
      historicalAmountIn('USD', {
        amount: dec(1),
        currency: 'VND',
        vndPerUsdAtEntry: dec(3),
      }).toString(),
    ).toBe('0.33333333333333333333')

    expect(
      historicalAmountIn('USD', {
        amount: dec(2_500_000),
        currency: 'VND',
        vndPerUsdAtEntry: dec(25000),
      }).toString(),
    ).toBe('100')

    // The full Decimal(18,6) snapshot precision survives the multiplication.
    expect(
      historicalAmountIn('VND', {
        amount: dec(100),
        currency: 'USD',
        vndPerUsdAtEntry: dec('26025.122751'),
      }).toString(),
    ).toBe('2602512.2751')
  })

  it('refuses a currency pair it has no rate for', () => {
    const tx = {
      amount: dec(100),
      currency: 'EUR' as unknown as Currency,
      vndPerUsdAtEntry: dec(25000),
    }

    expect(() => historicalAmountIn('VND', tx)).toThrow(UnsupportedCurrencyPairError)
    expect(() => historicalAmountIn('VND', tx)).toThrow(/EUR/)
  })

  it('refuses a non-positive snapshot rate rather than inventing an answer', () => {
    const zero = { amount: dec(100), currency: 'USD' as const, vndPerUsdAtEntry: dec(0) }
    const negative = { amount: dec(100), currency: 'USD' as const, vndPerUsdAtEntry: dec(-25000) }

    expect(() => historicalAmountIn('VND', zero)).toThrow(RangeError)
    expect(() => historicalAmountIn('VND', negative)).toThrow(RangeError)
    // Even the pass-through refuses it: a non-positive snapshot is corrupt data
    // whatever the currencies happen to be.
    expect(() => historicalAmountIn('USD', { ...zero, currency: 'USD' })).toThrow(RangeError)
  })
})

describe('applyVndPerUsdRate', () => {
  it('is the single VND/USD arithmetic core, in both directions', () => {
    expect(applyVndPerUsdRate(dec(100), 'USD', 'VND', dec(25000)).toString()).toBe('2500000')
    expect(applyVndPerUsdRate(dec(2_500_000), 'VND', 'USD', dec(25000)).toString()).toBe('100')
  })

  it('returns the same Decimal instance when from and to match', () => {
    const amount = dec('1234.56')

    expect(applyVndPerUsdRate(amount, 'VND', 'VND', dec(25000))).toBe(amount)
    expect(applyVndPerUsdRate(amount, 'USD', 'USD', dec(25000))).toBe(amount)
  })

  it('throws UnsupportedCurrencyPairError, with its name set, on any other pair', () => {
    const thrown = (() => {
      try {
        applyVndPerUsdRate(dec(100), 'EUR' as unknown as Currency, 'VND', dec(25000))
      } catch (e) {
        return e
      }
    })()

    expect(thrown).toBeInstanceOf(UnsupportedCurrencyPairError)
    expect((thrown as UnsupportedCurrencyPairError).name).toBe('UnsupportedCurrencyPairError')
    expect(() =>
      applyVndPerUsdRate(dec(100), 'VND', 'JPY' as unknown as Currency, dec(25000)),
    ).toThrow(UnsupportedCurrencyPairError)
  })

  it('throws on a non-positive rate', () => {
    expect(() => applyVndPerUsdRate(dec(100), 'USD', 'VND', dec(0))).toThrow(RangeError)
    expect(() => applyVndPerUsdRate(dec(100), 'VND', 'USD', dec('-0.5'))).toThrow(RangeError)
  })
})
