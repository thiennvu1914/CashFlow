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

/** The UTC start of the day containing `date` — the `ExchangeRate` cache key. */
export function startOfUtcDay(date: Date): Date {
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

/*
 * Per-process memo in front of `getLatestRate` (the app runs as one long-lived
 * Node process, and every lookup it saves is a ~100 ms database round trip or
 * a provider call on the transaction-create path).
 *
 * It only ever holds an answer `getLatestRate` itself returned, and hands back
 * a copy of exactly that — same `rate`, `rateDecimal`, `effectiveDate`,
 * `fetchedAt` and `source` — so a memoised answer is indistinguishable from
 * the uncached one. Two kinds of answer are kept:
 *
 * - today's cached row, until that UTC day ends: `getLatestRate` only writes
 *   it while it is missing, so it changes at most when two first-of-the-day
 *   misses race and the second upsert overwrites the first — and either way
 *   the memo holds a real provider answer for that day, as it was read back;
 * - a provider answer whose effective day is *before* today (the provider has
 *   not rolled over yet), for `LAGGING_RATE_MEMO_MS`. A provider answer *for*
 *   today is not memoised: the next call reads the row it was cached as, and
 *   memoises that hit — so every later answer is the stored `Decimal(18, 6)`,
 *   exactly what the uncached path would read back.
 *
 * A failed provider call is remembered separately, for
 * `PROVIDER_FAILURE_MEMO_MS`, so `getUsableCurrentRate` can go straight to its
 * last-known-good fallback instead of making every request wait out the
 * provider timeout during an outage. A successful call — say one that was
 * already in flight when another request's call failed — ends that early: the
 * provider is demonstrably up again.
 *
 * An injected `providerOverride` bypasses all of it, reads and writes alike —
 * a fake provider's answers must never be served to a later caller.
 */
const LAGGING_RATE_MEMO_MS = 10 * 60 * 1000
const PROVIDER_FAILURE_MEMO_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const latestRateMemo = new Map<string, { result: CachedRateResult; expiresAt: number }>()
const providerFailedUntil = new Map<string, number>()

function pairKey(pair: CurrencyPair): string {
  return `${pair.base}/${pair.quote}`
}

function latestRateMemoKey(pair: CurrencyPair, today: Date): string {
  return `${pairKey(pair)}/${today.toISOString().slice(0, 10)}`
}

/** A fresh object and fresh Dates per caller: one request mutating its answer
 * must not change what the next request is told. (`Decimal` is immutable.) */
function copyRateResult(result: CachedRateResult): CachedRateResult {
  return {
    ...result,
    effectiveDate: new Date(result.effectiveDate),
    fetchedAt: new Date(result.fetchedAt),
  }
}

function memoiseLatestRate(key: string, result: CachedRateResult, expiresAt: number) {
  // Keys carry the UTC day, so a past day's entry is never read again; drop
  // expired ones here to keep the map bounded in a long-lived process.
  const now = Date.now()
  for (const [staleKey, entry] of latestRateMemo) {
    if (entry.expiresAt <= now) latestRateMemo.delete(staleKey)
  }
  latestRateMemo.set(key, { result: copyRateResult(result), expiresAt })
}

/**
 * Whether the default provider failed for `pair` within the last
 * `PROVIDER_FAILURE_MEMO_MS` — read by `getUsableCurrentRate` before it calls
 * `getLatestRate`. Only a provider failure counts: a database error never
 * reaches the memo.
 */
export function hasRecentProviderFailure(pair: CurrencyPair): boolean {
  const until = providerFailedUntil.get(pairKey(pair))
  return until !== undefined && Date.now() < until
}

/** Forgets every memoised rate and provider failure. Test files that write or
 * delete `ExchangeRate` rows call this in their cleanup, because the memo would
 * otherwise outlive the rows it was read from. */
export function resetFxMemoForTests(): void {
  latestRateMemo.clear()
  providerFailedUntil.clear()
}

/**
 * Today's rate for `pair`, served from the cache when the current UTC day is
 * already stored and fetched from the provider otherwise — with the
 * per-process memo above in front of both, unless a provider is injected.
 *
 * The fetched row is keyed by the provider's own effective day, not by
 * "today". open.er-api.com's `time_last_update_utc` lags the calendar: shortly
 * after 00:00 UTC it still reports yesterday, so the row lands on yesterday,
 * today's cache stays empty, and the provider is asked again — at most once
 * per `LAGGING_RATE_MEMO_MS` — until it rolls over. That is accepted — the
 * alternative is filing yesterday's rate under today's date, and Task 8's
 * `getUsableCurrentRate` fallback is what covers provider outages during that
 * window.
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
  const useMemo = providerOverride === undefined
  const today = startOfUtcDay(new Date())
  const memoKey = latestRateMemoKey(pair, today)
  if (useMemo) {
    const memo = latestRateMemo.get(memoKey)
    if (memo && Date.now() < memo.expiresAt) return copyRateResult(memo.result)
  }

  const cached = await findCached(pair, today)
  if (cached) {
    const hit = toRateResult(cached)
    if (useMemo) memoiseLatestRate(memoKey, hit, today.getTime() + DAY_MS)
    return hit
  }

  const provider = providerOverride ?? defaultProvider
  let fresh: RateResult
  try {
    fresh = await provider.getLatestRate(pair)
  } catch (error) {
    if (useMemo) providerFailedUntil.set(pairKey(pair), Date.now() + PROVIDER_FAILURE_MEMO_MS)
    throw error
  }
  if (useMemo) providerFailedUntil.delete(pairKey(pair))
  const effectiveDate = startOfUtcDay(fresh.effectiveDate)
  await cacheRate(pair, effectiveDate, fresh)
  // decimal.js parses the number's shortest decimal representation — the same
  // digits the provider sent, and the same ones just written to the cache.
  const result = { ...fresh, effectiveDate, rateDecimal: new Prisma.Decimal(fresh.rate) }
  if (useMemo && effectiveDate.getTime() < today.getTime()) {
    memoiseLatestRate(memoKey, result, Date.now() + LAGGING_RATE_MEMO_MS)
  }
  return result
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

/** Same historical policy, with one cache read for all distinct requested days. */
export async function getHistoricalRates(
  pair: CurrencyPair,
  dates: Date[],
  providerOverride?: ExchangeRateProvider,
): Promise<Map<number, CachedRateResult | null>> {
  const days = [...new Set(dates.map((date) => startOfUtcDay(date).getTime()))]
  const result = new Map<number, CachedRateResult | null>()
  if (days.length === 0) return result
  const cached = await prisma.exchangeRate.findMany({
    where: {
      base: pair.base,
      quote: pair.quote,
      effectiveDate: { in: days.map((day) => new Date(day)) },
    },
  })
  for (const row of cached) result.set(row.effectiveDate.getTime(), toRateResult(row))
  const provider = providerOverride ?? defaultProvider
  await Promise.all(
    days
      .filter((day) => !result.has(day))
      .map(async (day) => {
        const effectiveDate = new Date(day)
        const fetched = await provider.getHistoricalRate(pair, effectiveDate)
        if (!fetched) {
          result.set(day, null)
          return
        }
        await cacheRate(pair, effectiveDate, fetched)
        result.set(day, {
          ...fetched,
          effectiveDate,
          rateDecimal: new Prisma.Decimal(fetched.rate),
        })
      }),
  )
  return result
}
