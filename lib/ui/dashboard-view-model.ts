import type { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import type { Currency } from '@/lib/currency/provider'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import type { AccountBalancePoint } from '@/lib/server/services/account-balance-history'
import type { CashFlowPoint, getActivitySummary } from '@/lib/server/services/activity'
import type { BudgetProgress } from '@/lib/server/services/budget'
import type { CurrentPosition } from '@/lib/server/services/position'
import type { OccurrenceRow } from '@/lib/server/services/reminder'
import type { SavingsGoalRow } from '@/lib/server/services/savings-goal'
import type { listTransactions } from '@/lib/server/services/transaction'
import { type BudgetProgressDto, toBudgetProgressDto } from './budget-view-model'
import { formatMoney, formatRate } from './format-money'
import { type OccurrenceDto, toOccurrenceDto } from './reminder-view-model'
import { type SavingsGoalDto, toSavingsGoalDto } from './savings-goal-view-model'

/**
 * The dashboard's DTO boundary, as one pure function.
 *
 * Everything the page fetches arrives here as `Prisma.Decimal` and `Date`, and
 * everything that leaves is a plain string or number. That matters twice over:
 * a `Decimal` cannot cross into a client component at all, and the widening to
 * `number` that a chart library needs is lossy — so it happens once, here, at
 * the very end of the pipeline, and never anywhere a further calculation could
 * pick the result back up.
 *
 * It is a function rather than inline mapping in the page so the mapping can be
 * tested without a database, a session or a React renderer: given service
 * results, does the dashboard say the right thing — including when FX is out.
 */

/** `getActivitySummary`'s shape, borrowed so the two cannot drift apart. */
export type MonthSummary = Awaited<ReturnType<typeof getActivitySummary>>

/** One row of `listTransactions`. */
export type RecentTransactionRow = Awaited<ReturnType<typeof listTransactions>>[number]

export interface DashboardInput {
  displayCurrency: Currency
  /** The user's IANA zone — every date on this page is rendered in it, never in the server's. */
  timezone: string
  now: Date
  /**
   * The user's own calendar day (`yyyy-MM-dd`, from `todayCalendarDateInZone`)
   * — what "overdue" and "due tomorrow" are measured against.
   *
   * Passed in rather than derived from `now` here so it is one value for the
   * whole page: the goals widget's missed deadlines and the reminders widget's
   * due labels are then answering the same question about the same day. It is
   * a *calendar* comparison in the user's zone throughout, never an instant
   * one in the server's (ruling R6-7).
   */
  today: string
  /**
   * `null` when the current position needed an FX conversion and no usable rate
   * existed. Only the two current-position KPIs and the distribution chart
   * depend on it; every historical figure below is unaffected by design.
   */
  position: CurrentPosition | null
  /**
   * The current local month, scanned once. It carries the three monthly KPI
   * figures *and* `byCategory`, which is the Expense by Category chart — one
   * aggregate, so the pie chart's slices always add up to the Monthly Expense
   * card above it.
   */
  monthly: MonthSummary
  /**
   * The trend, oldest first. Its last two points are also the Income vs Expense
   * comparison: the trend's windows are the same local calendar months, so
   * deriving the comparison from them rather than re-scanning makes the two
   * charts agree by construction instead of by coincidence.
   */
  cashFlowTrend: CashFlowPoint[]
  balanceOverTime: AccountBalancePoint[]
  recentTransactions: RecentTransactionRow[]
  /**
   * Progress for the budgets the user set for the **current local month**, from
   * `getBudgetProgressForMonth` — i.e. summed from each contributing row's own
   * FX snapshot. `position.fx` is nowhere near it, so the widget reads the same
   * during an FX outage as it does with a live rate, and each budget stays in
   * its own currency rather than being restated in `displayCurrency`
   * (ruling R5-3).
   */
  budgets: BudgetProgress[]
  /**
   * The goals the user is still tracking, from `listSavingsGoals` — which
   * already excludes ARCHIVED rows and puts the ones still in progress first,
   * so the widget shows the top of that list rather than re-deciding its order.
   *
   * Each goal keeps its own currency and none is converted (ruling R5-3), so
   * this widget reads the same during an FX outage as it does with a live rate.
   */
  goals: SavingsGoalRow[]
  /**
   * Every PENDING occurrence, soonest first, from `listUpcomingOccurrences` —
   * which puts the overdue ones at the top by construction because their
   * `dueAt` is in the past.
   *
   * Expected amounts are in each reminder's own currency and are never
   * converted, so this widget too is untouched by an FX outage.
   */
  occurrences: OccurrenceRow[]
}

export interface KpiDto {
  label: string
  /** The formatted figure, or `null` when there is no honest one to show. */
  value: string | null
  /** Rendered in place of a `null` value, explaining the gap. */
  hint?: string
  /** Below zero — rendered in the negative colour. */
  negative: boolean
}

interface FxRateDetails {
  /** The rate itself, formatted. Always VND per 1 USD. */
  rate: string
  /** `yyyy-MM-dd` — the day the rate applies to. */
  effectiveDate: string
  /** `yyyy-MM-dd HH:mm` in the user's zone — when we fetched it. */
  updatedAt: string
}

/**
 * Which of the four things the page can honestly say about FX:
 * nothing needed converting, here is the rate, here is a stale rate, or there
 * is no rate and the converted figures are withheld.
 */
export type FxStatus =
  | { kind: 'not-needed' }
  | { kind: 'unavailable' }
  | ({ kind: 'available' } & FxRateDetails)
  | ({ kind: 'fallback' } & FxRateDetails)

export interface TrendPointDto {
  /** Short axis label, e.g. `Sep`. Unique across a ≤ 12-month window. */
  label: string
  income: number
  expense: number
  netIncome: number
}

export interface ComparisonBarDto {
  period: string
  income: number
  expense: number
}

export interface BalancePointDto {
  label: string
  /** `null` where that month's rate is unknown — the chart renders a gap. */
  balance: number | null
}

export interface NamedAmountDto {
  name: string
  value: number
}

export interface RecentTransactionDto {
  id: string
  /** The category, or the transaction type when there is none. */
  title: string
  accountName: string
  /** `yyyy-MM-dd HH:mm` in the user's zone. */
  when: string
  /** Already signed — the sign comes from `type`, never from the amount. */
  amount: string
  currency: Currency
  positive: boolean
}

/**
 * The three current-position aggregates behind the Net Worth card, already
 * formatted in the display currency.
 *
 * Strings, not `Decimal`s or numbers: they are read, never recomputed, and the
 * widget that renders them must be able to be a plain server component with no
 * money type crossing into it.
 */
export interface DebtLoanOverviewDto {
  /** Owed *to* the user — the term that adds to Net Worth. */
  receivables: string
  /** Owed *by* the user on debts — subtracts. */
  payables: string
  /** Loan principal still outstanding — subtracts. Interest paid is not part
   *  of it. */
  loanOutstanding: string
}

export interface DashboardViewModel {
  displayCurrency: Currency
  /** e.g. `September 2026`. */
  monthLabel: string
  /** e.g. `September 2026 · VND`. */
  subtitle: string
  kpis: KpiDto[]
  fxStatus: FxStatus
  cashFlowTrend: TrendPointDto[]
  incomeVsExpense: ComparisonBarDto[]
  balanceOverTime: BalancePointDto[]
  expenseByCategory: NamedAmountDto[]
  /** `null` when the position is unavailable — a distribution of nothing is not a chart. */
  distribution: NamedAmountDto[] | null
  recentTransactions: RecentTransactionDto[]
  /** This month's budgets, each already formatted in its OWN currency — the
   *  widget shows a USD budget in USD under a VND dashboard. Empty when the
   *  user set none for the month. */
  budgets: BudgetProgressDto[]
  /** The goals widget: non-archived goals, in progress first, capped — each in
   *  its own currency. Empty when the user has set none. */
  savingsGoals: SavingsGoalDto[]
  /** `null` when the position is unavailable — three outstanding amounts that
   *  could not be converted are not comparable, and inventing a zero would say
   *  the user owes nothing. */
  debtLoanOverview: DebtLoanOverviewDto | null
  /** The reminders widget: the next few PENDING occurrences, overdue first,
   *  each in its reminder's own currency. Empty when nothing is due. */
  upcomingReminders: OccurrenceDto[]
}

/** Shown instead of a figure that would need a rate we do not have. */
const FX_UNAVAILABLE_HINT = 'FX unavailable'

/**
 * How many rows the two list widgets show.
 *
 * A dashboard widget is a glance, not a page: both the Savings page and the
 * Reminders page list everything the user has (deliberately unbounded — a cap
 * on their own data would be the app quietly forgetting some of it), and each
 * widget links through to its page. Five is the same number Recent Transactions
 * shows, so the column of widgets stays one height.
 */
const WIDGET_ROW_LIMIT = 5

export function buildDashboardViewModel(input: DashboardInput): DashboardViewModel {
  const {
    displayCurrency: currency,
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
  } = input

  const monthLabel = formatInTimeZone(now, timezone, 'LLLL yyyy')

  /** A current-position KPI: a figure, or a gap with the reason for it. */
  function positionKpi(label: string, value: Prisma.Decimal | undefined): KpiDto {
    if (!position || value === undefined) {
      return { label, value: null, hint: FX_UNAVAILABLE_HINT, negative: false }
    }
    return { label, value: formatMoney(value, currency), negative: value.isNegative() }
  }

  const kpis: KpiDto[] = [
    // "Total Account Balance", not "Total Balance": the figure is the sum of the
    // *account* balances (spec §5.2), and Phase 6's Net Worth widens beyond
    // them — a card labelled just "Total Balance" would then read as the wrong
    // total. The export's Summary sheet says the same thing.
    positionKpi('Total Account Balance', position?.totalBalance),
    positionKpi('Net Worth', position?.netWorth),
    { label: 'Monthly Income', value: formatMoney(monthly.income, currency), negative: false },
    // Expense is stored and aggregated as a positive magnitude, so it is never
    // "negative" — it is red-by-meaning, not red-by-sign, and the strip does
    // not colour it.
    { label: 'Monthly Expense', value: formatMoney(monthly.expense, currency), negative: false },
    {
      label: 'Net Income',
      value: formatMoney(monthly.netIncome, currency),
      negative: monthly.netIncome.isNegative(),
    },
  ]

  return {
    displayCurrency: currency,
    monthLabel,
    subtitle: `${monthLabel} · ${currency}`,
    kpis,
    fxStatus: buildFxStatus(position, timezone),
    cashFlowTrend: cashFlowTrend.map((point) => ({
      label: formatInTimeZone(point.startUtc, timezone, 'LLL'),
      income: point.income.toNumber(),
      expense: point.expense.toNumber(),
      netIncome: point.netIncome.toNumber(),
    })),
    // The trend's last two points — last month beside this one. Derived rather
    // than fetched: the trend's windows *are* the local calendar months, so the
    // comparison chart cannot show a different figure from the trend's final
    // point, and the month is scanned once instead of three times. A trend
    // shorter than two points yields whatever it has rather than a fabricated
    // zero month.
    incomeVsExpense: cashFlowTrend.slice(-2).map((point) => ({
      period: formatInTimeZone(point.startUtc, timezone, 'LLL yyyy'),
      income: point.income.toNumber(),
      expense: point.expense.toNumber(),
    })),
    balanceOverTime: balanceOverTime.map((point) => ({
      label: formatInTimeZone(point.asOf, timezone, 'LLL'),
      // Preserved as `null`, never coerced to 0: a month with no known rate is
      // a hole in the line, and a zero would draw a cliff that never happened.
      balance: point.balance === null ? null : point.balance.toNumber(),
    })),
    // The same month aggregate the three monthly KPIs come from, so the slices
    // sum to the Monthly Expense card by construction. Already largest-first
    // with a stable tiebreak (`getActivitySummary`).
    expenseByCategory: monthly.byCategory.map((row) => ({
      name: row.name,
      value: row.total.toNumber(),
    })),
    distribution:
      position === null
        ? null
        : position.accounts
            .map((account) => ({
              name: account.name,
              // `displayBalance`, never `nativeBalance`: charting 100 (USD)
              // beside 1.000.000 (VND) says nothing true about their sizes.
              value: account.displayBalance.toNumber(),
            }))
            // Largest first, so the bars read top-down. `localeCompare` on the
            // name breaks a tie so two equal balances cannot swap places
            // between renders (account names are not unique, but the pairing is
            // stable enough for a chart's row order).
            .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
    recentTransactions: recentTransactions.map((tx) => {
      const positive = isBalanceIncreasing(tx.type)
      return {
        id: tx.id,
        title: tx.category?.name ?? tx.type,
        accountName: tx.account.name,
        when: formatInTimeZone(tx.date, timezone, 'yyyy-MM-dd HH:mm'),
        // The sign is derived from `type` here and prefixed to the formatted
        // magnitude — `amount` itself is always positive and no arithmetic
        // negates it.
        amount: `${positive ? '+' : '−'}${formatMoney(tx.amount, tx.currency)}`,
        currency: tx.currency,
        positive,
      }
    }),
    // Delegated to the budgets page's own DTO mapper rather than re-derived
    // here: the dashboard's compact rows and the Budgets page's full rows are
    // the same `BudgetProgressList` fed by the same function, so a percentage
    // or a status label cannot read one way on one page and another way on the
    // other. `displayCurrency` is deliberately not passed — a budget is shown
    // in its own currency.
    budgets: budgets.map(toBudgetProgressDto),
    // Delegated to the Savings page's own DTO mapper, for the reason the
    // budgets line gives: the widget's compact rows and the page's full rows
    // are the same `GoalList` fed by the same function, so a percentage or a
    // status label cannot read one way on one page and another way on the
    // other.
    //
    // The ARCHIVED filter is belt and braces — `listSavingsGoals` already
    // excludes them — and it runs *before* the cap, so an archived row could
    // never take a visible goal's slot. `today` is what decides whether a
    // deadline has been missed.
    savingsGoals: goals
      .filter((goal) => goal.status !== 'ARCHIVED')
      .slice(0, WIDGET_ROW_LIMIT)
      .map((goal) => toSavingsGoalDto(goal, today)),
    // The three figures the position already converted, formatted once here.
    // `null` propagates the position's own refusal: three outstanding amounts
    // that could not be restated in one currency cannot be compared, and a
    // fabricated zero would tell the user they owe nothing (spec §6.3).
    debtLoanOverview:
      position === null
        ? null
        : {
            receivables: formatMoney(position.receivables, currency),
            payables: formatMoney(position.payables, currency),
            loanOutstanding: formatMoney(position.loanOutstanding, currency),
          },
    // Capped before mapping, so no row is formatted only to be dropped. The
    // service's `dueAt asc` order is kept exactly as it is: it puts the
    // occurrences the user is already late for at the top by construction, so
    // re-sorting on `overdue` here would be the same order computed twice.
    upcomingReminders: occurrences
      .slice(0, WIDGET_ROW_LIMIT)
      .map((row) => toOccurrenceDto(row, timezone, today)),
  }
}

function buildFxStatus(position: CurrentPosition | null, timezone: string): FxStatus {
  // A null position means the conversion was required and refused — distinct
  // from a position that simply never needed one.
  if (position === null) return { kind: 'unavailable' }
  if (position.fx === null) return { kind: 'not-needed' }
  const { fx } = position
  const details: FxRateDetails = {
    rate: formatRate(fx.rateDecimal),
    // The rate's own day, in UTC: `effectiveDate` is a UTC start-of-day marker
    // (see the `ExchangeRate` model), not an instant to re-project.
    effectiveDate: formatInTimeZone(fx.effectiveDate, 'UTC', 'yyyy-MM-dd'),
    // `fetchedAt` *is* an instant, so it is shown on the user's clock.
    updatedAt: formatInTimeZone(fx.fetchedAt, timezone, 'yyyy-MM-dd HH:mm'),
  }
  return fx.isFallback ? { kind: 'fallback', ...details } : { kind: 'available', ...details }
}
