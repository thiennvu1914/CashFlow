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

function toRateResult(cached: {
  rate: unknown
  effectiveDate: Date
  fetchedAt: Date
  source: string
}): RateResult {
  // `cached.rate` is a Prisma `Decimal`; `RateResult.rate` is the provider
  // boundary's plain number, so the stored decimal is widened back here.
  return {
    rate: Number(cached.rate),
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
): Promise<RateResult> {
  const today = startOfUtcDay(new Date())
  const cached = await findCached(pair, today)
  if (cached) return toRateResult(cached)

  const provider = providerOverride ?? defaultProvider
  const fresh = await provider.getLatestRate(pair)
  const effectiveDate = startOfUtcDay(fresh.effectiveDate)
  await cacheRate(pair, effectiveDate, fresh)
  return { ...fresh, effectiveDate }
}

/**
 * The rate for `pair` on the UTC day containing `date`, or `null` when neither
 * the cache nor the provider has one. Historical rows are cached permanently:
 * a past day's rate is a fact that never changes.
 *
 * `null` is a real answer — callers must render a gap rather than substitute
 * the live rate (spec §6.1/§6.4).
 */
export async function getHistoricalRate(
  pair: CurrencyPair,
  date: Date,
  providerOverride?: ExchangeRateProvider,
): Promise<RateResult | null> {
  const effectiveDate = startOfUtcDay(date)
  const cached = await findCached(pair, effectiveDate)
  if (cached) return toRateResult(cached)

  const provider = providerOverride ?? defaultProvider
  const fetched = await provider.getHistoricalRate(pair, effectiveDate)
  if (!fetched) return null
  await cacheRate(pair, effectiveDate, fetched)
  return fetched
}
