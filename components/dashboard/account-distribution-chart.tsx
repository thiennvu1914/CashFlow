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
 * Where the money currently sits, one bar per active account.
 *
 * Every bar is a `displayBalance` — the account's balance restated in the
 * display currency by `getCurrentPosition`. Charting native balances would put
 * a 400 USD account beside a 10,000,000 VND one and imply the second is
 * twenty-five thousand times the first, when they are roughly equal.
 */
export function AccountDistributionChart({
  data,
  currency,
}: {
  data: NamedAmountDto[]
  currency: Currency
}) {
  if (data.length === 0) return <DashboardEmpty>No active accounts yet</DashboardEmpty>

  return (
    <div
      role="img"
      aria-label={`Horizontal bar chart of the balance of each of ${data.length} active accounts, in ${currency}`}
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
          <XAxis
            type="number"
            {...AXIS_PROPS}
            tickFormatter={(value) => formatCompactAmount(value)}
          />
          <YAxis type="category" dataKey="name" {...AXIS_PROPS} width={104} />
          <Tooltip
            cursor={BAR_CURSOR}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value) => formatChartValue(value, currency)}
          />
          <Bar {...BAR_PROPS} dataKey="value" name="Balance" fill={CHART_COLORS.distribution} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
