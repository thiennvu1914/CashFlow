import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import {
  Activity,
  BarChart3,
  BellRing,
  HandCoins,
  LineChart,
  PieChart,
  PiggyBank,
  Target,
  Wallet,
} from 'lucide-react'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { todayCalendarDateInZone } from '@/lib/datetime/calendar-date'
import { getCalendarMonth } from '@/lib/datetime/calendar-month'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'
import { resolveLocale } from '@/lib/i18n/config'
import { getAccountBalanceOverTime } from '@/lib/server/services/account-balance-history'
import { getActivitySummary, getCashFlowTrend } from '@/lib/server/services/activity'
import { getBudgetProgressForMonth } from '@/lib/server/services/budget'
import { getCurrentPosition } from '@/lib/server/services/position'
import { listDashboardOccurrences, OCCURRENCE_LOOKAHEAD_DAYS } from '@/lib/server/services/reminder'
import { listSavingsGoals } from '@/lib/server/services/savings-goal'
import { listTransactions } from '@/lib/server/services/transaction'
import { DASHBOARD_OCCURRENCE_LIMITS, buildDashboardViewModel } from '@/lib/ui/dashboard-view-model'
import { formatDate } from '@/lib/ui/format-date'
import { orNullIfFxUnavailable } from '@/lib/ui/or-null-if-fx-unavailable'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { BudgetProgressList } from '@/components/budgets/budget-progress-list'
import { AccountBalanceHistoryChart } from '@/components/dashboard/account-balance-history-chart'
import { AccountDistributionChart } from '@/components/dashboard/account-distribution-chart'
import { CashFlowTrendChart } from '@/components/dashboard/cash-flow-trend-chart'
import { CHART_HEIGHT } from '@/components/dashboard/chart-theme'
import { DebtLoanOverview } from '@/components/dashboard/debt-loan-overview'
import { ExpenseByCategoryChart } from '@/components/dashboard/expense-by-category-chart'
import { FxRateStatus } from '@/components/dashboard/fx-rate-status'
import { IncomeVsExpenseChart } from '@/components/dashboard/income-vs-expense-chart'
import { OnboardingCard } from '@/components/dashboard/onboarding-card'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'
import { SummaryPanel } from '@/components/dashboard/summary-panel'
import { ChartContainer } from '@/components/common/chart-container'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { GoalList } from '@/components/goals/goal-list'
import { OccurrenceList } from '@/components/reminders/occurrence-list'

/** How many months the two trend charts look back over. */
const TREND_MONTHS = 6

/**
 * How many entries the Recent Transactions widget fetches.
 *
 * Spec §6.1 row 7: the ledger is full width on desktop and shows eight rows.
 * The mobile stack shows five — sliced in the component's own render, not
 * fetched twice.
 */
const RECENT_TRANSACTION_COUNT = 8

/**
 * Spec §6.1: each of the three row-5 planning widgets shows at most three rows
 * and a link — a widget is a glance, and its page has the full list.
 */
const WIDGET_ROWS = 3

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
  //   · 1 reminder scan, at most 1 batched insert, then 2 bounded occurrence
  //     reads + 1 overdue count                (listDashboardOccurrences)
  // Nothing here is per-account or per-row, and no widget fetches on its own.
  //
  // `listDashboardOccurrences` is the one call on this page that WRITES: there
  // is no cron in this project, so the rows for the next 30 days are
  // materialized lazily by whoever reads them first (idempotently — a second
  // read creates nothing, and it is one batched insert however many reminders
  // the user keeps). It then reads only what the widget can render — at most
  // two overdue rows and five upcoming ones — plus a `count` for the overdue
  // tally beside the list, so the payload is constant rather than growing with
  // the user's backlog of unanswered bills (pre-flight B-6). The Reminders
  // page keeps the complete list, which is what it renders.

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
      listDashboardOccurrences(user.id, timezone, DASHBOARD_OCCURRENCE_LIMITS, now),
    ])

  // Resolved before `buildDashboardViewModel`: every figure and chart-axis
  // label it produces is locale-sensitive (fix round 1, finding 1), so the
  // view model needs the reader's locale before it builds anything, not
  // after.
  const t = await getTranslations()
  const locale = await resolveLocale()

  // The only place `Decimal` becomes `number`/`string` on this page. Everything
  // below renders DTOs; no component receives a `Decimal`, a `Date` or a
  // service type.
  const vm = buildDashboardViewModel(
    {
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
      occurrences: occurrences.rows,
      // The tally the widget's muted line reports, from its own `count` query:
      // `rows` above is capped at two overdue, so its length is not the answer.
      overdueOccurrenceCount: occurrences.overdueCount,
    },
    locale,
  )

  /**
   * A user with nothing to show yet gets three steps instead of ten widgets
   * each saying "chưa có…" (owner item H1).
   *
   * Derived entirely from data this page has ALREADY loaded — no extra query,
   * and no change to any existing one: `vm.recentTransactions` is
   * `listTransactions(limit 8)`, so an empty one means the user has no
   * transactions at all; the planning rows come from the three widget lists;
   * and the debt/loan totals come from the `position` read above.
   *
   * The condition is the owner ruling's "no transactions" AND "nothing else
   * on this page has anything to say", deliberately narrower than the ruling's
   * literal wording (recorded in the task report). "No transactions" alone
   * would HIDE real data: a user who has entered five debts, a loan and three
   * reminders but not yet a transaction has a dashboard full of figures, and
   * replacing it with "add your first transaction" would take those figures
   * off the screen. Every widget below is checked, so the card appears exactly
   * when the grid would have been empty — which is the state the ruling
   * describes ("a fresh user … instead of eleven empty widgets").
   *
   * `position === null` (an FX outage) counts as "has something to say": with
   * no usable rate the debt and loan totals are unknown rather than zero, and
   * a card claiming the user has nothing yet is not something this page can
   * stand behind. Those readers get the normal dashboard, whose own widgets
   * explain the gap.
   *
   * WHAT THESE FIVE VALUES ACTUALLY MEAN — they are the WIDGETS' windows, not
   * "does the user own any row of this kind", and that is deliberate (fix
   * round 1, Minor 4: accepted as designed). The condition asks "would the grid
   * have had anything to show?", so each term is exactly as wide as the widget
   * it stands for:
   *
   *  · `vm.recentTransactions` — `listTransactions(limit 8)`, unfiltered and
   *    unwindowed, so empty here really does mean zero transactions ever. This
   *    is the term the ruling names, and it is exact.
   *  · `vm.budgets` — the CURRENT LOCAL MONTH's budgets
   *    (`getBudgetProgressForMonth`). A user whose only budget is for another
   *    month reads as "no budget" here, which is what the widget itself says
   *    ("Chưa có ngân sách tháng này").
   *  · `vm.savingsGoals` — non-archived goals, capped at five. Only archived
   *    goals reads as none, exactly as the widget shows none.
   *  · `vm.upcomingReminders` — PENDING occurrences (every overdue one is
   *    represented, since any overdue row makes this array non-empty). A
   *    reminder that is paused, or whose next occurrence is past the 30-day
   *    lookahead, contributes nothing — again matching the widget's own
   *    caption.
   *  · the three `position` totals — what is OUTSTANDING now, so a debt repaid
   *    in full or a closed loan reads as zero, which is what the overview
   *    shows.
   *
   * The consequence, stated plainly so nobody reads this as "no rows": a user
   * who owns only rows outside every one of those windows — say a single
   * paused reminder and a budget for next month, and no transaction — sees the
   * card. That is the right answer for them, because the grid they would
   * otherwise get has nothing in it either.
   */
  const hasPlanningRows =
    vm.budgets.length > 0 || vm.savingsGoals.length > 0 || vm.upcomingReminders.length > 0
  const hasDebtOrLoan =
    position === null ||
    !position.receivables.isZero() ||
    !position.payables.isZero() ||
    !position.loanOutstanding.isZero()
  const showOnboarding = vm.recentTransactions.length === 0 && !hasPlanningRows && !hasDebtOrLoan

  /** Every summary label and hint, translated once for the panel. */
  const summaryLabels = {
    'dashboard.netWorth': t('dashboard.netWorth'),
    'dashboard.netWorthNote': t('dashboard.netWorthNote'),
    'dashboard.totalBalance': t('dashboard.totalBalance'),
    'dashboard.monthlyIncome': t('dashboard.monthlyIncome'),
    'dashboard.monthlyExpense': t('dashboard.monthlyExpense'),
    'dashboard.netIncome': t('dashboard.netIncome'),
  }
  const summaryHints = { 'dashboard.fxUnavailableHint': t('dashboard.fxUnavailableHint') }

  return (
    // max-w 1200 (spec §2), page padding 16/24/32, section gap 24 at the grid's
    // gutter and 32 between the header and the grid.
    <div className="mx-auto flex w-full max-w-[75rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle', {
          month: formatDate(vm.monthStart, { locale, timeZone: timezone, style: 'monthYear' }),
          currency: vm.displayCurrency,
        })}
        meta={<FxRateStatus status={vm.fxStatus} />}
      />

      <SummaryPanel
        variant="dashboard"
        kpis={vm.kpis}
        currency={vm.displayCurrency}
        labels={summaryLabels}
        hints={summaryHints}
      />

      {showOnboarding ? (
        // `vm.distribution` is the account list the distribution widget would
        // have charted, and it is never `null` in this branch (a `null`
        // position is `hasDebtOrLoan`, which is checked above) — so its length
        // is what step 1's completion state reads.
        <OnboardingCard hasAccount={(vm.distribution?.length ?? 0) > 0} />
      ) : (
        /* The spec's 12-column grid (§6.1), 24 px gutters. `order-*` below xl is
          what produces the mobile stacking order the spec fixes — which is NOT
          the desktop reading order: on a phone the ledger and the planning
          widgets come before the charts, because a phone is where the user
          checks something rather than studies it. */
        /* `md:grid-flow-row-dense` (Task 18, routed from Task 15's owner item
          F4 "tablet intentional"): in the TWO-column band, 768–1279, the
          `order-*` sequence hands the grid a full-width widget straight after
          a half-width one — `order-3` (budget progress, 1 col) is followed by
          `order-4` (reminders, 2 cols), which cannot share its row — and
          `order-11` (balance distribution, 1 col) is the last item, with
          nothing after it to pair with. Both left a half-cell hole. Six
          half-width widgets and four full-width ones tile that band exactly,
          so dense backfilling closes both holes without changing a single
          widget's span: expense-by-category rises beside the budget widget
          and the distribution beside income-vs-expense. Dense changes
          PLACEMENT only, never DOM order, so the tab order and the
          screen-reader order stay the ones the markup already fixes.
          `xl:grid-flow-row` restores normal flow for the 12-column desktop
          composition, which has no holes to fill and must stay
          byte-identical; the phone stack is single-column and sees neither
          class. */
        <div className="grid grid-cols-1 gap-6 md:grid-flow-row-dense md:grid-cols-2 xl:grid-flow-row xl:grid-cols-12">
          {/* Row 3: trend 8/12 h300 + expense breakdown 4/12 h300 */}
          <ChartContainer
            title={t('dashboard.cashFlowTrend')}
            height={CHART_HEIGHT.tall}
            className="order-1 md:col-span-2 xl:col-span-8"
          >
            {/* Ruling #6 (never a flat zero line for insufficient data) applies
              here too, though the brief's own Step 8 code omits it: six
              months of a genuinely new account is six zero points, and a line
              flat at zero across all of them is the same "measurement nobody
              took" the balance-history widget below guards against. */}
            {vm.cashFlowTrend.every((point) => point.income === 0 && point.expense === 0) ? (
              <EmptyState icon={Activity} title={t('dashboard.emptyCashFlowTitle')} />
            ) : (
              <CashFlowTrendChart
                data={vm.cashFlowTrend}
                currency={vm.displayCurrency}
                locale={locale}
                height={CHART_HEIGHT.tall}
                summary={t('dashboard.cashFlowTrendSummary', {
                  currency: vm.displayCurrency,
                  from: vm.cashFlowTrend[0]?.label ?? '',
                  to: vm.cashFlowTrend.at(-1)?.label ?? '',
                })}
                seriesLabels={{
                  income: t('dashboard.chartSeriesIncome'),
                  expense: t('dashboard.chartSeriesExpense'),
                  netIncome: t('dashboard.netIncome'),
                }}
              />
            )}
          </ChartContainer>

          <ChartContainer
            title={t('dashboard.expenseByCategory')}
            height={CHART_HEIGHT.tall}
            className="order-5 md:col-span-1 xl:order-2 xl:col-span-4"
          >
            {vm.expenseByCategory.length === 0 ? (
              <EmptyState icon={PieChart} title={t('dashboard.emptyExpenseTitle')} />
            ) : (
              <ExpenseByCategoryChart
                data={vm.expenseByCategory.map((row) => ({
                  ...row,
                  name: row.nameKey ? t(row.nameKey) : row.name,
                }))}
                currency={vm.displayCurrency}
                locale={locale}
                height={CHART_HEIGHT.tall}
                summary={t('dashboard.expenseByCategorySummary', {
                  count: vm.expenseByCategory.length,
                  currency: vm.displayCurrency,
                })}
                seriesLabel={t('dashboard.chartSeriesSpent')}
              />
            )}
          </ChartContainer>

          {/* Row 4: balance history 8/12 h260 + income vs expense 4/12 h260 */}
          <ChartContainer
            title={t('dashboard.balanceOverTime')}
            caption={t('dashboard.balanceOverTimeCaption')}
            height={CHART_HEIGHT.medium}
            className="order-10 md:col-span-2 xl:order-3 xl:col-span-8"
          >
            {/* The spec is explicit: an empty balance history shows the EMPTY
              STATE, not a flat zero line — a line at zero across six months is
              a measurement nobody took. `every(point => balance === null)` is
              the honest test for an FX gap; a user with literally no accounts
              yet (`vm.distribution` — already computed for the widget below —
              comes back `[]`, never `null`, when there is simply nothing to
              list) gets a real `0` at every point instead of a gap, and a flat
              line at zero for an empty portfolio is the same "measurement
              nobody took" the gap case guards against, so it takes the same
              empty state. */}
            {vm.balanceOverTime.every((point) => point.balance === null) ||
            (vm.distribution !== null && vm.distribution.length === 0) ? (
              <EmptyState
                icon={LineChart}
                title={t('dashboard.emptyBalanceHistoryTitle')}
                description={t('dashboard.emptyBalanceHistoryBody')}
              />
            ) : (
              <AccountBalanceHistoryChart
                data={vm.balanceOverTime}
                currency={vm.displayCurrency}
                locale={locale}
                height={CHART_HEIGHT.medium}
                summary={
                  t('dashboard.balanceOverTimeSummary', { currency: vm.displayCurrency }) +
                  t('dashboard.balanceOverTimeGapsSuffix', {
                    count: vm.balanceOverTime.filter((point) => point.balance === null).length,
                  })
                }
                seriesLabel={t('dashboard.chartSeriesAccountBalance')}
              />
            )}
          </ChartContainer>

          <ChartContainer
            title={t('dashboard.incomeVsExpense')}
            height={CHART_HEIGHT.medium}
            className="order-9 md:col-span-1 xl:order-4 xl:col-span-4"
          >
            {/* Same reasoning as Cash Flow Trend above: two zero months is
              nothing to compare, not a comparison of nothing. */}
            {vm.incomeVsExpense.every((row) => row.income === 0 && row.expense === 0) ? (
              <EmptyState icon={BarChart3} title={t('dashboard.emptyIncomeVsExpenseTitle')} />
            ) : (
              <IncomeVsExpenseChart
                data={vm.incomeVsExpense}
                currency={vm.displayCurrency}
                locale={locale}
                height={CHART_HEIGHT.medium}
                summary={t('dashboard.incomeVsExpenseSummary', {
                  currency: vm.displayCurrency,
                  periods: vm.incomeVsExpense.map((row) => row.period).join(', '),
                })}
                seriesLabels={{
                  income: t('dashboard.chartSeriesIncome'),
                  expense: t('dashboard.chartSeriesExpense'),
                }}
              />
            )}
          </ChartContainer>

          {/* Row 5: three planning widgets, 4/12 each, h ≤ 240, ≤ 3 rows + a link */}
          <ChartContainer
            title={t('dashboard.accountDistribution')}
            className="order-11 md:col-span-1 xl:order-5 xl:col-span-4"
          >
            {vm.distribution === null ? (
              <EmptyState icon={Wallet} title={t('dashboard.distributionFxUnavailable')} />
            ) : vm.distribution.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title={t('dashboard.emptyDistributionTitle')}
                action={{ label: t('dashboard.emptyDistributionAction'), href: '/accounts' }}
              />
            ) : (
              <AccountDistributionChart
                data={vm.distribution}
                currency={vm.displayCurrency}
                locale={locale}
                height={CHART_HEIGHT.short}
                summary={t('dashboard.accountDistributionSummary', {
                  count: vm.distribution.length,
                  currency: vm.displayCurrency,
                })}
                seriesLabel={t('dashboard.chartSeriesBalance')}
              />
            )}
          </ChartContainer>

          <ChartContainer
            title={t('dashboard.budgetProgress')}
            caption={t('dashboard.budgetProgressCaption')}
            right={
              vm.budgets.length > 0 ? (
                <Link
                  href="/budgets"
                  className="text-xs/[1rem] text-brand underline-offset-4 hover:underline"
                >
                  {t('dashboard.viewAllBudgets')}
                </Link>
              ) : undefined
            }
            className="order-3 md:col-span-1 xl:order-6 xl:col-span-4"
          >
            {vm.budgets.length === 0 ? (
              <EmptyState
                icon={Target}
                title={t('dashboard.emptyBudgetsTitle')}
                action={{ label: t('dashboard.emptyBudgetsAction'), href: '/budgets' }}
              />
            ) : (
              <BudgetProgressList
                budgets={vm.budgets.slice(0, WIDGET_ROWS)}
                locale={locale}
                compact
              />
            )}
          </ChartContainer>

          <ChartContainer
            title={t('dashboard.savingsGoals')}
            caption={t('dashboard.savingsGoalsCaption')}
            right={
              vm.savingsGoals.length > 0 ? (
                <Link
                  href="/goals"
                  className="text-xs/[1rem] text-brand underline-offset-4 hover:underline"
                >
                  {t('dashboard.viewAllGoals')}
                </Link>
              ) : undefined
            }
            className="order-7 md:col-span-1 xl:order-7 xl:col-span-4"
          >
            {vm.savingsGoals.length === 0 ? (
              <EmptyState
                icon={PiggyBank}
                title={t('dashboard.emptyGoalsTitle')}
                action={{ label: t('dashboard.emptyGoalsAction'), href: '/goals' }}
              />
            ) : (
              <GoalList
                goals={vm.savingsGoals.slice(0, WIDGET_ROWS)}
                locale={locale}
                timeZone={timezone}
                compact
              />
            )}
          </ChartContainer>

          {/* Row 6: debt/loan 4/12 + reminders 8/12 */}
          <ChartContainer
            title={t('dashboard.debtLoanOverview')}
            caption={t('dashboard.debtLoanOverviewCaption', { currency: vm.displayCurrency })}
            className="order-8 md:col-span-1 xl:order-8 xl:col-span-4"
          >
            {vm.debtLoanOverview === null ? (
              <EmptyState icon={HandCoins} title={t('dashboard.debtLoanFxUnavailable')} />
            ) : (
              <DebtLoanOverview
                data={vm.debtLoanOverview}
                currency={vm.displayCurrency}
                labels={{
                  'dashboard.receivables': t('dashboard.receivables'),
                  'dashboard.payables': t('dashboard.payables'),
                  'dashboard.loanOutstanding': t('dashboard.loanOutstanding'),
                }}
                footnote={t('dashboard.debtLoanIncluded')}
              />
            )}
          </ChartContainer>

          <ChartContainer
            title={t('dashboard.upcomingReminders')}
            caption={t('dashboard.upcomingRemindersCaption', { days: OCCURRENCE_LOOKAHEAD_DAYS })}
            right={
              vm.upcomingReminders.length > 0 ? (
                <Link
                  href="/reminders"
                  className="text-xs/[1rem] text-brand underline-offset-4 hover:underline"
                >
                  {t('dashboard.viewAllReminders')}
                </Link>
              ) : undefined
            }
            className="order-4 md:col-span-2 xl:order-9 xl:col-span-8"
          >
            {vm.upcomingReminders.length === 0 ? (
              <EmptyState
                icon={BellRing}
                title={t('dashboard.emptyRemindersTitle', { days: OCCURRENCE_LOOKAHEAD_DAYS })}
                // The old `#new` anchor pointed at an inline create form that no
                // longer exists (Task 9 moved reminder creation behind the
                // Reminders page's header action/sheet, same as goals/debts/
                // loans) — so this links at the page itself, whose header
                // carries "Thêm nhắc nhở".
                action={{ label: t('dashboard.emptyRemindersAction'), href: '/reminders' }}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {/* A muted count, not a banner — the user needs to know how much
                  of it there is (the list shows at most two) without being
                  shouted at. Only the number carries colour, and the word
                  carries the meaning. */}
                {vm.overdueReminderCount > 0 && (
                  <p className="text-xs/[1rem] text-muted-foreground">
                    <span className="text-negative tabular-nums">
                      {t('dashboard.overdueCount', { count: vm.overdueReminderCount })}
                    </span>
                  </p>
                )}
                {/* `collapse` is deliberately omitted (default `false`, per the
                  prop's own doc on `OccurrenceList`): the widget shows at most
                  five rows in total, and a "+n kỳ" badge here would explain a
                  list the user cannot expand. No inner card border either — a
                  card inside `ChartContainer`'s own card would be a
                  card-in-card. */}
                <OccurrenceList
                  occurrences={vm.upcomingReminders}
                  locale={locale}
                  timeZone={timezone}
                  compact
                />
              </div>
            )}
          </ChartContainer>

          {/* Row 7: the ledger, full width and LAST on desktop — the widgets
            above are what the user came to decide something from, and the
            ledger is what they scroll to when they want to check one of them.
            On a phone it is second (order-2), because checking one entry is
            what a phone is for. */}
          <ChartContainer
            title={t('dashboard.recentTransactions')}
            className="order-2 md:col-span-2 xl:order-10 xl:col-span-12"
          >
            <RecentTransactions
              transactions={vm.recentTransactions}
              locale={locale}
              timeZone={timezone}
              mobileLimit={5}
            />
          </ChartContainer>
        </div>
      )}
    </div>
  )
}
