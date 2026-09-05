import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { getLatestRate, getHistoricalRate } from './fx-service'
import type { ExchangeRateProvider, RateResult } from './provider'

/**
 * Hits the real database — `vitest.setup.ts` points `DATABASE_URL` at the
 * dedicated `cashflow_test` database. Every test injects a fake provider and
 * `afterEach` deletes the pair's rows, so repeated runs stay identical and no
 * test ever reaches the network (asserted explicitly in the first case below).
 */

const PAIR = { base: 'USD' as const, quote: 'VND' as const }

async function cleanupRatesFor(pair: typeof PAIR) {
  await prisma.exchangeRate.deleteMany({ where: { base: pair.base, quote: pair.quote } })
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/** A provider that fails the test if anything reaches it. */
const forbiddenProvider: ExchangeRateProvider = {
  getLatestRate: async () => {
    throw new Error('provider must not be called')
  },
  getHistoricalRate: async () => {
    throw new Error('provider must not be called')
  },
}

describe('getLatestRate', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupRatesFor(PAIR)
  })

  it('fetches from the provider and caches under today when nothing is cached', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({
        rate: 25000,
        effectiveDate: new Date(),
        fetchedAt: new Date(),
        source: 'fake',
      }),
      getHistoricalRate: async () => null,
    }

    const result = await getLatestRate(PAIR, fakeProvider)

    expect(result.rate).toBe(25000)
    const cached = await prisma.exchangeRate.findFirst({
      where: { base: PAIR.base, quote: PAIR.quote },
    })
    expect(cached).not.toBeNull()
    expect(Number(cached?.rate)).toBe(25000)
    // The injected fake is the only thing consulted: nothing in this suite
    // touches the real FX endpoint.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns the cached value for today without calling the provider again', async () => {
    let callCount = 0
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => {
        callCount += 1
        return { rate: 25500, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }
      },
      getHistoricalRate: async () => null,
    }

    await getLatestRate(PAIR, fakeProvider)
    await getLatestRate(PAIR, fakeProvider)

    expect(callCount).toBe(1)
  })

  it("returns the cached row's own fetchedAt and source on a hit, not fresh values", async () => {
    const fetchedAt = new Date('2026-09-05T01:02:03.000Z')
    await prisma.exchangeRate.create({
      data: {
        base: PAIR.base,
        quote: PAIR.quote,
        rate: 24750.5,
        effectiveDate: utcDay(new Date()),
        fetchedAt,
        source: 'cached-source',
      },
    })

    const result = await getLatestRate(PAIR, forbiddenProvider)

    expect(result.rate).toBe(24750.5)
    expect(result.fetchedAt.getTime()).toBe(fetchedAt.getTime())
    expect(result.source).toBe('cached-source')
    expect(result.effectiveDate.getTime()).toBe(utcDay(new Date()).getTime())
  })

  it("returns the provider's rate on a miss with its effective day normalised, matching a cache hit", async () => {
    // The provider's `time_last_update_utc` is not necessarily today: shortly
    // after 00:00 UTC it still reports yesterday. The row is keyed by the day
    // the rate is actually effective for.
    //
    // The returned `effectiveDate` is that day's UTC start, not the raw
    // publication instant, because a cache *hit* can only ever return the
    // day-start (it is the row's natural key) — returning the raw instant on a
    // miss would make the same rate look like two different facts depending on
    // whether it happened to be cached, and `Transaction.fxRateEffectiveAt`
    // would then be inconsistent across rows. The provider publishes one rate
    // per day, so the day *is* the rate's identity; the exact moment we
    // retrieved it is preserved separately and untouched in `fetchedAt`.
    const effectiveDate = new Date('2026-09-04T22:15:30.000Z')
    const fetchedAt = new Date('2026-09-05T00:04:00.000Z')
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({ rate: 25123.25, effectiveDate, fetchedAt, source: 'fake' }),
      getHistoricalRate: async () => null,
    }

    const result = await getLatestRate(PAIR, fakeProvider)

    expect(result.rate).toBe(25123.25)
    expect(result.effectiveDate.getTime()).toBe(Date.UTC(2026, 8, 4))
    // Ours, not the rate's: never normalised, never replaced with "now".
    expect(result.fetchedAt.getTime()).toBe(fetchedAt.getTime())

    const rows = await prisma.exchangeRate.findMany({
      where: { base: PAIR.base, quote: PAIR.quote },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].effectiveDate.getTime()).toBe(Date.UTC(2026, 8, 4))
    // What the caller got is exactly what a later hit on the same row returns.
    expect(result.effectiveDate.getTime()).toBe(rows[0].effectiveDate.getTime())
  })

  it('upserts rather than failing when a second fetch lands on an already cached day', async () => {
    // Same setup as above: the provider stays on the previous UTC day, so the
    // "today" lookup misses on every call and `cacheRate` writes twice to the
    // same natural key. The second write must update, not violate the unique
    // constraint. (Accepted behaviour — Task 8's fallback covers outages.)
    const effectiveDate = new Date('2026-09-04T22:15:30.000Z')
    const results: RateResult[] = [
      { rate: 25000, effectiveDate, fetchedAt: new Date('2026-09-05T00:04:00.000Z'), source: 'a' },
      { rate: 25100, effectiveDate, fetchedAt: new Date('2026-09-05T00:09:00.000Z'), source: 'b' },
    ]
    let callCount = 0
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => results[callCount++],
      getHistoricalRate: async () => null,
    }

    await getLatestRate(PAIR, fakeProvider)
    await getLatestRate(PAIR, fakeProvider)

    expect(callCount).toBe(2)
    const rows = await prisma.exchangeRate.findMany({
      where: { base: PAIR.base, quote: PAIR.quote },
    })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].rate)).toBe(25100)
    expect(rows[0].fetchedAt.getTime()).toBe(new Date('2026-09-05T00:09:00.000Z').getTime())
    expect(rows[0].source).toBe('b')
  })
})

describe('getHistoricalRate', () => {
  afterEach(() => cleanupRatesFor(PAIR))

  it('returns null when the provider has no historical data, without caching anything', async () => {
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({
        rate: 25000,
        effectiveDate: new Date(),
        fetchedAt: new Date(),
        source: 'fake',
      }),
      getHistoricalRate: async () => null,
    }

    const result = await getHistoricalRate(PAIR, new Date('2020-01-01'), fakeProvider)

    expect(result).toBeNull()
    const cached = await prisma.exchangeRate.findFirst({
      where: { base: PAIR.base, quote: PAIR.quote },
    })
    expect(cached).toBeNull()
  })

  it('normalises a miss to the requested UTC day, so a hit and a miss return the same effectiveDate', async () => {
    // Same rule as `getLatestRate`: the cache row is keyed by the UTC day, so a
    // hit can only ever return the day-start. A provider that answers with its
    // own publication instant — or with the nearest prior trading day, which is
    // standard FX behaviour and is cached under the *requested* day (spec §6.2)
    // — must not make the same rate look like two different facts depending on
    // whether it happened to be cached. Phase 3's `historicalAmountIn` consumes
    // this value.
    const requested = new Date('2020-01-01T13:45:00.000Z')
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => {
        throw new Error('provider must not be called')
      },
      getHistoricalRate: async () => ({
        rate: 24000,
        effectiveDate: new Date('2019-12-31T21:30:00.000Z'),
        fetchedAt: new Date('2026-09-05T10:00:00.000Z'),
        source: 'fake-historical',
      }),
    }

    const miss = await getHistoricalRate(PAIR, requested, fakeProvider)
    const hit = await getHistoricalRate(PAIR, requested, forbiddenProvider)

    expect(miss?.effectiveDate.getTime()).toBe(Date.UTC(2020, 0, 1))
    expect(hit?.effectiveDate.getTime()).toBe(Date.UTC(2020, 0, 1))
    // `fetchedAt` is ours and is never normalised or replaced with "now".
    expect(miss?.fetchedAt.getTime()).toBe(new Date('2026-09-05T10:00:00.000Z').getTime())

    const rows = await prisma.exchangeRate.findMany({
      where: { base: PAIR.base, quote: PAIR.quote },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].effectiveDate.getTime()).toBe(Date.UTC(2020, 0, 1))
  })

  it('caches a historical rate once retrieved and reuses it on the next call', async () => {
    let callCount = 0
    const fakeProvider: ExchangeRateProvider = {
      getLatestRate: async () => ({
        rate: 25000,
        effectiveDate: new Date(),
        fetchedAt: new Date(),
        source: 'fake',
      }),
      getHistoricalRate: async (_pair, date) => {
        callCount += 1
        return {
          rate: 24000,
          effectiveDate: date,
          fetchedAt: new Date(),
          source: 'fake-historical',
        }
      },
    }
    const date = new Date('2020-01-01')

    const first = await getHistoricalRate(PAIR, date, fakeProvider)
    const second = await getHistoricalRate(PAIR, date, fakeProvider)

    expect(first?.rate).toBe(24000)
    expect(second?.rate).toBe(24000)
    expect(callCount).toBe(1)
  })

  it('never calls the provider when the day is already cached', async () => {
    const date = new Date('2019-06-15T18:30:00.000Z')
    const fetchedAt = new Date('2019-06-16T02:00:00.000Z')
    await prisma.exchangeRate.create({
      data: {
        base: PAIR.base,
        quote: PAIR.quote,
        rate: 23200.125,
        effectiveDate: new Date(Date.UTC(2019, 5, 15)),
        fetchedAt,
        source: 'seeded',
      },
    })

    const result = await getHistoricalRate(PAIR, date, forbiddenProvider)

    expect(result?.rate).toBe(23200.125)
    expect(result?.source).toBe('seeded')
    expect(result?.fetchedAt.getTime()).toBe(fetchedAt.getTime())
    expect(result?.effectiveDate.getTime()).toBe(Date.UTC(2019, 5, 15))
  })
})
