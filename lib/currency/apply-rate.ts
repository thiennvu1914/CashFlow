import type { Prisma } from '@prisma/client'
import type { Currency } from './provider'

/**
 * The one piece of VND/USD arithmetic in the application (spec §6.4).
 *
 * Every conversion — a Transaction restated at its own snapshot rate
 * (`historicalAmountIn`), a current position restated at today's usable rate
 * (`convertToCurrentAmount`), and Phase 4's balance-over-time points at their
 * per-day historical rates — goes through this function, so "multiply going to
 * VND, divide going to USD" is written down exactly once.
 *
 * Pure and total: `Prisma.Decimal` in, `Prisma.Decimal` out, no I/O, no clock,
 * no database, no `Number()` anywhere on the path. The rate is always
 * VND-per-USD regardless of the direction of the conversion.
 *
 * Nothing here rounds. Results carry decimal.js's default precision (20
 * significant digits on a non-terminating division), because rounding is a
 * presentation decision: display and export apply their own explicit scale
 * later, and a value rounded here would silently lose digits before it ever
 * reached an aggregate.
 */

/** Thrown when asked for a pair CashFlow holds no rate for — only VND and USD exist. */
export class UnsupportedCurrencyPairError extends Error {
  constructor(from: string, to: string) {
    super(`Unsupported currency pair: ${from} -> ${to}`)
    this.name = 'UnsupportedCurrencyPairError'
  }
}

/**
 * `amount`, expressed in `from`, restated in `to` using `vndPerUsd`.
 *
 * A same-currency call returns the *same* `Decimal` instance: nothing is
 * recomputed, so a pass-through can never perturb a value.
 *
 * The rate is validated even on that pass-through. A zero, negative or NaN rate
 * is corrupt data whatever the currencies happen to be — every rate in CashFlow
 * comes from a real provider lookup or a real cached row, never from a default
 * or a fabricated 1 — and accepting one here would let it travel further before
 * surfacing.
 */
export function applyVndPerUsdRate(
  amount: Prisma.Decimal,
  from: Currency,
  to: Currency,
  vndPerUsd: Prisma.Decimal,
): Prisma.Decimal {
  assertSupportedPair(from, to)
  if (!vndPerUsd.isFinite() || vndPerUsd.lessThanOrEqualTo(0)) {
    throw new RangeError(`Exchange rate must be a positive finite number, received: ${vndPerUsd}`)
  }

  if (from === to) return amount
  if (from === 'USD') return amount.mul(vndPerUsd)
  return amount.div(vndPerUsd)
}

/**
 * Rejects a pair this module cannot convert, before a caller goes looking for a
 * rate. Exported so `convertToCurrentAmount` can fail on `EUR` without first
 * making a provider call it would then throw away.
 */
export function assertSupportedPair(from: Currency, to: Currency): void {
  if (!isSupported(from) || !isSupported(to)) throw new UnsupportedCurrencyPairError(from, to)
}

function isSupported(currency: Currency): boolean {
  return currency === 'VND' || currency === 'USD'
}
