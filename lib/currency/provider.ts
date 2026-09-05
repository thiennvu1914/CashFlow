export type Currency = 'VND' | 'USD'
export type CurrencyPair = { base: Currency; quote: Currency }

export interface RateResult {
  /**
   * The rate as returned by the provider at the API boundary, expressed as a
   * plain JSON `number`. This value is provider-boundary only: once it
   * crosses into persistence it is stored as a Prisma `Decimal(18,6)`, and
   * every financial computation downstream operates on `Decimal`, never on
   * this `number` directly.
   */
  rate: number
  effectiveDate: Date
  fetchedAt: Date
  source: string
}

export interface ExchangeRateProvider {
  getLatestRate(pair: CurrencyPair): Promise<RateResult>
  getHistoricalRate(pair: CurrencyPair, date: Date): Promise<RateResult | null>
}
