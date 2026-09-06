import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { getRecentMonthWindows } from '@/lib/datetime/month-windows'
import { getAccountBalanceOverTime } from '@/lib/server/services/account-balance-history'
import {
  getCashFlowTrend,
  getExpenseByCategory,
  getMonthlyIncomeExpense,
} from '@/lib/server/services/activity'
import { getCurrentPosition } from '@/lib/server/services/position'
import { listTransactions } from '@/lib/server/services/transaction'
import { buildDashboardViewModel } from '@/lib/ui/dashboard-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { AccountBalanceHistoryChart } from '@/components/dashboard/account-balance-history-chart'
import { AccountDistributionChart } from '@/components/dashboard/account-distribution-chart'
import { CashFlowTrendChart } from '@/components/dashboard/cash-flow-trend-chart'
import { DashboardEmpty, DashboardSection } from '@/components/dashboard/dashboard-section'
import { ExpenseByCategoryChart } from '@/components/dashboard/expense-by-category-chart'
import { FxRateStatus } from '@/components/dashboard/fx-rate-status'
import { IncomeVsExpenseChart } from '@/components/dashboard/income-vs-expense-chart'
import { KpiStrip } from '@/components/dashboard/kpi-strip'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'

/** How many months the two trend charts look back over. */
const TREND_MONTHS = 6

/** How many entries the Recent Transactions widget shows. */
const RECENT_TRANSACTION_COUNT = 5

/**
 * Degrades a *current-position* read to `null` when — and only when — no usable
 * FX rate exists (spec §6.3).
 *
 * The narrowing matters as much as the catch: `isFxUnavailableError` is the one
 * condition with an honest fallback (show "—", say why), and everything else —
 * a database fault, a bug in the balance maths — is rethrown so it surfaces as
 * an error instead of being disguised as a missing exchange rate.
 *
 * Nothing historical is ever wrapped in this. `getCashFlowTrend`,
 * `getExpenseByCategory`, `getMonthlyIncomeExpense` and
 * `getAccountBalanceOverTime` restate the past from each row's own FX snapshot
 * (or that day's historical rate) and never consult the current-rate policy, so
 * an FX outage cannot reach them and there is nothing for them to degrade to.
 */
async function orNullIfFxUnavailable<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (isFxUnavailableError(error)) return null
    throw error
  }
}

export default async function DashboardPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own. `user.id` — never anything client-supplied
  // — scopes every query below.
  const user = await requireUserOrRedirect()
  const { baseCurrency: displayCurrency, timezone } = resolveProfileDefaults(user)
  // Taken once and threaded through every call, so the twelve figures on this
  // page cannot be computed against two different "nows" either side of
  // midnight.
  const now = new Date()

  // The previous calendar month *in the user's zone*, from the same helper the
  // trend charts bucket by — so "last month" on the comparison chart is exactly
  // the month before the one the trend's last point covers.
  const [previousMonth] = getRecentMonthWindows(timezone, 2, now)

  const [
    position,
    monthly,
    previousMonthly,
    cashFlowTrend,
    expenseByCategory,
    balanceOverTime,
    recentTransactions,
  ] = await Promise.all([
    // One call for all three current-position figures (Total Balance, Net
    // Worth, the distribution), so they cannot disagree: they are three views
    // of one set of balances converted at one rate.
    // `{ now }`: the position is "as of now", so the KPI strip and the balance
    // chart's current point are cut at the same instant.
    orNullIfFxUnavailable(getCurrentPosition(user.id, displayCurrency, { now })),
    getMonthlyIncomeExpense(user.id, timezone, displayCurrency, now),
    getMonthlyIncomeExpense(user.id, timezone, displayCurrency, previousMonth.startUtc),
    getCashFlowTrend(user.id, timezone, displayCurrency, TREND_MONTHS, now),
    getExpenseByCategory(user.id, timezone, displayCurrency, now),
    getAccountBalanceOverTime(user.id, timezone, displayCurrency, TREND_MONTHS, undefined, now),
    listTransactions(user.id, { limit: RECENT_TRANSACTION_COUNT }),
  ])

  // The only place `Decimal` becomes `number`/`string` on this page. Everything
  // below renders DTOs; no component receives a `Decimal`, a `Date` or a
  // service type.
  const vm = buildDashboardViewModel({
    displayCurrency,
    timezone,
    now,
    position,
    monthly,
    previousMonthly,
    cashFlowTrend,
    expenseByCategory,
    balanceOverTime,
    recentTransactions,
  })

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{vm.subtitle}</p>
        </div>
        <FxRateStatus status={vm.fxStatus} />
      </header>

      <KpiStrip kpis={vm.kpis} currency={vm.displayCurrency} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardSection title="Cash Flow Trend">
          <CashFlowTrendChart data={vm.cashFlowTrend} currency={vm.displayCurrency} />
        </DashboardSection>

        <DashboardSection title="Income vs Expense">
          <IncomeVsExpenseChart data={vm.incomeVsExpense} currency={vm.displayCurrency} />
        </DashboardSection>

        <DashboardSection
          title="Account Balance Over Time"
          caption="Account balances only — historical Net Worth is not modelled"
        >
          <AccountBalanceHistoryChart data={vm.balanceOverTime} currency={vm.displayCurrency} />
        </DashboardSection>

        <DashboardSection title="Expense by Category">
          <ExpenseByCategoryChart data={vm.expenseByCategory} currency={vm.displayCurrency} />
        </DashboardSection>

        <DashboardSection title="Account Balance Distribution">
          {vm.distribution === null ? (
            <DashboardEmpty>FX unavailable — account balances cannot be compared</DashboardEmpty>
          ) : (
            <AccountDistributionChart data={vm.distribution} currency={vm.displayCurrency} />
          )}
        </DashboardSection>

        <DashboardSection title="Recent Transactions">
          <RecentTransactions transactions={vm.recentTransactions} />
        </DashboardSection>
      </div>
    </div>
  )
}
