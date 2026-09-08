'use client'

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Currency } from '@/lib/currency/provider'
import type { Locale } from '@/lib/i18n/locale'
import type { TrendPointDto } from '@/lib/ui/dashboard-view-model'
import { formatChartValue, formatCompactAmount } from '@/lib/ui/format-money'
import {
  AXIS_PROPS,
  CHART_COLORS,
  LINE_CURSOR,
  LINE_PROPS,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from './chart-theme'

/**
 * Six months of income, expense and net income as a time series.
 *
 * Distinct from Income vs Expense next to it: that widget answers "is this
 * month better than last?", this one answers "which way has it been going?".
 *
 * Receives plain numbers — the page has already widened the `Decimal`s at the
 * DTO boundary — so nothing financial is computed on the client. The empty
 * state is the page's call now (Step 8): a chart with genuinely nothing to
 * plot never reaches this component.
 */
export function CashFlowTrendChart({
  data,
  currency,
  locale,
  height,
}: {
  data: TrendPointDto[]
  currency: Currency
  locale: Locale
  height: number
}) {
  const span = data.length > 0 ? `${data[0].label} to ${data[data.length - 1].label}` : ''

  return (
    <div
      role="img"
      aria-label={`Line chart of monthly income, expense and net income in ${currency}, ${span}`}
    >
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" {...AXIS_PROPS} />
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
            cursor={LINE_CURSOR}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value) => formatChartValue(value, currency, locale)}
          />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: '0.7rem' }} />
          <Line {...LINE_PROPS} dataKey="income" name="Income" stroke={CHART_COLORS.income} />
          <Line {...LINE_PROPS} dataKey="expense" name="Expense" stroke={CHART_COLORS.expense} />
          <Line {...LINE_PROPS} dataKey="netIncome" name="Net Income" stroke={CHART_COLORS.net} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
