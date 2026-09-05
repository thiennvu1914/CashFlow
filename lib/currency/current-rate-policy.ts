import { prisma } from '@/lib/prisma'
import { getLatestRate } from './fx-service'
import type { CurrencyPair, ExchangeRateProvider, RateResult } from './provider'

/**
 * The one current-rate policy for the whole application (spec §6.3, generalised
 * to every current-position use): today's cache → live provider → a recent
 * last-known-good current rate → refusal. Historical activity (a Transaction's
 * FX snapshot) and historical position points (`getHistoricalRate`) never come
 * through here.
 */

export class FxUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      'Unable to retrieve an exchange rate and no sufficiently recent cached rate is available. Please try again shortly.',
      options,
    )
    this.name = 'FxUnavailableError'
  }
}

/**
 * Narrows an unknown caught value to `FxUnavailableError` so server actions and
 * UI boundaries can distinguish "FX is temporarily unavailable, tell the user
 * to retry" from a genuine bug, without importing the class into a `catch`
 * type test.
 *
 * Callers must map this to an i18n message key of their own — never render
 * `e.message`. That string is English and exists for logs and developers;
 * Phase 7 localises what the user sees.
 */
export function isFxUnavailableError(e: unknown): e is FxUnavailableError {
  return e instanceof FxUnavailableError
}

export interface UsableRateResult extends RateResult {
  /**
   * When the rate itself applies — for a fallback this is the original row's
   * `effectiveDate`, never "now". (Inherited from `RateResult`, restated here
   * because the distinction matters to callers rendering a staleness notice.)
   */
  effectiveDate: Date
  /**
   * When we retrieved that rate from the provider — again the original row's
   * value on a fallback. `effectiveDate` is the rate's own time; `fetchedAt` is
   * ours.
   */
  fetchedAt: Date
  /** true when a stale-but-accepted last-known-good current rate was used because the live
   *  provider was unavailable — surfaced to the UI as "rate may be out of date". */
  isFallback: boolean
}

/** A cached rate older than this is not trusted as a "current" fallback — a temporary outage
 * is measured in hours, not days; beyond this window it's more honest to fail than to pretend
 * a stale figure still represents reality. */
export const MAX_FALLBACK_STALENESS_MS = 48 * 60 * 60 * 1000

/**
 * The newest cached rate for `pair` that is still defensible as "current".
 *
 * The window is checked against `effectiveDate`, not `fetchedAt`: a row cached
 * by `getHistoricalRate` for a chart point in 2020 has a `fetchedAt` of minutes
 * ago while the rate it holds is years old, and only an `effectiveDate` filter
 * excludes it. Rows dated in the future are excluded too — a clock skew or a
 * bad provider timestamp must not out-rank a real recent rate.
 */
async function getLastKnownGoodCurrentRate(pair: CurrencyPair): Promise<RateResult | null> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - MAX_FALLBACK_STALENESS_MS)
  const candidate = await prisma.exchangeRate.findFirst({
    where: { base: pair.base, quote: pair.quote, effectiveDate: { gte: cutoff, lte: now } },
    orderBy: [{ effectiveDate: 'desc' }, { fetchedAt: 'desc' }],
  })
  if (!candidate) return null
  return {
    // `candidate.rate` is a Prisma `Decimal`; `RateResult.rate` is the provider
    // boundary's plain number, so the stored decimal is widened back here.
    rate: Number(candidate.rate),
    effectiveDate: candidate.effectiveDate,
    fetchedAt: candidate.fetchedAt,
    source: candidate.source,
  }
}

/**
 * A rate for `pair` that is safe to use for a *current* figure, or a refusal.
 *
 * In order: today's cache, then a live provider lookup (both of which are
 * `getLatestRate`), then the newest cached current rate no older than
 * `MAX_FALLBACK_STALENESS_MS` — returned with `isFallback: true`, its original
 * `effectiveDate`/`fetchedAt`, and its source tagged `cache-fallback:<source>`
 * so the UI can say the figure may be out of date. When nothing qualifies this
 * throws `FxUnavailableError` rather than inventing a rate.
 */
export async function getUsableCurrentRate(
  pair: CurrencyPair,
  providerOverride?: ExchangeRateProvider,
): Promise<UsableRateResult> {
  let fresh: RateResult
  try {
    fresh = await getLatestRate(pair, providerOverride)
  } catch (cause) {
    // Only the lookup failure is swallowed. Anything the fallback query itself
    // throws (a database error) is a real fault and propagates untouched.
    const fallback = await getLastKnownGoodCurrentRate(pair)
    if (!fallback) throw new FxUnavailableError({ cause })
    // A fixed string: never the provider error payload, a rate, or a URL —
    // logs must stay free of financial data and provider credentials.
    console.warn('FX live rate lookup failed; using cached fallback rate')
    return { ...fallback, source: `cache-fallback:${fallback.source}`, isFallback: true }
  }
  return { ...fresh, isFallback: false }
}
