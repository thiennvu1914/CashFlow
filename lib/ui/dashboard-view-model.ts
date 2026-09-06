import type { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import type { Currency } from '@/lib/currency/provider'
import { isBalanceIncreasing } from '@/lib/money/transaction-sign'
import type { AccountBalancePoint } from '@/lib/server/services/account-balance-history'
import type {
  CashFlowPoint,
  CategoryTotal,
  getMonthlyIncomeExpense,
} from '@/lib/server/services/activity'
import type { CurrentPosition } from '@/lib/server/services/position'
import type { listTransactions } from '@/lib/server/services/transaction'
import { formatMoney, formatRate } from './format-money'

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

/** `getMonthlyIncomeExpense`'s shape, borrowed so the two cannot drift apart. */
export type MonthlyTotals = Awaited<ReturnType<typeof getMonthlyIncomeExpense>>

/** One row of `listTransactions`. */
export type RecentTransactionRow = Awaited<ReturnType<typeof listTransactions>>[number]

export interface DashboardInput {
  displayCurrency: Currency
  /** The user's IANA zone — every date on this page is rendered in it, never in the server's. */
  timezone: string
  now: Date
  /**
   * `null` when the current position needed an FX conversion and no usable rate
   * existed. Only the two current-position KPIs and the distribution chart
   * depend on it; every historical figure below is unaffected by design.
   */
  position: CurrentPosition | null
  monthly: MonthlyTotals
  previousMonthly: MonthlyTotals
  cashFlowTrend: CashFlowPoint[]
  expenseByCategory: CategoryTotal[]
  balanceOverTime: AccountBalancePoint[]
  recentTransactions: RecentTransactionRow[]
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
}

/** Shown instead of a figure that would need a rate we do not have. */
const FX_UNAVAILABLE_HINT = 'FX unavailable'

export function buildDashboardViewModel(input: DashboardInput): DashboardViewModel {
  const {
    displayCurrency: currency,
    timezone,
    now,
    position,
    monthly,
    previousMonthly,
    cashFlowTrend,
    expenseByCategory,
    balanceOverTime,
    recentTransactions,
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
    positionKpi('Total Balance', position?.totalBalance),
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
    incomeVsExpense: [
      {
        period: formatInTimeZone(previousMonthly.startUtc, timezone, 'LLL yyyy'),
        income: previousMonthly.income.toNumber(),
        expense: previousMonthly.expense.toNumber(),
      },
      {
        period: formatInTimeZone(monthly.startUtc, timezone, 'LLL yyyy'),
        income: monthly.income.toNumber(),
        expense: monthly.expense.toNumber(),
      },
    ],
    balanceOverTime: balanceOverTime.map((point) => ({
      label: formatInTimeZone(point.asOf, timezone, 'LLL'),
      // Preserved as `null`, never coerced to 0: a month with no known rate is
      // a hole in the line, and a zero would draw a cliff that never happened.
      balance: point.balance === null ? null : point.balance.toNumber(),
    })),
    expenseByCategory: expenseByCategory.map((row) => ({
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
