import { Prisma } from '@prisma/client'
import { applyVndPerUsdRate } from '@/lib/currency/apply-rate'
import { getHistoricalRate } from '@/lib/currency/fx-service'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'
import { getRecentMonthWindows } from '@/lib/datetime/month-windows'
import { getAccountBalances } from './balance'
import { listAllFinancialAccounts } from './financial-account'

/**
 * Account Balance Over Time — account balances only.
 *
 * True historical Net Worth is deferred (spec §17): receivables, payables and
 * loan principal have no history in the data model, only a current state, so
 * there is no honest way to say what net worth *was* three months ago. This
 * chart therefore reports the one quantity that can be reconstructed exactly —
 * the sum of the user's account balances at each month's end — and the field is
 * named `balance` rather than `netWorth` so no caller can mistake one for the
 * other.
 *
 * Everything here is history, so every conversion uses the rate of the point's
 * own day (`getHistoricalRate`). Today's rate is never substituted: when a day
 * has no rate the point's `balance` is `null` and the chart renders a gap (spec
 * §6.1/§6.4). `getUsableCurrentRate` is deliberately not imported — a
 * three-month-old point restated at this morning's rate would silently rewrite
 * the past every time the market moved.
 */

export interface AccountBalancePoint {
  /** `yyyy-MM` as the month reads in the user's timezone. */
  month: string
  /** The instant the balance was taken at — see `getAccountBalanceOverTime`. */
  asOf: Date
  /**
   * Σ of every account's balance at `asOf`, restated in the display currency,
   * or `null` when the day's rate is unavailable and no honest number exists.
   */
  balance: Prisma.Decimal | null
}

/**
 * The sum of every account's balance at the end of each of the last
 * `monthsBack` calendar months, oldest first, restated in `displayCurrency`.
 *
 * Month windows are the user's *local* months (the shared
 * `getRecentMonthWindows`, also used by the cash-flow trend). Each point is
 * sampled at `endUtc − 1 ms` — the last instant of that local month — except
 * the month in progress, which is sampled at `now`: a point must never claim a
 * balance for an instant that has not happened yet.
 *
 * Every account is included, archived ones too. An archived account's earlier
 * months are real history, and dropping them would make the chart's past change
 * whenever a user tidies up. An account that did not exist yet at a given point
 * contributes zero rather than its (not-yet-true) opening balance — that rule
 * lives in `getAccountBalances`, which is also what keeps this function from
 * needing to know about `createdAt` at all.
 *
 * Cost is one batched `getAccountBalances` per point (never one per account),
 * plus at most one `getHistoricalRate` per point — and none at all for a user
 * whose accounts are all held in `displayCurrency`, whose chart therefore
 * renders unchanged through a provider outage.
 *
 * Arithmetic is `Prisma.Decimal` end to end and nothing is rounded: rounding is
 * a presentation decision the page or the export makes later.
 */
export async function getAccountBalanceOverTime(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  monthsBack = 6,
  providerOverride?: ExchangeRateProvider,
  now: Date = new Date(),
): Promise<AccountBalancePoint[]> {
  const windows = getRecentMonthWindows(timezone, monthsBack, now)
  if (windows.length === 0) return []

  const accounts = await listAllFinancialAccounts(userId)
  const accountIds = accounts.map((account) => account.id)
  // Decided once from the account list, not per point: a single-currency user
  // must never reach the FX cache, whatever the balances happen to be.
  const needsConversion = accounts.some((account) => account.currency !== displayCurrency)

  const points: AccountBalancePoint[] = []
  for (const window of windows) {
    const monthEnd = new Date(window.endUtc.getTime() - 1)
    // The month in progress ends in the future; sample it at `now` instead.
    const asOf = monthEnd.getTime() > now.getTime() ? now : monthEnd

    const balances = await getAccountBalances(userId, accountIds, asOf)

    // One lookup for the whole point — the rate is a property of the day, not
    // of an account — and only when some account actually needs converting.
    const rate = needsConversion
      ? await getHistoricalRate({ base: 'USD', quote: 'VND' }, asOf, providerOverride)
      : null
    if (needsConversion && !rate) {
      // A real answer, not an error: the day's rate is unknown, so this point
      // is a gap. The neighbouring points keep their own days' rates.
      points.push({ month: window.month, asOf, balance: null })
      continue
    }

    let total = new Prisma.Decimal(0)
    for (const account of accounts) {
      const balance = balances.get(account.id) ?? new Prisma.Decimal(0)
      if (account.currency === displayCurrency) {
        total = total.add(balance)
        continue
      }
      // Unreachable: `needsConversion` is true whenever this branch is, and a
      // null rate already returned above. The throw exists so a future edit
      // that decouples the two fails loudly instead of charting native numbers.
      if (!rate) throw new Error('Missing exchange rate for a conversion that is required')
      total = total.add(
        applyVndPerUsdRate(balance, account.currency, displayCurrency, rate.rateDecimal),
      )
    }

    points.push({ month: window.month, asOf, balance: total })
  }

  return points
}
