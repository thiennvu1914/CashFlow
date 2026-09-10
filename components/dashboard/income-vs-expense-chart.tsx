'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Currency } from '@/lib/currency/provider'
import type { Locale } from '@/lib/i18n/locale'
import type { ComparisonBarDto } from '@/lib/ui/dashboard-view-model'
import { formatChartValue, formatCompactAmount } from '@/lib/ui/format-money'
import {
  AXIS_PROPS,
  BAR_CURSOR,
  BAR_PROPS,
  CHART_COLORS,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from './chart-theme'

/**
 * This month against last, side by side.
 *
 * A grouped bar chart rather than a second line chart on purpose: the question
 * is "which of these four bars is taller", and bars answer that at a glance in
 * a way two points on a line do not.
 *
 * `summary` and `seriesLabels` arrive already translated from the page (fix
 * round 1, finding 2) — see `CashFlowTrendChart`'s doc comment for why.
 */
export function IncomeVsExpenseChart({
  data,
  currency,
  locale,
  height,
  summary,
  seriesLabels,
}: {
  data: ComparisonBarDto[]
  currency: Currency
  locale: Locale
  height: number
  /** The chart's accessible name, fully translated and interpolated by the page. */
  summary: string
  /** Translated Legend/Tooltip series names. */
  seriesLabels: { income: string; expense: string }
}) {
  /* `<figure aria-label>`: a named but NON-leaf wrapper, so the summary is
     announced AND recharts' keyboard layer inside it still works. Full
     reasoning in `account-balance-history-chart.tsx`. */
  return (
    <figure aria-label={summary}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="period" {...AXIS_PROPS} />
          {/* Wrapped rather than passed directly: Recharts calls a
              `tickFormatter` as `(value, index)`, and `formatCompactAmount`'s
              `locale` second parameter is a different type than Recharts'
              `index`, so passing the function itself does not type-check. */}
          <YAxis
            {...AXIS_PROPS}
            tickFormatter={(value) => formatCompactAmount(value, locale)}
            width={52}
          />
          <Tooltip
            cursor={BAR_CURSOR}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value) => formatChartValue(value, currency, locale)}
          />
          <Legend wrapperStyle={{ fontSize: '0.7rem' }} />
          <Bar
            {...BAR_PROPS}
            dataKey="income"
            name={seriesLabels.income}
            fill={CHART_COLORS.income}
          />
          <Bar
            {...BAR_PROPS}
            dataKey="expense"
            name={seriesLabels.expense}
            fill={CHART_COLORS.expense}
          />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  )
}
