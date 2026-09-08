import { Prisma, type TransactionType } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import type { Currency } from '@/lib/currency/provider'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import type { AccountBalancePoint } from '@/lib/server/services/account-balance-history'
import type { CashFlowPoint, getActivitySummary } from '@/lib/server/services/activity'
import type { BudgetProgress } from '@/lib/server/services/budget'
import type { CurrentPosition } from '@/lib/server/services/position'
import type { OccurrenceRow } from '@/lib/server/services/reminder'
import type { SavingsGoalRow } from '@/lib/server/services/savings-goal'
import type { listTransactions } from '@/lib/server/services/transaction'
import { type BudgetProgressDto, toBudgetProgressDto } from './budget-view-model'
import { formatDate } from './format-date'
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
   * `dueAt` is in the past. Deliberately unbounded and *not* limited to the
   * lookahead window: an unanswered bill from three months ago is still a bill,
   * so it is in this list.
   *
   * Which is why the widget partitions it rather than taking the head (ruling
   * R6-23): a user with five old unanswered bills would otherwise get a widget
   * captioned "the next 30 days" containing nothing from the next 30 days.
   *
   * Expected amounts are in each reminder's own currency and are never
   * converted, so this widget too is untouched by an FX outage.
   */
  occurrences: OccurrenceRow[]
}

export interface KpiDto {
  /**
   * A key in `dashboard.json`. The view model is a pure function with a unit
   * test and no translator; the component that renders the panel has one.
   */
  labelKey: string
  /** The formatted figure, or `null` when there is no honest one to show. */
  value: string | null
  /** Key for the line rendered in place of a `null` value, explaining the gap. */
  hintKey?: string
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
  /** Set instead of `name` for a synthesised row the component must translate. */
  nameKey?: string
}

export interface RecentTransactionDto {
  id: string
  /** The category when there is one; `null` when the TYPE is the meaning. */
  categoryName: string | null
  /**
   * The raw type. Rendered through `transactionTypeLabelKey` by the component —
   * which is what stopped `CASH_OUT` appearing on the dashboard verbatim.
   */
  type: TransactionType
  accountName: string
  /** The instant; the component formats it in the reader's locale and zone. */
  date: Date
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
  /**
   * The current local month as a `Date` the page formats — no longer a
   * pre-baked string. The header's month-and-currency line is assembled by the
   * page from `formatDate(monthStart, { locale, timeZone, style: 'monthYear' })`
   * and `dashboard.subtitle`, because "September 2026 · VND" is a sentence in
   * one language and a view model has no locale.
   */
  monthStart: Date
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
  /**
   * The reminders widget's rows: at most two overdue occurrences (oldest first)
   * and then genuinely upcoming ones (soonest first), five in all, each in its
   * reminder's own currency. Empty only when nothing at all is pending.
   *
   * The two-row cap on the overdue half is the whole point (ruling R6-23):
   * taking the head of a `dueAt asc` list filled the widget with months-old
   * rows and pushed everything actually coming out of it. Two is enough to say
   * "you are behind" and leaves three slots for what the widget is for; the
   * Reminders page is where the full overdue list lives.
   */
  upcomingReminders: OccurrenceDto[]
  /**
   * How many PENDING occurrences are already past due — *all* of them, not just
   * the ones above, so the widget can say "7 overdue" while showing two of
   * them. Zero when the user is up to date.
   */
  overdueReminderCount: number
}

/** Key for the line shown instead of a figure that would need a rate we do not have. */
const FX_UNAVAILABLE_HINT_KEY = 'dashboard.fxUnavailableHint'

/** How many category bars the widget shows before bucketing the rest. */
const EXPENSE_CATEGORY_LIMIT = 8

/** The bucket's name is a KEY; the component translates it. */
const OTHER_CATEGORY_KEY = 'dashboard.expenseByCategoryOther'

/**
 * At most eight slices plus an "other" bucket (spec §6.1): a horizontal bar
 * chart with twenty rows is a table pretending to be a picture. The source is
 * already largest-first with a stable tiebreak (`getActivitySummary`), so the
 * tail is genuinely the smallest categories and the bucket's total is their
 * exact sum — a `Decimal` sum taken before `toNumber()`.
 */
function bucketExpenseCategories(rows: MonthSummary['byCategory']): NamedAmountDto[] {
  if (rows.length <= EXPENSE_CATEGORY_LIMIT) {
    return rows.map((row) => ({ name: row.name, value: row.total.toNumber() }))
  }
  const head = rows.slice(0, EXPENSE_CATEGORY_LIMIT - 1)
  const tail = rows.slice(EXPENSE_CATEGORY_LIMIT - 1)
  const tailTotal = tail.reduce((sum, row) => sum.add(row.total), new Prisma.Decimal(0))
  return [
    ...head.map((row) => ({ name: row.name, value: row.total.toNumber() })),
    { name: '', nameKey: OTHER_CATEGORY_KEY, value: tailTotal.toNumber() },
  ]
}

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

/**
 * How many of the reminders widget's five rows an overdue occurrence may take
 * (ruling R6-23).
 *
 * `listUpcomingOccurrences` is unbounded and ordered `dueAt asc`, so the head of
 * it is the *oldest unanswered* bill, not the next one due. Five slots filled
 * from that head is a widget captioned "the next 30 days" showing nothing from
 * the next 30 days — the state a user with a few forgotten bills lives in
 * permanently. Two says "you are behind, and here is the oldest of it" and
 * still leaves three slots for what the widget exists to show; the count beside
 * the list carries the rest, and the Reminders page has the complete group.
 */
const WIDGET_OVERDUE_ROW_LIMIT = 2

export function buildDashboardViewModel(
  input: DashboardInput,
  /**
   * The reader's locale (fix round 1, finding 1). Optional and trailing,
   * defaulting to `vi`, so no existing caller or test moves — `formatMoney`/
   * `formatRate`/`formatDate` all take the same optional-trailing-locale
   * shape for the same reason. Every figure and chart-axis label this
   * function produces threads it through; the page passes the resolved
   * locale once it has one (`resolveLocale()`).
   */
  locale: Locale = DEFAULT_LOCALE,
): DashboardViewModel {
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

  /** A current-position KPI: a figure, or a gap with the reason for it. */
  function positionKpi(labelKey: string, value: Prisma.Decimal | undefined): KpiDto {
    if (!position || value === undefined) {
      return { labelKey, value: null, hintKey: FX_UNAVAILABLE_HINT_KEY, negative: false }
    }
    return { labelKey, value: formatMoney(value, currency, locale), negative: value.isNegative() }
  }

  // Net Worth FIRST: it is the panel's dominant figure (spec §6.1), with Total
  // Balance beneath it, and the three monthly metrics after. The old order put
  // Total Account Balance first because the five sat in a flat strip where
  // nothing was dominant.
  const kpis: KpiDto[] = [
    positionKpi('dashboard.netWorth', position?.netWorth),
    positionKpi('dashboard.totalBalance', position?.totalBalance),
    {
      labelKey: 'dashboard.monthlyIncome',
      value: formatMoney(monthly.income, currency, locale),
      negative: false,
    },
    // Expense is stored and aggregated as a positive magnitude, so it is never
    // "negative" — red by meaning, not by sign, and the panel does not colour it.
    {
      labelKey: 'dashboard.monthlyExpense',
      value: formatMoney(monthly.expense, currency, locale),
      negative: false,
    },
    {
      labelKey: 'dashboard.netIncome',
      value: formatMoney(monthly.netIncome, currency, locale),
      negative: monthly.netIncome.isNegative(),
    },
  ]

  // Mapped in full before anything is dropped, unlike the goals above — the
  // count needs every pending occurrence classified, and `overdue` is decided
  // by `toOccurrenceDto` (a calendar-day comparison in the user's zone, ruling
  // R6-7). Re-deriving it here to save formatting the rows the widget will not
  // show would be a second definition of "late", which is the one thing this
  // page must not have; the Reminders page maps the same list in full.
  const allOccurrences = occurrences.map((row) => toOccurrenceDto(row, timezone, today))
  const overdueOccurrences = allOccurrences.filter((occurrence) => occurrence.overdue)
  // Both halves keep the service's `dueAt asc` order — oldest overdue first,
  // soonest upcoming first — exactly as the Reminders page groups them.
  const upcomingOccurrences = allOccurrences.filter((occurrence) => !occurrence.overdue)

  return {
    displayCurrency: currency,
    monthStart: now,
    kpis,
    fxStatus: buildFxStatus(position, timezone, locale),
    // `monthShort`/`monthYearShort` (fix round 1, finding 2): a plain
    // `formatInTimeZone(..., 'LLL')` always formats in date-fns' own default
    // locale (English) regardless of the reader's — the exact bug this fix
    // exists for, since "Apr … Sep" ticks under a Vietnamese dashboard is
    // exactly the kind of un-translated surface the rest of this task removes.
    cashFlowTrend: cashFlowTrend.map((point) => ({
      label: formatDate(point.startUtc, { locale, timeZone: timezone, style: 'monthShort' }),
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
      period: formatDate(point.startUtc, { locale, timeZone: timezone, style: 'monthYearShort' }),
      income: point.income.toNumber(),
      expense: point.expense.toNumber(),
    })),
    balanceOverTime: balanceOverTime.map((point) => ({
      label: formatDate(point.asOf, { locale, timeZone: timezone, style: 'monthShort' }),
      // Preserved as `null`, never coerced to 0: a month with no known rate is
      // a hole in the line, and a zero would draw a cliff that never happened.
      balance: point.balance === null ? null : point.balance.toNumber(),
    })),
    // The same month aggregate the three monthly KPIs come from, so the slices
    // sum to the Monthly Expense card by construction. Already largest-first
    // with a stable tiebreak (`getActivitySummary`). At most eight slices plus
    // an "other" bucket (spec §6.1) — see `bucketExpenseCategories`.
    expenseByCategory: bucketExpenseCategories(monthly.byCategory),
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
        // The NAME or `null` — never `?? tx.type`, which is how `CASH_OUT`
        // used to reach the screen. The component renders the type's label.
        categoryName: tx.category?.name ?? null,
        type: tx.type,
        accountName: tx.account.name,
        date: tx.date,
        // The sign is derived from `type` here and prefixed to the formatted
        // magnitude — `amount` itself is always positive and no arithmetic
        // negates it.
        amount: `${positive ? '+' : '−'}${formatMoney(tx.amount, tx.currency, locale)}`,
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
    // Wrapped rather than passed bare: `Array#map` calls its callback with
    // `(element, index, array)`, and `toBudgetProgressDto` now takes a second
    // `locale` parameter — passed bare, `map`'s own index would land there as
    // `locale` for every row after the first. This dashboard call intentionally
    // stays at the DTO's default locale (`vi`); Task 7's Budgets/Savings pages
    // are what thread the reader's actual locale through.
    budgets: budgets.map((progress) => toBudgetProgressDto(progress)),
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
            receivables: formatMoney(position.receivables, currency, locale),
            payables: formatMoney(position.payables, currency, locale),
            loanOutstanding: formatMoney(position.loanOutstanding, currency, locale),
          },
    // At most two overdue rows, then whatever is genuinely coming, five in all.
    // The single `slice` at the end is what makes the overdue half a *cap*
    // rather than a reservation: one overdue occurrence takes one slot and
    // leaves four for the upcoming ones, and a user with nothing overdue sees
    // five upcoming rows exactly as before.
    upcomingReminders: [
      ...overdueOccurrences.slice(0, WIDGET_OVERDUE_ROW_LIMIT),
      ...upcomingOccurrences,
    ].slice(0, WIDGET_ROW_LIMIT),
    // The full tally, not the number shown: the widget's one muted line is the
    // only place the user learns that the two rows above it are the tip of
    // seven.
    overdueReminderCount: overdueOccurrences.length,
  }
}

function buildFxStatus(
  position: CurrentPosition | null,
  timezone: string,
  locale: Locale,
): FxStatus {
  // A null position means the conversion was required and refused — distinct
  // from a position that simply never needed one.
  if (position === null) return { kind: 'unavailable' }
  if (position.fx === null) return { kind: 'not-needed' }
  const { fx } = position
  const details: FxRateDetails = {
    rate: formatRate(fx.rateDecimal, locale),
    // The rate's own day, in UTC: `effectiveDate` is a UTC start-of-day marker
    // (see the `ExchangeRate` model), not an instant to re-project.
    effectiveDate: formatInTimeZone(fx.effectiveDate, 'UTC', 'yyyy-MM-dd'),
    // `fetchedAt` *is* an instant, so it is shown on the user's clock.
    updatedAt: formatInTimeZone(fx.fetchedAt, timezone, 'yyyy-MM-dd HH:mm'),
  }
  return fx.isFallback ? { kind: 'fallback', ...details } : { kind: 'available', ...details }
}
