'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/common/skeleton'

/**
 * The five dashboard charts, split out of the page's first-load JavaScript.
 *
 * Every chart pulls in recharts, which was ~409 KB raw / ~116 KB gzip in the
 * dashboard's eager chunk set — most of what the page ships, for widgets that
 * sit below the KPI row. `next/dynamic` moves it into its own chunk, fetched
 * after hydration, so the KPIs, the planning widgets and the ledger become
 * interactive without waiting for it.
 *
 * `ssr: false` is allowed here (and only here) because this is a Client
 * Component. It costs nothing: `ResponsiveContainer` measures its parent in the
 * browser and renders no chart on the server anyway, so server HTML was already
 * an empty frame.
 *
 * No layout shift: the loading state is a grey block with `h-full` inside
 * `ChartContainer`'s body, which has the same explicit `height`
 * (`CHART_HEIGHT.*`) the real chart's `ResponsiveContainer` is given — the
 * placeholder and the chart occupy exactly the same box, and the card around
 * them never resizes. The block is a plain `div`, not a list, and sits in a
 * `section`, so it is valid wherever a chart is.
 */
function ChartSkeleton() {
  return <Skeleton className="h-full w-full" />
}

export const CashFlowTrendChart = dynamic(
  () => import('./cash-flow-trend-chart').then((m) => m.CashFlowTrendChart),
  { ssr: false, loading: ChartSkeleton },
)

export const ExpenseByCategoryChart = dynamic(
  () => import('./expense-by-category-chart').then((m) => m.ExpenseByCategoryChart),
  { ssr: false, loading: ChartSkeleton },
)

export const AccountBalanceHistoryChart = dynamic(
  () => import('./account-balance-history-chart').then((m) => m.AccountBalanceHistoryChart),
  { ssr: false, loading: ChartSkeleton },
)

export const IncomeVsExpenseChart = dynamic(
  () => import('./income-vs-expense-chart').then((m) => m.IncomeVsExpenseChart),
  { ssr: false, loading: ChartSkeleton },
)

export const AccountDistributionChart = dynamic(
  () => import('./account-distribution-chart').then((m) => m.AccountDistributionChart),
  { ssr: false, loading: ChartSkeleton },
)
