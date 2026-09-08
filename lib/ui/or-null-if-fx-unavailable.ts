import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'

/**
 * Degrades a *current-position* read to `null` when — and only when — no
 * usable FX rate exists (spec §6.3).
 *
 * The narrowing matters as much as the catch: `isFxUnavailableError` is the
 * one condition with an honest fallback (show "—", say why), and everything
 * else — a database fault, a bug in the balance maths — is rethrown so it
 * surfaces as an error instead of being disguised as a missing exchange rate.
 *
 * Shared by the Dashboard and Accounts pages (both read `getCurrentPosition`
 * for a header/KPI total), so the one financial-degradation rule cannot drift
 * into two slightly different copies.
 *
 * Nothing historical is ever wrapped in this. `getActivitySummary`,
 * `getCashFlowTrend` and `getAccountBalanceOverTime` restate the past from each
 * row's own FX snapshot (or that day's historical rate) and never consult the
 * current-rate policy, so an FX outage cannot reach them and there is nothing
 * for them to degrade to.
 */
export async function orNullIfFxUnavailable<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (isFxUnavailableError(error)) return null
    throw error
  }
}
