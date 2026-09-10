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
 * Where the money currently sits, one bar per active account.
 *
 * Every bar is a `displayBalance` — the account's balance restated in the
 * display currency by `getCurrentPosition`. Charting native balances would put
 * a 400 USD account beside a 10,000,000 VND one and imply the second is
 * twenty-five thousand times the first, when they are roughly equal.
 *
 * `summary` and `seriesLabel` arrive already translated from the page (fix
 * round 1, finding 2) — see `CashFlowTrendChart`'s doc comment for why.
 */
export function AccountDistributionChart({
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
  /* `<figure aria-label>`: a named but NON-leaf wrapper, so the summary is
     announced AND recharts' keyboard layer inside it still works. Full
     reasoning in `account-balance-history-chart.tsx`. */
  return (
    <figure aria-label={summary}>
      <ResponsiveContainer width="100%" height={height}>
        {/* `title={summary}` (Task 18, routed from the Task 16 re-review):
            recharts renders its root `<svg>` with `role="application"` and
            `tabIndex=0` when its accessibility layer is on (the default in
            v3 — `node_modules/recharts/lib/container/RootSurface.js`), and
            it always emits a `<title>` element inside that svg. With no
            `title` prop that element was EMPTY, so the one focusable node in
            the chart had no accessible name of its own — the `<figure>`'s
            `aria-label` names the figure, not the plot a keyboard user
            actually lands on. Same translated sentence, so the figure and
            the plot cannot disagree. `desc` is deliberately left unset: it
            would repeat that sentence as the plot's description and be read
            twice. */}
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          title={summary}
        >
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
          <Bar {...BAR_PROPS} dataKey="value" name={seriesLabel} fill={CHART_COLORS.distribution} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  )
}
