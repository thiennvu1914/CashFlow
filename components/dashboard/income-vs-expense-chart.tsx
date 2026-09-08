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
 */
export function IncomeVsExpenseChart({
  data,
  currency,
  locale,
  height,
}: {
  data: ComparisonBarDto[]
  currency: Currency
  locale: Locale
  height: number
}) {
  return (
    <div
      role="img"
      aria-label={`Grouped bar chart comparing income and expense in ${currency} for ${data
        .map((row) => row.period)
        .join(' and ')}`}
    >
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
          <Bar {...BAR_PROPS} dataKey="income" name="Income" fill={CHART_COLORS.income} />
          <Bar {...BAR_PROPS} dataKey="expense" name="Expense" fill={CHART_COLORS.expense} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
