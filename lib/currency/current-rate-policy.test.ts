import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  FxUnavailableError,
  MAX_FALLBACK_STALENESS_MS,
  getUsableCurrentRate,
  isFxUnavailableError,
} from './current-rate-policy'
import type { ExchangeRateProvider } from './provider'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every test injects a fake provider and
 * `afterEach` deletes the pair's rows, so repeated runs stay identical and no
 * test ever reaches the network (asserted explicitly in the last case below).
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

/** Stands in for a live provider outage: the only path into the fallback. */
const failingProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider down')
  },
  getHistoricalRate: async () => null,
}

function workingProvider(rate = 25000, source = 'fake'): ExchangeRateProvider {
  return {
    getLatestRate: async () => ({
      rate,
      effectiveDate: new Date(),
      fetchedAt: new Date(),
      source,
    }),
    getHistoricalRate: async () => null,
  }
}

async function seedRate(fields: {
  // A string or `Decimal` seeds a rate at the column's full `Decimal(18, 6)`
  // scale — digits a double could not have carried in the first place.
  rate: number | string | Prisma.Decimal
  effectiveDate: Date
  fetchedAt: Date
  source: string
}) {
  await prisma.exchangeRate.create({
    data: { base: PAIR.base, quote: PAIR.quote, ...fields },
  })
}

async function cleanupRatesFor(pair: typeof PAIR) {
  await prisma.exchangeRate.deleteMany({ where: { base: pair.base, quote: pair.quote } })
}

describe('getUsableCurrentRate', () => {
  let fetchSpy: MockInstance
  let warnSpy: MockInstance

  beforeEach(() => {
    // Enforcing, not merely observing: any accidental network access inside the
    // policy or the provider fails the test that caused it.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access in test')
    })
    // Silenced so the fallback cases keep the suite's output pristine.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupRatesFor(PAIR)
  })

  it('returns a fresh rate with isFallback=false when the provider is available', async () => {
    const result = await getUsableCurrentRate(PAIR, workingProvider())

    expect(result.rate).toBe(25000)
    expect(result.source).toBe('fake')
    expect(result.isFallback).toBe(false)
    // Every consumer doing money arithmetic reads `rateDecimal`, so it must be
    // present and equal to the boundary number on the fresh path too.
    expect(result.rateDecimal).toBeInstanceOf(Prisma.Decimal)
    expect(result.rateDecimal.equals(new Prisma.Decimal(result.rate))).toBe(true)
  })

  it('serves rateDecimal from the cached row on a cache hit, at the stored scale', async () => {
    // A rate with more precision than a "nice" number: the point of carrying a
    // Decimal is that these digits survive.
    const today = new Date()
    await seedRate({
      rate: 25123.456789,
      effectiveDate: new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
      ),
      fetchedAt: today,
      source: 'cached-fake',
    })

    const result = await getUsableCurrentRate(PAIR, failingProvider)

    // Today's cache is a *hit*, not a fallback: the provider is never reached.
    expect(result.isFallback).toBe(false)
    expect(result.source).toBe('cached-fake')
    expect(result.rateDecimal.equals(new Prisma.Decimal('25123.456789'))).toBe(true)
    expect(result.rateDecimal.equals(new Prisma.Decimal(result.rate))).toBe(true)
  })

  it('falls back to a recent last-known-good current rate (within 48h) with isFallback=true, preserving its original fetchedAt', async () => {
    const recentFetchedAt = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
    await seedRate({
      rate: 25000,
      effectiveDate: recentFetchedAt,
      fetchedAt: recentFetchedAt,
      source: 'fresh-fake',
    })

    const result = await getUsableCurrentRate(PAIR, failingProvider)

    expect(result.rate).toBe(25000)
    // The row's real timestamps survive the fallback untouched — the UI shows
    // when the rate was actually from, never "now".
    expect(result.fetchedAt.toISOString()).toBe(recentFetchedAt.toISOString())
    expect(result.effectiveDate.toISOString()).toBe(recentFetchedAt.toISOString())
    expect(result.source).toBe('cache-fallback:fresh-fake')
    expect(result.isFallback).toBe(true)
    // The fallback's Decimal is the row's own `Decimal(18, 6)`, not a value
    // reconstructed from the widened number.
    expect(result.rateDecimal).toBeInstanceOf(Prisma.Decimal)
    expect(result.rateDecimal.equals(new Prisma.Decimal(result.rate))).toBe(true)
  })

  it("takes the fallback's Decimal off the row itself, at a scale no double can hold", async () => {
    // 18 significant digits — the full width of `Decimal(18, 6)`. A double
    // keeps 17, so `Number(row.rate)` is already 123456789012.12346 by the time
    // anyone looks at it: this value can only survive if `rateDecimal` is the
    // row's own Decimal and was never round-tripped through a number.
    const exact = '123456789012.123456'
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await seedRate({
      rate: exact,
      effectiveDate: twoHoursAgo,
      fetchedAt: twoHoursAgo,
      source: 'precise-fake',
    })

    const result = await getUsableCurrentRate(PAIR, failingProvider)

    expect(result.isFallback).toBe(true)
    expect(result.rateDecimal.toString()).toBe(exact)
    // The boundary number really has lost a digit — which is exactly why no
    // conversion may use it.
    expect(new Prisma.Decimal(result.rate).toString()).toBe('123456789012.12346')
  })

  it('rejects a stale cached fallback older than the freshness window', async () => {
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
    await seedRate({
      rate: 20000,
      effectiveDate: staleDate,
      fetchedAt: staleDate,
      source: 'stale-fake',
    })

    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })

  it('does not let a historical-lookup cache entry qualify as a current fallback, even if freshly fetched', async () => {
    // Simulates what getHistoricalRate would cache for an Account Balance Over
    // Time point about a date years in the past. fetchedAt is "just now," but
    // effectiveDate is genuinely ancient — the filter must key off
    // effectiveDate, not fetchedAt, or this would wrongly pass.
    await seedRate({
      rate: 23000,
      effectiveDate: new Date('2020-01-01'),
      fetchedAt: new Date(),
      source: 'historical-fake',
    })

    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })

  it('throws FxUnavailableError when the provider fails and no usable cached rate exists at all', async () => {
    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)

    const thrown = await getUsableCurrentRate(PAIR, failingProvider).catch((e: unknown) => e)
    expect(isFxUnavailableError(thrown)).toBe(true)
    expect((thrown as FxUnavailableError).name).toBe('FxUnavailableError')
    expect(isFxUnavailableError(new Error('something else'))).toBe(false)
  })

  it('accepts a fallback one minute inside the 48h window and rejects one a minute outside it', async () => {
    const oneMinute = 60 * 1000
    const insideWindow = new Date(Date.now() - MAX_FALLBACK_STALENESS_MS + oneMinute)
    await seedRate({
      rate: 24800,
      effectiveDate: insideWindow,
      fetchedAt: insideWindow,
      source: 'edge-fake',
    })

    const accepted = await getUsableCurrentRate(PAIR, failingProvider)
    expect(accepted.rate).toBe(24800)
    expect(accepted.isFallback).toBe(true)

    await cleanupRatesFor(PAIR)

    const outsideWindow = new Date(Date.now() - MAX_FALLBACK_STALENESS_MS - oneMinute)
    await seedRate({
      rate: 24700,
      effectiveDate: outsideWindow,
      fetchedAt: outsideWindow,
      source: 'edge-fake',
    })

    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })

  it('picks the newest qualifying row by effectiveDate, ignoring a freshly fetched historical row', async () => {
    const older = new Date(Date.now() - 30 * 60 * 60 * 1000) // 30 hours ago, still inside 48h
    const newer = new Date(Date.now() - 3 * 60 * 60 * 1000) // 3 hours ago
    // Freshest fetchedAt of the three, but years out of date: excluded by the
    // effectiveDate window, not by the ordering.
    await seedRate({
      rate: 23000,
      effectiveDate: new Date('2020-01-01'),
      fetchedAt: new Date(),
      source: 'historical-fake',
    })
    await seedRate({ rate: 24000, effectiveDate: older, fetchedAt: older, source: 'older' })
    await seedRate({ rate: 25000, effectiveDate: newer, fetchedAt: newer, source: 'newer' })

    const result = await getUsableCurrentRate(PAIR, failingProvider)

    // Two rows qualify; `orderBy effectiveDate desc` is what makes the more
    // recent one win.
    expect(result.rate).toBe(25000)
    expect(result.source).toBe('cache-fallback:newer')
    expect(result.effectiveDate.toISOString()).toBe(newer.toISOString())
    expect(result.isFallback).toBe(true)
  })

  it('warns exactly once when a fallback is used, and never on the live path', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await seedRate({ rate: 25000, effectiveDate: recent, fetchedAt: recent, source: 'fresh-fake' })

    await getUsableCurrentRate(PAIR, workingProvider())
    expect(warnSpy).not.toHaveBeenCalled()

    await cleanupRatesFor(PAIR)
    await seedRate({ rate: 25000, effectiveDate: recent, fetchedAt: recent, source: 'fresh-fake' })

    await getUsableCurrentRate(PAIR, failingProvider)

    // One line through `lib/server/log.ts`: a level, a timestamp and the fixed
    // event name — and still nothing about the provider, the pair or the rate.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = warnSpy.mock.calls[0][0] as string
    expect(warnSpy.mock.calls[0]).toHaveLength(1)
    expect(line).toContain('fx.live_rate_fallback')
    expect(line).toContain('WARN')
    // Restores the original assertion's intent (fix round, promoted minor):
    // structured logging changed the shape of this line, but the guarantee it
    // protects — no rate, no provider source and no URL ever reach the log —
    // must still be checked, not just implied by the event name matching.
    expect(line).not.toContain('http')
    expect(line).not.toContain('25000')
    expect(line).not.toContain('fresh-fake')
  })

  it('attaches the underlying failure as the error cause when nothing is usable', async () => {
    const thrown = await getUsableCurrentRate(PAIR, failingProvider).catch((e: unknown) => e)

    expect(isFxUnavailableError(thrown)).toBe(true)
    expect((thrown as FxUnavailableError).cause).toBeInstanceOf(Error)
    expect(((thrown as FxUnavailableError).cause as Error).message).toBe('provider down')
  })

  it('ignores a cached row whose effectiveDate is in the future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000) // 1 hour ahead
    await seedRate({
      rate: 26000,
      effectiveDate: future,
      fetchedAt: new Date(),
      source: 'future-fake',
    })

    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)
  })

  it('returns a live rate with isFallback=false once the provider recovers after a fallback', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await seedRate({
      rate: 25000,
      effectiveDate: recent,
      fetchedAt: recent,
      source: 'fresh-fake',
    })

    const degraded = await getUsableCurrentRate(PAIR, failingProvider)
    expect(degraded.isFallback).toBe(true)

    const recovered = await getUsableCurrentRate(PAIR, workingProvider(25300, 'recovered-fake'))

    expect(recovered.rate).toBe(25300)
    expect(recovered.source).toBe('recovered-fake')
    expect(recovered.isFallback).toBe(false)
  })

  it('never reaches the network: every path runs off the injected provider and the cache', async () => {
    await getUsableCurrentRate(PAIR, workingProvider())
    await cleanupRatesFor(PAIR)

    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000)
    await seedRate({ rate: 25000, effectiveDate: recent, fetchedAt: recent, source: 'fresh-fake' })
    await getUsableCurrentRate(PAIR, failingProvider)
    await cleanupRatesFor(PAIR)

    await expect(getUsableCurrentRate(PAIR, failingProvider)).rejects.toThrow(FxUnavailableError)

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
