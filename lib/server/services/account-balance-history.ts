import { Prisma } from '@prisma/client'
import { applyVndPerUsdRate } from '@/lib/currency/apply-rate'
import { getHistoricalRates } from '@/lib/currency/fx-service'
import type { Currency, ExchangeRateProvider } from '@/lib/currency/provider'
import { getRecentMonthWindows } from '@/lib/datetime/month-windows'
import { prisma } from '@/lib/prisma'
import { AccountNotFoundError } from './balance'
import { getBalanceTimeline } from './balance-timeline'

/** Internal request-local inputs shared by the current position and history. */
export async function loadBalanceHistory(
  userId: string,
  timezone: string,
  monthsBack: number,
  now: Date,
) {
  const windows = getRecentMonthWindows(timezone, monthsBack, now)
  const cutoffs = windows.map(
    (window) => new Date(Math.min(window.endUtc.getTime() - 1, now.getTime())),
  )
  const accounts = await prisma.financialAccount.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
  const timeline = await getBalanceTimeline(userId, accounts, cutoffs)
  return { userId, accounts, cutoffs, timeline }
}

type BalanceHistoryInput = Awaited<ReturnType<typeof loadBalanceHistory>>

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
 * For a zone *behind* UTC that month-end instant falls on the following UTC
 * day, so the point is converted at that day's rate — for `America/New_York`,
 * the end of local August is 04:00Z on 1 September and the September rate is
 * the one in effect at that instant. That is intentional: the rate belongs to
 * the moment the balance is sampled, not to the label the month carries.
 *
 * Every account is included, archived ones too. An archived account's earlier
 * months are real history, and dropping them would make the chart's past change
 * whenever a user tidies up. An account that did not exist yet at a given point
 * contributes zero rather than its (not-yet-true) opening balance — that rule
 * lives in the shared balance timeline, just as in `getAccountBalances`.
 *
 * A rate is consulted only when it can actually change the answer: the balances
 * come first, and a point whose foreign-currency accounts all sit at zero is
 * exact without one. That is what keeps an account opened this month from
 * turning every earlier point into a gap — before it existed its balance was
 * zero, and zero converts to zero at any rate, so there is nothing to look up.
 *
 * Cost is one account read, one SQL aggregate for every point together, and
 * one historical-rate cache read for all days that actually need conversion.
 * Provider misses keep the existing per-day fetch/cache policy. The Dashboard
 * supplies its already loaded timeline, also used by the current position.
 *
 * Missing historical days are fetched concurrently, once per distinct UTC day.
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
  input?: BalanceHistoryInput,
): Promise<AccountBalancePoint[]> {
  const windows = getRecentMonthWindows(timezone, monthsBack, now)
  if (windows.length === 0) return []

  const state = input ?? (await loadBalanceHistory(userId, timezone, monthsBack, now))
  if (
    state.userId !== userId ||
    state.cutoffs.length !== windows.length ||
    state.timeline.balances.length !== windows.length ||
    state.cutoffs.some(
      (cutoff, index) =>
        cutoff.getTime() !== Math.min(windows[index].endUtc.getTime() - 1, now.getTime()),
    )
  ) {
    throw new Error('Balance history state must belong to this user and these cutoffs')
  }
  const { accounts } = state
  for (const account of accounts) {
    if (account.userId !== userId) throw new AccountNotFoundError(account.id)
  }
  const needsRates = state.timeline.balances.map((balances) =>
    accounts.some(
      (account) =>
        account.currency !== displayCurrency &&
        !(balances.get(account.id) ?? new Prisma.Decimal(0)).isZero(),
    ),
  )
  const rates = await getHistoricalRates(
    { base: 'USD', quote: 'VND' },
    state.cutoffs.filter((_, index) => needsRates[index]),
    providerOverride,
  )

  // All database/provider reads are complete; preserve oldest → newest order.
  return windows.map((window, index): AccountBalancePoint => {
    const monthEnd = new Date(window.endUtc.getTime() - 1)
    // The month in progress ends in the future; sample it at `now` instead.
    const asOf = monthEnd.getTime() > now.getTime() ? now : monthEnd

    // Balances first: whether a rate is *needed* is a fact about this point's
    // numbers, not about the account list.
    const balances = state.timeline.balances[index]
    const balanceOf = (accountId: string) => balances.get(accountId) ?? new Prisma.Decimal(0)

    // Zero converts to zero at every rate, so a foreign account sitting at
    // zero — including one that did not exist yet at `asOf` — cannot make the
    // answer depend on FX.
    const needsRate = needsRates[index]
    // One lookup for the whole point: the rate is a property of the day, not
    // of an account.
    const day = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate())
    const rate = needsRate ? rates.get(day) : null
    if (needsRate && !rate) {
      // A real answer, not an error: the day's rate is unknown, so this point
      // is a gap. The neighbouring points keep their own days' rates.
      return { month: window.month, asOf, balance: null }
    }

    let total = new Prisma.Decimal(0)
    for (const account of accounts) {
      const balance = balanceOf(account.id)
      if (account.currency === displayCurrency || balance.isZero()) {
        total = total.add(balance)
        continue
      }
      // Unreachable: `needsRate` is true whenever this branch is, and a null
      // rate already returned above. The throw exists so a future edit that
      // decouples the two fails loudly instead of charting native numbers.
      if (!rate) throw new Error('Missing exchange rate for a conversion that is required')
      total = total.add(
        applyVndPerUsdRate(balance, account.currency, displayCurrency, rate.rateDecimal),
      )
    }

    return { month: window.month, asOf, balance: total }
  })
}
