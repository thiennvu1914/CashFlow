import type { ExchangeRateProvider, CurrencyPair, RateResult } from './provider'

export const OPEN_ER_API_SOURCE = 'open.er-api.com'

interface OpenErApiLatestResponse {
  result?: string
  rates?: Record<string, number>
  time_last_update_utc?: string
}

/**
 * Adapter over open.er-api.com's free tier.
 *
 * Verified live on 2026-09-05 (Task 6, Ruling R-13):
 * - `GET /v6/latest/USD` returns `result: "success"`, a `rates.VND` number,
 *   and a `time_last_update_utc` string.
 * - `GET /v6/history/USD/2025/01/15` returns HTTP 404 — the free tier has no
 *   historical/date-based endpoint. `api.frankfurter.dev/v1/currencies` was
 *   also checked and does not list VND at all.
 *
 * `getHistoricalRate` therefore returns `null` unconditionally (spec
 * §6.1/§6.4): callers (Account Balance Over Time, Phase 4) must render a gap
 * for historical points rather than substitute the live rate or any other
 * fabricated value.
 */
export class OpenErApiProvider implements ExchangeRateProvider {
  private readonly baseUrl: string

  constructor(baseUrl = 'https://open.er-api.com/v6') {
    this.baseUrl = baseUrl
  }

  async getLatestRate(pair: CurrencyPair): Promise<RateResult> {
    const response = await fetch(`${this.baseUrl}/latest/${pair.base}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`FX provider request failed with status ${response.status}`)
    }

    const data = (await response.json()) as OpenErApiLatestResponse

    if (data.result !== 'success') {
      throw new Error(`FX provider returned a non-success result for ${pair.base}/${pair.quote}`)
    }

    const rate = data.rates?.[pair.quote]
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`FX provider returned no usable rate for ${pair.base}/${pair.quote}`)
    }

    if (!data.time_last_update_utc) {
      throw new Error('FX provider response is missing time_last_update_utc')
    }
    const effectiveDate = new Date(data.time_last_update_utc)
    if (Number.isNaN(effectiveDate.getTime())) {
      throw new Error('FX provider returned an invalid time_last_update_utc')
    }

    return {
      rate,
      effectiveDate,
      fetchedAt: new Date(),
      source: OPEN_ER_API_SOURCE,
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature fixed by ExchangeRateProvider
  async getHistoricalRate(_pair: CurrencyPair, _date: Date): Promise<RateResult | null> {
    // Verified during Task 6 Step 1 (2026-09-05): open.er-api.com's free tier
    // does not expose a historical-date endpoint (`/v6/history/...` returns
    // HTTP 404). Returning null without making a request is correct per spec
    // §6.1/§6.4 — callers must render a gap rather than substitute the live
    // rate or fabricate a value.
    return null
  }
}
