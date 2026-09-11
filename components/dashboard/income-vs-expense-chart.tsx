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
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} title={summary}>
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
          {/* `itemSorter={null}`: see the same note in
              `cash-flow-trend-chart.tsx` — recharts sorts legend entries by
              label unless told not to, and income is declared first here. */}
          <Legend itemSorter={null} wrapperStyle={{ fontSize: '0.7rem' }} />
          <Bar
            {...BAR_PROPS}
            maxBarSize={32}
            radius={[6, 6, 0, 0]}
            dataKey="income"
            name={seriesLabels.income}
            fill={CHART_COLORS.income}
          />
          <Bar
            {...BAR_PROPS}
            maxBarSize={32}
            radius={[6, 6, 0, 0]}
            dataKey="expense"
            name={seriesLabels.expense}
            fill={CHART_COLORS.expense}
          />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  )
}
