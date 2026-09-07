import Link from 'next/link'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { isFxUnavailableError } from '@/lib/currency/current-rate-policy'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getCalendarMonth } from '@/lib/datetime/calendar-month'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { getAccountBalanceOverTime } from '@/lib/server/services/account-balance-history'
import { getActivitySummary, getCashFlowTrend } from '@/lib/server/services/activity'
import { getBudgetProgressForMonth } from '@/lib/server/services/budget'
import { getCurrentPosition } from '@/lib/server/services/position'
import { listUpcomingOccurrences, OCCURRENCE_LOOKAHEAD_DAYS } from '@/lib/server/services/reminder'
import { listSavingsGoals } from '@/lib/server/services/savings-goal'
import { listTransactions } from '@/lib/server/services/transaction'
import { buildDashboardViewModel } from '@/lib/ui/dashboard-view-model'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { BudgetProgressList } from '@/components/budgets/budget-progress-list'
import { AccountBalanceHistoryChart } from '@/components/dashboard/account-balance-history-chart'
import { AccountDistributionChart } from '@/components/dashboard/account-distribution-chart'
import { CashFlowTrendChart } from '@/components/dashboard/cash-flow-trend-chart'
import { DashboardEmpty, DashboardSection } from '@/components/dashboard/dashboard-section'
import { DebtLoanOverview } from '@/components/dashboard/debt-loan-overview'
import { ExpenseByCategoryChart } from '@/components/dashboard/expense-by-category-chart'
import { FxRateStatus } from '@/components/dashboard/fx-rate-status'
import { IncomeVsExpenseChart } from '@/components/dashboard/income-vs-expense-chart'
import { KpiStrip } from '@/components/dashboard/kpi-strip'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'
import { GoalList } from '@/components/goals/goal-list'
import { OccurrenceList } from '@/components/reminders/occurrence-list'

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
 * Nothing historical is ever wrapped in this. `getActivitySummary`,
 * `getCashFlowTrend` and `getAccountBalanceOverTime` restate the past from each
 * row's own FX snapshot (or that day's historical rate) and never consult the
 * current-rate policy, so an FX outage cannot reach them and there is nothing
 * for them to degrade to.
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
  // The month the user is *in*, read in their zone — never from a server-local
  // `Date` getter, which for a Vietnamese user on a UTC host is the previous
  // month for seven hours of every day.
  const currentMonth = getCalendarMonth(timezone, now)
  // The user's own calendar day, from the same `now`: whether a goal's deadline
  // has passed or a reminder is overdue is a comparison of calendar dates in
  // *their* zone, never of instants in the server's (ruling R6-7).
  const today = todayCalendarDateInZone(timezone, now)

  // Per render, the whole page costs:
  //   · 1 `listActiveFinancialAccounts` + 1 batched `getAccountBalances`
  //     + 1 debt read + 1 loan read (2 queries each)
  //     + at most 1 current-FX policy call        (getCurrentPosition)
  //   · 1 month scan  — KPIs *and* Expense by Category   (getActivitySummary)
  //   · 1 six-month scan — the trend, and the Income vs Expense bars derived
  //     from its last two points                        (getCashFlowTrend)
  //   · 6 batched balance reads + at most 6 historical-rate lookups
  //                                              (getAccountBalanceOverTime)
  //   · 1 recent-transactions list                       (listTransactions)
  //   · 1 budget list + 1 month EXPENSE scan  (getBudgetProgressForMonth)
  //   · 1 goal list                                    (listSavingsGoals)
  //   · 1 reminder scan + the PENDING occurrence rows it materializes
  //                                            (listUpcomingOccurrences)
  // Nothing here is per-account or per-row, and no widget fetches on its own.
  //
  // `listUpcomingOccurrences` is the one call on this page that WRITES: there
  // is no cron in this project, so the rows for the next 30 days are
  // materialized lazily by whoever reads them first (idempotently — a second
  // read creates nothing). It is called once here and its result reused, for
  // the same reason the Reminders page calls it once.

  // Resolved FIRST, on its own, and only then the rest.
  //
  // `getCurrentPosition` is the one call that may consult the *current*-rate
  // policy, which caches today's row on a miss. `getAccountBalanceOverTime`'s
  // current point then looks that very day up. Awaiting the position before
  // starting the others means the row is already written when the chart asks,
  // so on a live-rate day the current point is a figure rather than a gap —
  // deterministically, instead of depending on which of two concurrent promises
  // happened to win. It costs one round trip of serialisation; everything below
  // still runs concurrently.
  //
  // One call answers all three current-position figures (Total Account Balance,
  // Net Worth, the distribution), so they cannot disagree: they are three views
  // of one set of balances converted at one rate. `{ now }` makes it "as of
  // now", cut at the same instant as the balance chart's current point.
  const position = await orNullIfFxUnavailable(
    getCurrentPosition(user.id, displayCurrency, { now }),
  )

  const [monthly, cashFlowTrend, balanceOverTime, recentTransactions, budgets, goals, occurrences] =
    await Promise.all([
      // ONE scan of the current local month, feeding the three monthly KPIs and
      // the Expense by Category chart. Two scans of the same window could only
      // ever produce the same numbers at a higher price — or different ones, if a
      // row landed between them.
      getActivitySummary(user.id, displayCurrency, getPeriodBounds(timezone, 'month', now)),
      getCashFlowTrend(user.id, timezone, displayCurrency, TREND_MONTHS, now),
      getAccountBalanceOverTime(user.id, timezone, displayCurrency, TREND_MONTHS, undefined, now),
      listTransactions(user.id, { limit: RECENT_TRANSACTION_COUNT }),
      // Historical end to end: it sums each contributing row at that row's own FX
      // snapshot and never consults the current-rate policy, so it is not wrapped
      // in `orNullIfFxUnavailable` — an FX outage cannot reach it, and there is
      // nothing for it to degrade to. Two queries whatever the number of budgets,
      // and none at all in the transaction table when the month has none.
      getBudgetProgressForMonth(user.id, timezone, currentMonth.year, currentMonth.month),
      // Both of these keep every amount in its own currency and consult no rate
      // at all, so — like the budgets above — they are not wrapped in
      // `orNullIfFxUnavailable`: an FX outage cannot reach them and there is
      // nothing for them to degrade to. The Debt / Loan overview beside them is
      // the opposite case and comes from `position`, which already degraded.
      listSavingsGoals(user.id),
      listUpcomingOccurrences(user.id, timezone, now),
    ])

  // The only place `Decimal` becomes `number`/`string` on this page. Everything
  // below renders DTOs; no component receives a `Decimal`, a `Date` or a
  // service type.
  const vm = buildDashboardViewModel({
    displayCurrency,
    timezone,
    now,
    today,
    position,
    monthly,
    cashFlowTrend,
    balanceOverTime,
    recentTransactions,
    budgets,
    goals,
    occurrences,
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

        {/* The caption is not decoration: every other figure on this page is in
            the display currency, and these are not — a budget is compared
            against its own currency, never restated (ruling R5-3). */}
        <DashboardSection
          title="Budget Progress"
          caption="This month · each budget in its own currency"
        >
          {vm.budgets.length === 0 ? (
            <DashboardEmpty>
              {/* One `span`, as in `RecentTransactions`: `DashboardEmpty`'s `p` is
                  a flex container, so bare text and a link would be two flex
                  items and the space between them would be dropped. */}
              <span>
                No budgets for this month —{' '}
                <Link href="/budgets" className="text-brand underline-offset-4 hover:underline">
                  set one up
                </Link>
              </span>
            </DashboardEmpty>
          ) : (
            <BudgetProgressList budgets={vm.budgets} compact />
          )}
        </DashboardSection>

        {/* Same caption reasoning as the budgets above, and the same ruling: a
            goal is a target in its own currency and is never restated. */}
        <DashboardSection
          title="Savings Goals"
          caption="Manual targets · each goal in its own currency"
        >
          {vm.savingsGoals.length === 0 ? (
            <DashboardEmpty>
              <span>
                No savings goals —{' '}
                <Link href="/goals" className="text-brand underline-offset-4 hover:underline">
                  set one up
                </Link>
              </span>
            </DashboardEmpty>
          ) : (
            // The Savings page's own rows, compact: one visual language for a
            // goal wherever it appears.
            <GoalList goals={vm.savingsGoals} compact />
          )}
        </DashboardSection>

        {/* The one widget here that IS in the display currency, so it says so:
            these three are converted aggregates and part of the Net Worth card
            above, which is exactly why they may be compared with each other. */}
        <DashboardSection
          title="Debt / Loan Overview"
          caption={`Outstanding today · ${vm.displayCurrency}`}
        >
          {vm.debtLoanOverview === null ? (
            <DashboardEmpty>FX unavailable — outstanding amounts cannot be compared</DashboardEmpty>
          ) : (
            <DebtLoanOverview data={vm.debtLoanOverview} currency={vm.displayCurrency} />
          )}
        </DashboardSection>

        {/* The window comes from the service's own exported constant, so this
            copy and what materialization actually looks ahead cannot drift
            apart — the Reminders page says it the same way. "Overdue and"
            because the list genuinely contains both: an unanswered bill from
            three months ago is outside the 30 days and is still shown (ruling
            R6-23), so a caption naming only the window would be wrong about
            the rows underneath it. */}
        <DashboardSection
          title="Upcoming Reminders"
          caption={`Overdue and the next ${OCCURRENCE_LOOKAHEAD_DAYS} days`}
        >
          {vm.upcomingReminders.length === 0 ? (
            // One interpolated string, not text either side of `{…}`:
            // `DashboardEmpty`'s `p` is a flex container, so three children
            // would be three flex items and the spaces around the number would
            // be dropped (the same trap the budgets empty state notes above).
            //
            // Reached only when NOTHING is pending: the widget no longer fills
            // itself from the overdue end of the list, so "nothing due" and
            // "nothing shown" are the same state again.
            <DashboardEmpty>{`Nothing due in the next ${OCCURRENCE_LOOKAHEAD_DAYS} days.`}</DashboardEmpty>
          ) : (
            <>
              {/* A muted count, not a banner — the same line the Reminders
                  page puts over its Overdue group, for the same reason: the
                  user needs to know how much of it there is (the list shows at
                  most two of them) without being shouted at. Only the number
                  carries colour. */}
              {vm.overdueReminderCount > 0 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  <span className="text-negative tabular-nums">{vm.overdueReminderCount}</span>{' '}
                  overdue
                </p>
              )}
              <OccurrenceList occurrences={vm.upcomingReminders} compact />
            </>
          )}
        </DashboardSection>

        {/* Last, deliberately: the widgets above are what the user came to
            decide something from, and the ledger is what they scroll to when
            they want to check one of them. */}
        <DashboardSection title="Recent Transactions">
          <RecentTransactions transactions={vm.recentTransactions} />
        </DashboardSection>
      </div>
    </div>
  )
}
