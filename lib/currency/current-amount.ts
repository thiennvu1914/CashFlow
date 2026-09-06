import { Prisma } from '@prisma/client'
import { applyVndPerUsdRate, assertSupportedPair } from './apply-rate'
import { getUsableCurrentRate } from './current-rate-policy'
import type { Currency, ExchangeRateProvider } from './provider'

/**
 * Current-position conversion (spec §6.3): what a balance held in one currency
 * is worth in the other *right now*.
 *
 * Every current figure — Total Balance, current Net Worth, Account
 * Distribution, the Debt/Loan overview — goes through here, and therefore
 * through the one shared `getUsableCurrentRate` policy (today's cache → live
 * provider → a last-known-good rate no older than 48h → refusal). That is the
 * same policy Transaction snapshotting uses, so a temporary provider outage
 * degrades a dashboard exactly as it degrades an entry rather than in some
 * second, subtly different way. No fallback logic is duplicated here.
 *
 * It throws `FxUnavailableError` only when no usable current rate exists at
 * all; a UI caller catches that (`isFxUnavailableError`) and shows "—" rather
 * than crashing or inventing a number.
 *
 * Not for historical activity — a stored Transaction is restated with its own
 * snapshot via `historicalAmountIn`, and a past position point on a chart uses
 * `getHistoricalRate` for that day. Arithmetic is `Decimal` end to end
 * (`rateDecimal`, never the boundary `number`) and nothing is rounded: display
 * and export apply their own explicit scale later.
 */
export async function convertToCurrentAmount(
  amount: Prisma.Decimal | number | string,
  fromCurrency: Currency,
  toCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
): Promise<Prisma.Decimal> {
  // A string is the safest money input — it has never been through a float —
  // and a `Decimal` is passed through untouched.
  const amt = amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount)

  // An unsupported currency is refused before any rate is looked up: there is
  // no point paying for a provider call whose answer would be thrown away.
  assertSupportedPair(fromCurrency, toCurrency)

  // A same-currency conversion is arithmetic-free, so it must not depend on FX
  // being reachable at all: a VND figure for a VND user still renders during a
  // provider outage, and the same Decimal comes back untouched.
  if (fromCurrency === toCurrency) return amt

  const { rateDecimal } = await getUsableCurrentRate(
    { base: 'USD', quote: 'VND' },
    providerOverride,
  )
  return applyVndPerUsdRate(amt, fromCurrency, toCurrency, rateDecimal)
}
