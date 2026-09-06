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
import type { ComparisonBarDto } from '@/lib/ui/dashboard-view-model'
import { formatCompactAmount, formatMoney } from '@/lib/ui/format-money'
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
 * This month against last, side by side.
 *
 * A grouped bar chart rather than a second line chart on purpose: the question
 * is "which of these four bars is taller", and bars answer that at a glance in
 * a way two points on a line do not.
 */
export function IncomeVsExpenseChart({
  data,
  currency,
}: {
  data: ComparisonBarDto[]
  currency: Currency
}) {
  const hasActivity = data.some((row) => row.income !== 0 || row.expense !== 0)
  if (!hasActivity) {
    return <DashboardEmpty>No income or expenses in either month</DashboardEmpty>
  }

  return (
    <div
      role="img"
      aria-label={`Grouped bar chart comparing income and expense in ${currency} for ${data
        .map((row) => row.period)
        .join(' and ')}`}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="period" {...AXIS_PROPS} />
          <YAxis {...AXIS_PROPS} tickFormatter={formatCompactAmount} width={52} />
          <Tooltip
            cursor={BAR_CURSOR}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value) => `${formatMoney(Number(value), currency)} ${currency}`}
          />
          <Legend wrapperStyle={{ fontSize: '0.7rem' }} />
          <Bar {...BAR_PROPS} dataKey="income" name="Income" fill={CHART_COLORS.income} />
          <Bar {...BAR_PROPS} dataKey="expense" name="Expense" fill={CHART_COLORS.expense} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
