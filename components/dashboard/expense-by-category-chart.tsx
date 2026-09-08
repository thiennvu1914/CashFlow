'use client'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Currency } from '@/lib/currency/provider'
import type { Locale } from '@/lib/i18n/locale'
import type { NamedAmountDto } from '@/lib/ui/dashboard-view-model'
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
 * This month's spending, largest category first — at most eight bars plus an
 * "Other" bucket (spec §6.1), already assembled by the view model
 * (`bucketExpenseCategories`); the page translates any `nameKey` before
 * handing rows here (`row.nameKey ? t(row.nameKey) : row.name`).
 *
 * Horizontal bars rather than a pie: category names are words, and words read
 * along a left-hand axis without a legend, a leader line or a colour key. The
 * service already ordered the rows (with an id tiebreak), so the chart draws
 * them in the order it was given.
 *
 * `summary` and `seriesLabel` arrive already translated from the page (fix
 * round 1, finding 2) — see `CashFlowTrendChart`'s doc comment for why.
 */
export function ExpenseByCategoryChart({
  data,
  currency,
  locale,
  height,
  summary,
  seriesLabel,
}: {
  data: NamedAmountDto[]
  currency: Currency
  locale: Locale
  height: number
  /** The chart's accessible name, fully translated and interpolated by the page. */
  summary: string
  /** Translated Tooltip series name (the bar has no Legend). */
  seriesLabel: string
}) {
  return (
    <div role="img" aria-label={summary}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
          {/* Wrapped rather than passed directly: Recharts calls a
              `tickFormatter` as `(value, index)`, and `formatCompactAmount`'s
              `locale` second parameter is a different type than Recharts'
              `index`, so passing the function itself does not type-check. */}
          <XAxis
            type="number"
            {...AXIS_PROPS}
            tickFormatter={(value) => formatCompactAmount(value, locale)}
          />
          <YAxis type="category" dataKey="name" {...AXIS_PROPS} width={104} />
          <Tooltip
            cursor={BAR_CURSOR}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value) => formatChartValue(value, currency, locale)}
          />
          <Bar {...BAR_PROPS} dataKey="value" name={seriesLabel} fill={CHART_COLORS.expense} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
