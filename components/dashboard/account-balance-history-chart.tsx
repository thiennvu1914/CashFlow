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
 *
 * `summary` and `seriesLabel` arrive already translated from the page (fix
 * round 1, finding 2) — see `CashFlowTrendChart`'s doc comment for why. The
 * gap count is already folded into `summary` by the page, since the exact
 * gap wording is a pluralised sentence and belongs with the translator.
 */
export function AccountBalanceHistoryChart({
  data,
  currency,
  locale,
  height,
  summary,
  seriesLabel,
}: {
  data: BalancePointDto[]
  currency: Currency
  locale: Locale
  height: number
  /** The chart's accessible name, fully translated and interpolated by the page. */
  summary: string
  /** Translated Tooltip series name (the line has no Legend). */
  seriesLabel: string
}) {
  /* A `<figure aria-label>` below, not a role="img" div (Task 16 fix round 1,
     controller ruling). Both hand a screen reader the same one sentence, but
     `role="img"` makes the subtree a LEAF: everything inside it is pruned from
     the accessibility tree. recharts' accessibility layer lives inside —
     `tabIndex={0}` and `role="application"` on the `<svg>`, arrow keys bound to
     the tooltip's active index, and a `role="status"` announcer for whatever
     that index lands on — so under `role="img"` the chart was a tab stop that
     announced nothing beside a live region that could never fire. Task 16 first
     turned the layer OFF, which made the tree honest and took the only keyboard
     path to the tooltip with it: a sighted keyboard user could no longer read a
     single data point, because hover is the only other way in.

     `<figure>` is `role="figure"`, which is NOT a leaf, so both can be true at
     once: the figure's `aria-label` is the summary a screen-reader user hears
     on entering, and the layer inside it works as recharts intends — Tab
     reaches the plot, ArrowRight/ArrowLeft walk the points, and the announcer
     reads each one out. `aria-label` rather than a visually-hidden
     `<figcaption>` because the page has already composed and translated that
     string and there is nothing to render; Tailwind's preflight zeroes
     `figure`'s default margin, so nothing moves. */
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
          <Line
            {...LINE_PROPS}
            dataKey="balance"
            name={seriesLabel}
            stroke={CHART_COLORS.balance}
            connectNulls={false}
            // A gap is only visible as a gap if its neighbours are drawn; with
            // `dot: false` a lone point between two nulls would render nothing
            // at all, so isolated points keep a dot.
            dot={{ r: 2, fill: CHART_COLORS.balance, strokeWidth: 0 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </figure>
  )
}
