'use client'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Currency } from '@/lib/currency/provider'
import type { NamedAmountDto } from '@/lib/ui/dashboard-view-model'
import { formatChartValue, formatCompactAmount } from '@/lib/ui/format-money'
import {
  AXIS_PROPS,
  BAR_CURSOR,
  BAR_PROPS,
  CHART_COLORS,
  CHART_HEIGHT,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from './chart-theme'
import { DashboardEmpty } from './dashboard-section'

/**
 * This month's spending, largest category first.
 *
 * Horizontal bars rather than a pie: category names are words, and words read
 * along a left-hand axis without a legend, a leader line or a colour key. The
 * service already ordered the rows (with an id tiebreak), so the chart draws
 * them in the order it was given.
 */
export function ExpenseByCategoryChart({
  data,
  currency,
}: {
  data: NamedAmountDto[]
  currency: Currency
}) {
  if (data.length === 0) return <DashboardEmpty>No expenses this month</DashboardEmpty>

  return (
    <div
      role="img"
      aria-label={`Horizontal bar chart of this month's expenses by category in ${currency}, ${data.length} categories, largest first`}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
          {/* Wrapped rather than passed directly: Recharts calls a
              `tickFormatter` as `(value, index)`, and `formatCompactAmount`'s
              new optional `locale` second parameter is a different type than
              Recharts' `index`, so passing the function itself no longer
              type-checks. The wrapper drops `index` and keeps this chart's
              behaviour (the `vi` default) unchanged. */}
          <XAxis type="number" {...AXIS_PROPS} tickFormatter={(value) => formatCompactAmount(value)} />
          <YAxis type="category" dataKey="name" {...AXIS_PROPS} width={104} />
          <Tooltip
            cursor={BAR_CURSOR}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value) => formatChartValue(value, currency)}
          />
          <Bar {...BAR_PROPS} dataKey="value" name="Spent" fill={CHART_COLORS.expense} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
