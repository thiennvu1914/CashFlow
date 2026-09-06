import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import type { Currency } from '@/lib/currency/provider'
import { historicalAmountIn } from '@/lib/currency/historical-amount'
import { getRecentMonthWindows } from '@/lib/datetime/month-windows'
import { getPeriodBounds } from '@/lib/datetime/period-bounds'

/**
 * Historical activity — what actually happened over a window of time (spec
 * §5.5, §5.6).
 *
 * Every figure here is *history*, so every conversion goes through
 * `historicalAmountIn`, which restates a row at the rate that row snapshotted
 * at entry. Nothing in this module touches `getUsableCurrentRate`, the FX
 * provider or the `ExchangeRate` cache: last month's totals answer the same
 * number today, tomorrow and next year, whatever today's rate is doing. That
 * separation is the reason this file imports no FX policy at all.
 *
 * Only INCOME and EXPENSE are activity. CASH_IN, CASH_OUT and the two
 * ADJUSTMENT types move a balance without being earnings or spending, and a
 * Transfer is its own entity that never appears as either (spec §4.5) — none of
 * them is ever aggregated here.
 *
 * Results are `Prisma.Decimal` and unrounded: the pages map them to chart
 * numbers and the export applies its own scale.
 */

/** Placeholder name for expenses filed without a category. */
const UNCATEGORIZED = 'Uncategorized'

/** The activity types. Everything else is a balance movement, not activity. */
const ACTIVITY_TYPES = ['INCOME', 'EXPENSE'] as const

/**
 * Exactly the columns the aggregates need — amount, its currency and its FX
 * snapshot for `historicalAmountIn`, the type for the sign, and the two
 * grouping keys with their display names. Notably *not* the rows themselves:
 * the CSV export runs its own unbounded query rather than making every
 * dashboard call carry a full transaction list it will not use.
 */
const ACTIVITY_SELECT = {
  amount: true,
  currency: true,
  vndPerUsdAtEntry: true,
  type: true,
  accountId: true,
  categoryId: true,
  account: { select: { name: true } },
  category: { select: { name: true } },
} satisfies Prisma.TransactionSelect

export interface ActivityRange {
  startUtc: Date
  /** Exclusive, matching `getPeriodBounds`. */
  endUtc: Date
}

export interface CategoryTotal {
  /** `null` for expenses filed without a category. */
  categoryId: string | null
  name: string
  total: Prisma.Decimal
}

export interface AccountActivity {
  accountId: string
  name: string
  income: Prisma.Decimal
  expense: Prisma.Decimal
  netIncome: Prisma.Decimal
}

export interface ActivitySummary extends ActivityRange {
  income: Prisma.Decimal
  /** A positive magnitude — the direction is carried by the field, never a sign. */
  expense: Prisma.Decimal
  netIncome: Prisma.Decimal
  /** EXPENSE only, largest first — an income row has no place in a spending breakdown. */
  byCategory: CategoryTotal[]
  /** Every account with activity in the window, by name. */
  byAccount: AccountActivity[]
}

/**
 * The one aggregate every other function in this file is built from: a single
 * `findMany` over `[startUtc, endUtc)`, reduced in memory into the four views
 * the dashboard and reports need. One query, whatever the caller asked for, so
 * a page showing totals, a category chart and a per-account table costs the
 * same as a page showing only the totals.
 */
export async function getActivitySummary(
  userId: string,
  displayCurrency: Currency,
  range: ActivityRange,
): Promise<ActivitySummary> {
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      type: { in: [...ACTIVITY_TYPES] },
      // `lt`, never `lte`: `endUtc` is the first instant of the *next* period.
      date: { gte: range.startUtc, lt: range.endUtc },
    },
    select: ACTIVITY_SELECT,
  })

  let income = new Prisma.Decimal(0)
  let expense = new Prisma.Decimal(0)
  const byCategory = new Map<string | null, CategoryTotal>()
  const byAccount = new Map<string, AccountActivity>()

  for (const row of rows) {
    const amount = historicalAmountIn(displayCurrency, row)

    let account = byAccount.get(row.accountId)
    if (!account) {
      account = {
        accountId: row.accountId,
        name: row.account.name,
        income: new Prisma.Decimal(0),
        expense: new Prisma.Decimal(0),
        netIncome: new Prisma.Decimal(0),
      }
      byAccount.set(row.accountId, account)
    }

    if (row.type === 'INCOME') {
      income = income.add(amount)
      account.income = account.income.add(amount)
      continue
    }

    expense = expense.add(amount)
    account.expense = account.expense.add(amount)

    // Grouped by id rather than name: two categories may legitimately share a
    // name, and merging them would silently fold two lines of a report into one.
    const existing = byCategory.get(row.categoryId)
    if (existing) {
      existing.total = existing.total.add(amount)
    } else {
      byCategory.set(row.categoryId, {
        categoryId: row.categoryId,
        name: row.category?.name ?? UNCATEGORIZED,
        total: amount,
      })
    }
  }

  for (const account of byAccount.values()) {
    account.netIncome = account.income.sub(account.expense)
  }

  return {
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    income,
    expense,
    netIncome: income.sub(expense),
    // Both sorts carry an id tiebreak so the order is *total*, not merely
    // sorted: two categories with the same total (or two accounts sharing a
    // name — names are not unique) would otherwise be ordered by whatever
    // `Array#sort` happened to do with them, and the same data could render a
    // chart's bars, a report's rows and a CSV's lines in different orders on
    // two consecutive requests. The id is the one key guaranteed unique and
    // stable. `categoryId` is `null` for the uncategorised bucket; it sorts as
    // the empty string, i.e. first among ties, and there is only ever one of
    // it so no two rows can collide on that value.
    byCategory: [...byCategory.values()].sort(
      (a, b) =>
        b.total.comparedTo(a.total) || (a.categoryId ?? '').localeCompare(b.categoryId ?? ''),
    ),
    byAccount: [...byAccount.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId),
    ),
  }
}

/**
 * Income, expense and net income for the calendar month containing
 * `referenceDate`, as that month falls in the *user's* timezone — for a user in
 * `Asia/Ho_Chi_Minh` a transaction at 17:30Z on 31 March belongs to April,
 * because locally it is already 00:30 on 1 April.
 */
export async function getMonthlyIncomeExpense(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  referenceDate: Date = new Date(),
) {
  const range = getPeriodBounds(timezone, 'month', referenceDate)
  const { income, expense, netIncome, startUtc, endUtc } = await getActivitySummary(
    userId,
    displayCurrency,
    range,
  )
  return { income, expense, netIncome, startUtc, endUtc }
}

/** The month's spending per category, largest first — the pie chart's input. */
export async function getExpenseByCategory(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  referenceDate: Date = new Date(),
): Promise<CategoryTotal[]> {
  const range = getPeriodBounds(timezone, 'month', referenceDate)
  const { byCategory } = await getActivitySummary(userId, displayCurrency, range)
  return byCategory
}

export interface CashFlowPoint extends ActivityRange {
  /** `yyyy-MM` in the user's timezone. */
  month: string
  income: Prisma.Decimal
  expense: Prisma.Decimal
  netIncome: Prisma.Decimal
}

/**
 * The last `monthsBack` calendar months ending with the one containing `now`,
 * oldest first, with empty months present as zeros so the chart's x-axis has no
 * gaps.
 *
 * The windows are the user's *local* months, built by the shared
 * `getRecentMonthWindows` — the same helper the balance-over-time chart samples
 * at, so the dashboard's two trend charts cannot disagree about which months
 * they are showing or where a month begins.
 *
 * Cost is one query, not one per month: the whole span `[first.startUtc,
 * last.endUtc)` is fetched once and each row is dropped into its local month
 * with `formatInTimeZone`, which by construction agrees with the window
 * boundaries because those windows are exactly the local calendar months.
 */
export async function getCashFlowTrend(
  userId: string,
  timezone: string,
  displayCurrency: Currency,
  monthsBack = 6,
  now: Date = new Date(),
): Promise<CashFlowPoint[]> {
  const windows = getRecentMonthWindows(timezone, monthsBack, now)
  if (windows.length === 0) return []

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      type: { in: [...ACTIVITY_TYPES] },
      date: { gte: windows[0].startUtc, lt: windows[windows.length - 1].endUtc },
    },
    select: { amount: true, currency: true, vndPerUsdAtEntry: true, type: true, date: true },
  })

  const points = new Map<string, CashFlowPoint>(
    windows.map((window) => [
      window.month,
      {
        month: window.month,
        startUtc: window.startUtc,
        endUtc: window.endUtc,
        income: new Prisma.Decimal(0),
        expense: new Prisma.Decimal(0),
        netIncome: new Prisma.Decimal(0),
      },
    ]),
  )

  for (const row of rows) {
    const month = formatInTimeZone(row.date, timezone, 'yyyy-MM')
    const point = points.get(month)
    // Unreachable: the query span is exactly `[first.startUtc, last.endUtc)`
    // and the windows are the local calendar months tiling that span, so every
    // fetched row lands in one of them. Throwing rather than skipping is
    // deliberate (mirroring the loud unreachable branch in `position.ts`): a
    // row that fell out of every bucket means the query span and the windows
    // have drifted apart, and silently dropping it would quietly understate a
    // month's totals — money going missing from a chart with no error anywhere.
    if (!point) {
      throw new Error(
        `getCashFlowTrend: transaction dated ${row.date.toISOString()} fell in local month ${month}, which is outside every requested window`,
      )
    }
    const amount = historicalAmountIn(displayCurrency, row)
    if (row.type === 'INCOME') point.income = point.income.add(amount)
    else point.expense = point.expense.add(amount)
  }

  for (const point of points.values()) {
    point.netIncome = point.income.sub(point.expense)
  }

  // Map iteration order is insertion order, which is oldest → newest.
  return [...points.values()]
}
