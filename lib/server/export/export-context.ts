import { prisma } from '@/lib/prisma'
import { getUsableCurrentRate, isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import type { UsableRateResult } from '@/lib/currency/current-rate-policy'
import type { ExchangeRateProvider } from '@/lib/currency/provider'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import type { ExportContext } from './sheet-registry'

/** The only pair CashFlow holds a current rate for. */
const PAIR = { base: 'USD', quote: 'VND' } as const

/**
 * Who the export is for, before any rate is involved.
 *
 * Split out from the FX step for two reasons. The route needs `timezone` to
 * resolve the requested range, and a range the user typed wrong must be a 400
 * *before* a third-party rate lookup is made on its behalf — otherwise every
 * malformed URL costs a provider round trip. And the filtered workbook reads no
 * current rate at all, so fetching one for it would be pure waste.
 */
export interface ExportProfile {
  userId: string
  displayCurrency: ExportContext['displayCurrency']
  timezone: string
}

/**
 * The user's export-relevant settings.
 *
 * Read from the database rather than taken from the session object, whose
 * additional fields are typed as bare `string`; `resolveProfileDefaults` is the
 * single place a stored `baseCurrency`/`timezone` becomes a validated value, so
 * every sheet formats money and dates the same way.
 */
export async function loadExportProfile(userId: string): Promise<ExportProfile> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)
  return { userId, displayCurrency, timezone }
}

/**
 * The one usable current rate for a workbook, or `null` when none exists.
 *
 * Called at most once per export — never per sheet, and never per row — so two
 * sheets cannot restate balances at two different rates. `FxUnavailableError`
 * is the one error swallowed: an export is a read-only snapshot of data the
 * user already owns, and refusing to hand it over because a third-party rate
 * service is down would be the wrong trade. Every *converted* figure is then
 * left blank and labelled unavailable — nothing downstream substitutes a rate.
 * Any other error propagates: a database fault is not an FX outage.
 */
export async function resolveExportFx(
  providerOverride?: ExchangeRateProvider, // tests only; production callers omit it
): Promise<UsableRateResult | null> {
  try {
    return await getUsableCurrentRate(PAIR, providerOverride)
  } catch (error) {
    // Narrowed deliberately: only "no usable rate exists" degrades to a blank
    // column.
    if (!isFxUnavailableError(error)) throw error
    return null
  }
}
