'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Currency } from '@/lib/currency/provider'
import type { Locale } from '@/lib/i18n/locale'
import type { BalancePointDto } from '@/lib/ui/dashboard-view-model'
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
 * The sum of every account's balance at each month's end.
 *
 * `connectNulls={false}` is the whole point of the widget's honesty: a month
 * whose historical rate is unknown has no balance, and the line breaks there.
 * Joining across the gap would draw a straight segment through a value nobody
 * ever measured. The page decides when NOTHING is known and shows its own
 * `EmptyState` instead of this component (spec §6.1: an empty balance history
 * is an empty state, never a flat zero line).
 */
export function AccountBalanceHistoryChart({
  data,
  currency,
  locale,
  height,
}: {
  data: BalancePointDto[]
  currency: Currency
  locale: Locale
  height: number
}) {
  const known = data.filter((point) => point.balance !== null)
  const gaps = data.length - known.length

  return (
    <div
      role="img"
      aria-label={`Line chart of total account balance in ${currency} at each month end${
        gaps > 0 ? `, with ${gaps} month(s) missing a historical rate shown as gaps` : ''
      }`}
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
          <Line
            {...LINE_PROPS}
            dataKey="balance"
            name="Account balance"
            stroke={CHART_COLORS.balance}
            connectNulls={false}
            // A gap is only visible as a gap if its neighbours are drawn; with
            // `dot: false` a lone point between two nulls would render nothing
            // at all, so isolated points keep a dot.
            dot={{ r: 2, fill: CHART_COLORS.balance, strokeWidth: 0 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
