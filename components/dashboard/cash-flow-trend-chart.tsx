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
 *
 * `summary` and `seriesLabels` arrive already translated from the page (fix
 * round 1, finding 2): a client component has no `getTranslations`, and this
 * one already receives every other locale-sensitive value as a prop
 * (`locale` itself only reaches `formatCompactAmount`/`formatChartValue`), so
 * the aria-label sentence and the Legend/Tooltip series names follow the same
 * pattern rather than hard-coding English.
 */
export function CashFlowTrendChart({
  data,
  currency,
  locale,
  height,
  summary,
  seriesLabels,
}: {
  data: TrendPointDto[]
  currency: Currency
  locale: Locale
  height: number
  /** The chart's accessible name, fully translated and interpolated by the page. */
  summary: string
  /** Translated Legend/Tooltip series names. */
  seriesLabels: { income: string; expense: string; netIncome: string }
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
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} title={summary}>
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
          {/* `itemSorter={null}` (Task 18, Task 14 finding F11): `Legend`
              defaults to `itemSorter: 'value'`
              (`node_modules/recharts/lib/component/Legend.js`), i.e. it sorts
              its entries alphabetically by their rendered label — which put
              "Chi tiêu" before "Thu nhập" in Vietnamese and "Expense" before
              "Income" in English, contradicting the income-then-expense order
              this chart declares its series in and that every figure, KPI and
              tooltip in the product reads in. `null` means "do not sort", so
              the legend follows the `<Line>` order below and needs no `payload`
              of its own — nothing about the labels or the colours is restated
              here. */}
          <Legend iconType="plainline" itemSorter={null} wrapperStyle={{ fontSize: '0.7rem' }} />
          <Line
            {...LINE_PROPS}
            dataKey="income"
            name={seriesLabels.income}
            stroke={CHART_COLORS.income}
          />
          <Line
            {...LINE_PROPS}
            dataKey="expense"
            name={seriesLabels.expense}
            stroke={CHART_COLORS.expense}
          />
          <Line
            {...LINE_PROPS}
            dataKey="netIncome"
            name={seriesLabels.netIncome}
            stroke={CHART_COLORS.net}
          />
        </LineChart>
      </ResponsiveContainer>
    </figure>
  )
}
