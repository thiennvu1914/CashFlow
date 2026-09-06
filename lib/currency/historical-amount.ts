import type { Prisma } from '@prisma/client'
import { applyVndPerUsdRate } from './apply-rate'
import type { Currency } from './provider'

/**
 * Historical (activity) conversion — the only way a stored Transaction is ever
 * restated in another currency (spec §6.4).
 *
 * A transaction is converted with the rate *it* snapshotted at entry, so a
 * report about January answers the same number today, tomorrow and next year:
 * last month's totals cannot drift because this morning's rate moved. That is
 * the whole point, and it is why this module is pure — it never reads
 * `User.baseCurrency` (a display preference), never calls the FX provider,
 * never queries the `ExchangeRate` cache or `getUsableCurrentRate`, and never
 * writes anything. Its only imports are `@prisma/client` (for `Decimal`) and
 * sibling types.
 *
 * Current *positions* (a balance as of now) are a different question with a
 * different answer — `convertToCurrentAmount`. Historical position points on a
 * chart are a third — `getHistoricalRate` for the day in question.
 *
 * No rounding happens here: results carry decimal.js's full default precision
 * and display/export apply their own explicit scale later.
 */

/**
 * The FX-relevant shape of a Transaction. A Prisma `Transaction` row satisfies
 * it structurally, so callers pass the row straight in — there is no mapping
 * step in which a `Decimal` could be widened to a float.
 */
export interface HistoricalAmountInput {
  amount: Prisma.Decimal
  currency: Currency
  vndPerUsdAtEntry: Prisma.Decimal
}

/** `tx`'s amount restated in `target` at the rate `tx` snapshotted at entry. */
export function historicalAmountIn(target: Currency, tx: HistoricalAmountInput): Prisma.Decimal {
  return applyVndPerUsdRate(tx.amount, tx.currency, target, tx.vndPerUsdAtEntry)
}
