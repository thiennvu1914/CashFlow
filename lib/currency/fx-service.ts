import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { CurrencyPair, ExchangeRateProvider, RateResult } from './provider'
import { OpenErApiProvider } from './open-er-api-provider'

/**
 * Cache-backed FX lookups (spec §6.2).
 *
 * `ExchangeRate` rows are keyed by `(base, quote, effectiveDate)`, where
 * `effectiveDate` is always the UTC start of the day the rate applies to. A
 * cached row is returned verbatim — its own `rate`, `effectiveDate`,
 * `fetchedAt` and `source` — and a miss returns exactly what the provider
 * returned. Nothing here ever substitutes `new Date()` for a provider
 * timestamp, invents a rate, or falls back to 1.
 */

const defaultProvider = new OpenErApiProvider()

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

async function findCached(pair: CurrencyPair, effectiveDate: Date) {
  return prisma.exchangeRate.findUnique({
    where: {
      base_quote_effectiveDate: { base: pair.base, quote: pair.quote, effectiveDate },
    },
  })
}

async function cacheRate(pair: CurrencyPair, effectiveDate: Date, result: RateResult) {
  // The provider boundary hands us a plain `number`; the column is
  // `Decimal(18, 6)` and Prisma serialises the number's shortest decimal
  // representation into it. Nothing downstream reads this value as a float.
  await prisma.exchangeRate.upsert({
    where: {
      base_quote_effectiveDate: { base: pair.base, quote: pair.quote, effectiveDate },
    },
    create: {
      base: pair.base,
      quote: pair.quote,
      effectiveDate,
      rate: result.rate,
      fetchedAt: result.fetchedAt,
      source: result.source,
    },
    // A later fetch for a day already cached refreshes it rather than
    // colliding with the unique constraint.
    update: { rate: result.rate, fetchedAt: result.fetchedAt, source: result.source },
  })
}

/**
 * A rate result that also carries the value as a `Decimal`.
 *
 * `RateResult.rate` is the provider boundary's plain `number` and stays exactly
 * that — existing callers and the `ExchangeRateProvider` contract are
 * unchanged. `rateDecimal` is the same rate as money arithmetic needs it: on a
 * cache hit it is the stored `Decimal(18, 6)` itself, never a value rebuilt
 * from the widened number, so no digit can be lost on the way to a conversion.
 */
export interface CachedRateResult extends RateResult {
  rateDecimal: Prisma.Decimal
}

function toRateResult(cached: {
  rate: Prisma.Decimal
  effectiveDate: Date
  fetchedAt: Date
  source: string
}): CachedRateResult {
  // `cached.rate` is a Prisma `Decimal`; `RateResult.rate` is the provider
  // boundary's plain number, so the stored decimal is widened back here — and
  // the untouched Decimal travels alongside it for anything doing arithmetic.
  return {
    rate: Number(cached.rate),
    rateDecimal: cached.rate,
    effectiveDate: cached.effectiveDate,
    fetchedAt: cached.fetchedAt,
    source: cached.source,
  }
}

/**
 * Today's rate for `pair`, served from the cache when the current UTC day is
 * already stored and fetched from the provider otherwise.
 *
 * The fetched row is keyed by the provider's own effective day, not by
 * "today". open.er-api.com's `time_last_update_utc` lags the calendar: shortly
 * after 00:00 UTC it still reports yesterday, so the row lands on yesterday,
 * today's cache stays empty, and every call goes to the provider until it
 * rolls over. That is accepted — the alternative is filing yesterday's rate
 * under today's date, and Task 8's `getUsableCurrentRate` fallback is what
 * covers provider outages during that window.
 *
 * A miss returns the provider's rate with its `effectiveDate` normalised to
 * that day's UTC start — the same value a later cache *hit* on the row returns,
 * because the day is the row's natural key. Without the normalisation the very
 * same rate would look like two different facts depending on whether it
 * happened to be cached, and `Transaction.fxRateEffectiveAt` would be
 * inconsistent from row to row. The provider publishes one rate per day, so the
 * day *is* the rate's identity; `fetchedAt` — the moment *we* retrieved it — is
 * passed through untouched, and nothing here ever substitutes `new Date()`.
 */
export async function getLatestRate(
  pair: CurrencyPair,
  providerOverride?: ExchangeRateProvider,
): Promise<CachedRateResult> {
  const today = startOfUtcDay(new Date())
  const cached = await findCached(pair, today)
  if (cached) return toRateResult(cached)

  const provider = providerOverride ?? defaultProvider
  const fresh = await provider.getLatestRate(pair)
  const effectiveDate = startOfUtcDay(fresh.effectiveDate)
  await cacheRate(pair, effectiveDate, fresh)
  // decimal.js parses the number's shortest decimal representation — the same
  // digits the provider sent, and the same ones just written to the cache.
  return { ...fresh, effectiveDate, rateDecimal: new Prisma.Decimal(fresh.rate) }
}

/**
 * The rate for `pair` on the UTC day containing `date`, or `null` when neither
 * the cache nor the provider has one. Historical rows are cached permanently:
 * a past day's rate is a fact that never changes.
 *
 * `null` is a real answer — callers must render a gap rather than substitute
 * the live rate (spec §6.1/§6.4).
 *
 * Same normalisation as `getLatestRate`: the returned `effectiveDate` is always
 * the requested UTC day, which is also the key the row is cached under, so a
 * hit and a miss answer identically. A provider may reply with its own
 * publication instant, or with the nearest prior trading day for a weekend or
 * holiday (standard FX behaviour, cached under the *requested* day — spec
 * §6.2); without this, the same rate would look like two different facts
 * depending on whether it happened to be cached already. `fetchedAt` and
 * `source` are passed through untouched.
 *
 * Like `getLatestRate`, the result carries `rateDecimal` alongside the boundary
 * `number`: on a hit it is the stored `Decimal(18, 6)` itself, on a miss the
 * Decimal built from the number just written to the cache. Historical money
 * arithmetic — Phase 4's balance-over-time points — reads that, never `rate`,
 * so an 18-significant-digit rate survives the trip intact.
 */
export async function getHistoricalRate(
  pair: CurrencyPair,
  date: Date,
  providerOverride?: ExchangeRateProvider,
): Promise<CachedRateResult | null> {
  const effectiveDate = startOfUtcDay(date)
  const cached = await findCached(pair, effectiveDate)
  if (cached) return toRateResult(cached)

  const provider = providerOverride ?? defaultProvider
  const fetched = await provider.getHistoricalRate(pair, effectiveDate)
  if (!fetched) return null
  await cacheRate(pair, effectiveDate, fetched)
  return { ...fetched, effectiveDate, rateDecimal: new Prisma.Decimal(fetched.rate) }
}
