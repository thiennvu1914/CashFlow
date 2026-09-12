import type { Currency } from '@/lib/currency/provider'
import { getCalendarMonth } from '@/lib/datetime/calendar-month'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { orNullIfFxUnavailable } from '@/lib/ui/or-null-if-fx-unavailable'
import { getAccountBalanceOverTime, loadBalanceHistory } from './account-balance-history'
import { getActivitySummary, getCashFlowTrend } from './activity'
import { getBudgetProgressForMonth } from './budget'
import { getCurrentPosition } from './position'
import { listDashboardOccurrences } from './reminder'
import { listSavingsGoals } from './savings-goal'
import { listTransactions } from './transaction'

/** Fresh, tenant-scoped reads for one render. Widget calculators are unchanged. */
export async function getDashboardData(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  now: Date,
  limits: {
    months: number
    transactions: number
    occurrences: { overdue: number; upcoming: number }
  },
) {
  const month = getCalendarMonth(timezone, now)
  const [finance, monthly, cashFlowTrend, recentTransactions, budgets, goals, occurrences] =
    await Promise.all([
      (async () => {
        const state = await loadBalanceHistory(userId, timezone, limits.months, now)
        const balances = state.timeline.balances.at(-1)
        if (!balances) throw new Error('Dashboard requires a current balance point')
        const position = await orNullIfFxUnavailable(
          getCurrentPosition(userId, displayCurrency, {
            now,
            accountState: { userId, asOf: now, accounts: state.accounts, balances },
          }),
        )
        // Preserve the existing current-rate cache ordering: today's policy must
        // finish before history reads that day. Only unrelated widgets overlap.
        const balanceOverTime = await getAccountBalanceOverTime(
          userId,
          timezone,
          displayCurrency,
          limits.months,
          undefined,
          now,
          state,
        )
        return { position, balanceOverTime }
      })(),
      getActivitySummary(userId, displayCurrency, getPeriodBounds(timezone, 'month', now)),
      getCashFlowTrend(userId, timezone, displayCurrency, limits.months, now),
      listTransactions(userId, { limit: limits.transactions }),
      getBudgetProgressForMonth(userId, timezone, month.year, month.month),
      listSavingsGoals(userId),
      listDashboardOccurrences(userId, timezone, limits.occurrences, now),
    ])
  return { ...finance, monthly, cashFlowTrend, recentTransactions, budgets, goals, occurrences }
}
