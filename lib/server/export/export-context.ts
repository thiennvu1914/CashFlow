import { prisma } from '@/lib/prisma'
import { getUsableCurrentRate, isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import type { ExportContext } from './sheet-registry'

/** The only pair CashFlow holds a current rate for. */
const PAIR = { base: 'USD', quote: 'VND' } as const

/**
 * Everything an export needs to know about the user, resolved once.
 *
 * Two things happen here rather than in a sheet builder, and both are about
 * consistency across the workbook:
 *
 * 1. **The profile is read once.** `resolveProfileDefaults` is the single place
 *    a stored `baseCurrency`/`timezone` becomes a validated value, so every
 *    sheet formats money and dates the same way. The row is read from the
 *    database rather than taken from the session object because the session's
 *    additional fields are typed as bare `string`.
 *
 * 2. **FX is fetched once, and may be absent.** One `getUsableCurrentRate` per
 *    workbook — never per sheet, and never per row — so two sheets cannot
 *    restate balances at two different rates. `FxUnavailableError` is the one
 *    error swallowed, and it becomes `fx: null`: an export is a read-only
 *    snapshot of data the user already owns, and refusing to hand it over
 *    because a third-party rate service is down would be the wrong trade. Every
 *    *converted* figure is then left blank and labelled unavailable — nothing
 *    downstream substitutes a rate. Any other error propagates: a database
 *    fault is not an FX outage.
 *
 * `now` and `providerOverride` are injection points for tests; production
 * callers pass neither.
 */
export async function buildExportContext(
  userId: string,
  now: Date = new Date(),
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<ExportContext> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)

  let fx = null
  try {
    fx = await getUsableCurrentRate(PAIR, providerOverride)
  } catch (error) {
    // Narrowed deliberately: only "no usable rate exists" degrades to a blank
    // column. Anything else is a real fault and must reach the route.
    if (!isFxUnavailableError(error)) throw error
  }

  return { userId, displayCurrency, timezone, fx, now }
}
